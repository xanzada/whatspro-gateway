'use strict';

/**
 * Restaurant lifecycle orchestration.
 *
 * This is the single place where a restaurant is created, duplicated, enabled,
 * disabled or destroyed. The HTTP layer only translates requests into calls on
 * this service, and the operator never supplies an instance id, a token or a
 * secret: everything below the visible fields is generated here.
 *
 * Provisioning is journalled step by step so the UI can render a deployment
 * wizard, and any failure rolls back every earlier step. A half-created
 * restaurant must never survive a failed provision.
 *
 * All external systems arrive through the dependency object, which keeps this
 * file testable without NocoDB, Redis or WhatsApp.
 */

const {
	allocateInstanceId,
	isValidDomain,
	isValidInstanceId,
	isValidPhone,
	isValidWorkHours,
	normalizeDomain,
	normalizeWorkHours,
	provisioningError,
	purgeTenantRedis,
	releaseInstanceId
} = require('./tenantProvisioning');

const INSTANCE_STORE_KEY = 'whatspro:instances';
const SCAN_REQUESTS_KEY = 'whatspro:scan-requests';

const STEP_NAMES = [
	'validate',
	'allocate_id',
	'generate_secrets',
	'create_record',
	'verify_record',
	'prepare_redis',
	'start_instance',
	'prepare_qr'
];

const QR_WAIT_TIMEOUT_MS = 20000;
const QR_POLL_INTERVAL_MS = 750;
const LOCK_TTL_SECONDS = 180;
const TERMINAL_QR_STATUSES = new Set(['qr_ready', 'connected']);

const MAX_BRAND_LENGTH = 120;
const MAX_ADDRESS_LENGTH = 500;
const MAX_PROMPT_LENGTH = 20000;

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function asText(value) {
	if (value === null || value === undefined) return '';
	return String(value);
}

function cleanLine(value, max) {
	const text = asText(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
	return max && text.length > max ? text.slice(0, max) : text;
}

// ------------------------------------------------------------------ validation

/**
 * Collect every problem with the operator's input at once, so the form can
 * highlight all bad fields instead of one per round trip.
 */
function invalidFields(input) {
	const raw = input || {};
	const errors = [];

	const brand = cleanLine(raw.brand);
	if (!brand) errors.push({ field: 'brand', message: 'Restaurant name is required' });
	else if (brand.length > MAX_BRAND_LENGTH) errors.push({ field: 'brand', message: 'Restaurant name is too long' });

	const phone = asText(raw.whatsappPhone).trim();
	if (phone && !isValidPhone(phone)) errors.push({ field: 'whatsappPhone', message: 'WhatsApp number is not a valid phone number' });

	const workHours = asText(raw.workHours).trim();
	if (workHours && !isValidWorkHours(workHours)) errors.push({ field: 'workHours', message: 'Working hours must look like 09:00 - 03:00' });

	const domain = asText(raw.domain).trim();
	if (domain && !isValidDomain(domain)) errors.push({ field: 'domain', message: 'Domain is not a valid hostname' });

	if (asText(raw.address).length > MAX_ADDRESS_LENGTH) errors.push({ field: 'address', message: 'Address is too long' });
	if (asText(raw.systemPrompt).length > MAX_PROMPT_LENGTH) errors.push({ field: 'systemPrompt', message: 'System prompt is too long' });

	return errors;
}

/**
 * Validate and normalise operator input.
 * Throws a coded VALIDATION_FAILED error carrying every bad field.
 */
function validateInput(input) {
	const errors = invalidFields(input);
	if (errors.length) {
		throw provisioningError('VALIDATION_FAILED', 'Some fields need attention', { fields: errors, status: 400 });
	}

	const raw = input || {};
	return {
		brand: cleanLine(raw.brand, MAX_BRAND_LENGTH),
		whatsappPhone: asText(raw.whatsappPhone).trim(),
		workHours: normalizeWorkHours(raw.workHours),
		domain: normalizeDomain(raw.domain),
		address: cleanLine(raw.address, MAX_ADDRESS_LENGTH),
		systemPrompt: asText(raw.systemPrompt).trim().slice(0, MAX_PROMPT_LENGTH),
		active: raw.active === undefined ? true : Boolean(raw.active)
	};
}

// --------------------------------------------------------------------- journal

/**
 * Records the outcome of each provisioning step and streams it to the caller.
 * The returned steps array is what the UI renders as the deployment wizard.
 */
function createJournal(onStep) {
	const steps = [];
	const emit = typeof onStep === 'function' ? onStep : () => {};

	function push(step, status, detail) {
		const entry = { step: step, status: status };
		if (detail !== undefined && detail !== null && detail !== '') entry.detail = detail;
		steps.push(entry);
		try {
			emit(entry);
		} catch (err) {
			// A broken listener must never abort a provision.
		}
		return entry;
	}

	return {
		steps: steps,
		start: (step, detail) => push(step, 'running', detail),
		ok: (step, detail) => push(step, 'ok', detail),
		failed: (step, detail) => push(step, 'failed', detail),
		partial: (step, detail) => push(step, 'partial', detail)
	};
}

// --------------------------------------------------------------------- service

/**
 * @param {object} deps
 * @param {object}   deps.tenantAdmin      NocoDB record layer
 * @param {Function} deps.publicBase       () => string, MUST be a function
 * @param {object}  [deps.redis]           redis client, or a function returning one
 * @param {object}  [deps.whatsapp]        { start, stop, status }
 * @param {Function}[deps.invalidateTenant]
 * @param {object}  [deps.logger]
 * @param {number}  [deps.qrTimeoutMs]
 * @param {number}  [deps.qrPollMs]
 */
function createRestaurantService(deps) {
	const config = deps || {};
	const tenantAdmin = config.tenantAdmin;
	if (!tenantAdmin) throw new Error('createRestaurantService requires a tenantAdmin dependency');

	const whatsapp = config.whatsapp || {};
	const logger = config.logger || console;
	const qrTimeoutMs = Number(config.qrTimeoutMs) > 0 ? Number(config.qrTimeoutMs) : QR_WAIT_TIMEOUT_MS;
	const qrPollMs = Number(config.qrPollMs) > 0 ? Number(config.qrPollMs) : QR_POLL_INTERVAL_MS;

	// publicBase must be a function: the request-derived base is not known at wiring time.
	const publicBase = typeof config.publicBase === 'function' ? config.publicBase : () => '';

	function redis() {
		const client = typeof config.redis === 'function' ? config.redis() : config.redis;
		return client || null;
	}

	async function invalidate(instanceId) {
		if (typeof config.invalidateTenant !== 'function') return;
		try {
			await config.invalidateTenant(instanceId);
		} catch (err) {
			logger.warn('[RESTAURANT] cache invalidation failed for ' + instanceId + ': ' + err.message);
		}
	}

	/** Add the instance to the set the gateway iterates on boot. */
	async function registerInstance(instanceId) {
		const client = redis();
		if (!client || typeof client.sAdd !== 'function') return false;
		await client.sAdd(INSTANCE_STORE_KEY, instanceId);
		return true;
	}

	async function unregisterInstance(instanceId) {
		const client = redis();
		if (!client || typeof client.sRem !== 'function') return false;
		await client.sRem(INSTANCE_STORE_KEY, instanceId);
		return true;
	}

	/** Drop any pending QR scan requests so a deleted tenant leaves no ghosts. */
	async function removeScanRequests(instanceId) {
		const client = redis();
		if (!client || typeof client.hDel !== 'function') return 0;
		try {
			const removed = await client.hDel(SCAN_REQUESTS_KEY, instanceId);
			return Number(removed) || 0;
		} catch (err) {
			logger.warn('[RESTAURANT] could not clear scan requests for ' + instanceId + ': ' + err.message);
			return 0;
		}
	}

	async function startInstance(instanceId) {
		if (typeof whatsapp.start !== 'function') return false;
		await whatsapp.start(instanceId);
		return true;
	}

	async function stopInstance(instanceId) {
		if (typeof whatsapp.stop !== 'function') return false;
		await whatsapp.stop(instanceId);
		return true;
	}

	async function instanceStatus(instanceId) {
		if (typeof whatsapp.status !== 'function') return { status: 'not_running', qr: null };
		const state = await whatsapp.status(instanceId);
		return state || { status: 'not_running', qr: null };
	}

	/**
	 * Poll until the instance offers a QR code or reports itself connected.
	 * A timeout is not an error: the dashboard can keep polling afterwards.
	 */
	async function waitForQr(instanceId) {
		const deadline = Date.now() + qrTimeoutMs;
		let last = { status: 'starting', qr: null };
		while (Date.now() < deadline) {
			last = await instanceStatus(instanceId);
			if (TERMINAL_QR_STATUSES.has(last.status)) return { ready: true, status: last.status };
			await delay(qrPollMs);
		}
		return { ready: false, status: last.status };
	}

	/**
	 * Create a restaurant end to end.
	 *
	 * @param {object} input operator-visible fields only
	 * @param {object} [options]
	 * @param {Function} [options.onStep]      receives every journal entry
	 * @param {object}   [options.cloneFrom]   source tenant when duplicating
	 * @param {string}   [options.sharedPrompt] fallback prompt
	 * @returns {Promise<{instanceId:string, steps:object[], tenant:object}>}
	 */
	async function provision(input, options) {
		const opts = options || {};
		const journal = createJournal(opts.onStep);

		// Rollback actions are pushed as they become necessary and unwound in reverse.
		const undo = [];
		let instanceId = '';
		let currentStep = 'validate';

		try {
			journal.start('validate');
			const fields = validateInput(input);
			journal.ok('validate');

			currentStep = 'allocate_id';
			journal.start('allocate_id');
			const allocation = await allocateInstanceId(fields.brand, {
				exists: async (candidate) => Boolean(await tenantAdmin.findRow(candidate)),
				redis: redis(),
				ttlSeconds: LOCK_TTL_SECONDS
			});
			instanceId = allocation.instanceId;
			undo.push(async () => releaseInstanceId(redis(), instanceId));
			journal.ok('allocate_id', instanceId);

			currentStep = 'generate_secrets';
			journal.start('generate_secrets');
			const platform = tenantAdmin.platformFields(publicBase());
			journal.ok('generate_secrets');

			currentStep = 'create_record';
			journal.start('create_record');
			const prompt = asText(fields.systemPrompt) ||
				asText(opts.cloneFrom && opts.cloneFrom.systemPrompt) ||
				asText(opts.sharedPrompt);
			await tenantAdmin.createTenant(
				{
					instanceId: instanceId,
					brand: fields.brand,
					whatsappPhone: fields.whatsappPhone,
					workHours: fields.workHours,
					domain: fields.domain,
					address: fields.address,
					systemPrompt: prompt,
					active: fields.active
				},
				{ platform: platform, publicBase: publicBase() }
			);
			undo.push(async () => tenantAdmin.deleteTenant(instanceId));
			journal.ok('create_record');

			currentStep = 'verify_record';
			journal.start('verify_record');
			const row = await tenantAdmin.findRow(instanceId);
			if (!row) {
				throw provisioningError('RECORD_NOT_PERSISTED', 'The restaurant record was not stored', { status: 502 });
			}
			journal.ok('verify_record');

			currentStep = 'prepare_redis';
			journal.start('prepare_redis');
			await registerInstance(instanceId);
			undo.push(async () => {
				await unregisterInstance(instanceId);
				await purgeTenantRedis(redis(), instanceId);
			});
			await invalidate(instanceId);
			journal.ok('prepare_redis');

			currentStep = 'start_instance';
			journal.start('start_instance');
			if (fields.active) {
				await startInstance(instanceId);
				undo.push(async () => stopInstance(instanceId));
				journal.ok('start_instance');
			} else {
				journal.ok('start_instance', 'skipped, restaurant created as disabled');
			}

			currentStep = 'prepare_qr';
			journal.start('prepare_qr');
			if (!fields.active) {
				journal.ok('prepare_qr', 'skipped, restaurant created as disabled');
			} else {
				const qr = await waitForQr(instanceId);
				// A slow QR is not a provisioning failure; the record is already good.
				if (qr.ready) journal.ok('prepare_qr', qr.status);
				else journal.partial('prepare_qr', 'QR is not ready yet, status ' + qr.status);
			}

			// The id lock is no longer needed once the record exists.
			await releaseInstanceId(redis(), instanceId);

			return {
				instanceId: instanceId,
				steps: journal.steps,
				tenant: tenantAdmin.presentableTenant(await tenantAdmin.findRow(instanceId))
			};
		} catch (err) {
			journal.failed(currentStep, err.message);

			const rollback = [];
			for (let i = undo.length - 1; i >= 0; i--) {
				try {
					await undo[i]();
					rollback.push({ index: i, ok: true });
				} catch (rollbackErr) {
					rollback.push({ index: i, ok: false, error: rollbackErr.message });
					logger.error('[RESTAURANT] rollback step failed for ' + (instanceId || '(unallocated)') + ': ' + rollbackErr.message);
				}
			}
			const clean = rollback.every((entry) => entry.ok);
			journal.failed('rollback', clean ? 'everything was rolled back' : 'rollback was incomplete, manual review needed');

			err.step = currentStep;
			err.steps = journal.steps;
			err.rollback = { clean: clean, actions: rollback };
			if (instanceId) err.instanceId = instanceId;
			throw err;
		}
	}

	/**
	 * Copy the descriptive parts of an existing restaurant into a new one.
	 * Identity, secrets, domain and session state are never carried over, and the
	 * copy is always created disabled so it cannot start messaging by accident.
	 */
	async function duplicate(sourceInstanceId, input, options) {
		if (!isValidInstanceId(sourceInstanceId)) {
			throw provisioningError('BAD_INSTANCE_ID', 'That instance id is not valid', { status: 400 });
		}
		const row = await tenantAdmin.findRow(sourceInstanceId);
		if (!row) {
			throw provisioningError('TENANT_NOT_FOUND', 'No restaurant with that instance id', { status: 404 });
		}

		const source = tenantAdmin.presentableTenant(row);
		const raw = input || {};
		const merged = {
			brand: asText(raw.brand).trim() || source.brand + ' copy',
			workHours: raw.workHours === undefined ? source.workHours : raw.workHours,
			address: raw.address === undefined ? source.address : raw.address,
			systemPrompt: raw.systemPrompt === undefined ? source.systemPrompt : raw.systemPrompt,
			whatsappPhone: asText(raw.whatsappPhone).trim(),
			domain: asText(raw.domain).trim(),
			active: false
		};

		return provision(merged, Object.assign({}, options, { cloneFrom: source }));
	}

	/**
	 * Remove every trace of a restaurant.
	 * The NocoDB record is deleted last, so a failure part way through still
	 * leaves the restaurant visible in the dashboard and retryable.
	 */
	async function destroy(instanceId, options) {
		if (!isValidInstanceId(instanceId)) {
			throw provisioningError('BAD_INSTANCE_ID', 'That instance id is not valid', { status: 400 });
		}
		const opts = options || {};
		const row = await tenantAdmin.findRow(instanceId);
		if (!row && !opts.force) {
			throw provisioningError('TENANT_NOT_FOUND', 'No restaurant with that instance id', { status: 404 });
		}

		let stopped = false;
		try {
			stopped = await stopInstance(instanceId);
		} catch (err) {
			// An instance that will not stop must not block the delete.
			logger.warn('[RESTAURANT] could not stop ' + instanceId + ' during delete: ' + err.message);
		}

		await unregisterInstance(instanceId);
		const scanRequests = await removeScanRequests(instanceId);
		const purge = await purgeTenantRedis(redis(), instanceId);
		await invalidate(instanceId);

		let recordDeleted = false;
		if (row) {
			await tenantAdmin.deleteTenant(instanceId);
			recordDeleted = true;
		}

		return {
			instanceId: instanceId,
			stopped: stopped,
			redisKeys: purge.deleted,
			scanRequests: scanRequests,
			recordDeleted: recordDeleted
		};
	}

	/**
	 * Enable or disable a restaurant, keeping the WhatsApp instance in step with
	 * the stored flag.
	 */
	async function setActive(instanceId, active) {
		if (!isValidInstanceId(instanceId)) {
			throw provisioningError('BAD_INSTANCE_ID', 'That instance id is not valid', { status: 400 });
		}
		const row = await tenantAdmin.findRow(instanceId);
		if (!row) {
			throw provisioningError('TENANT_NOT_FOUND', 'No restaurant with that instance id', { status: 404 });
		}

		const enabled = Boolean(active);
		const result = await tenantAdmin.setActive(instanceId, enabled);
		await invalidate(instanceId);

		try {
			if (enabled) {
				await registerInstance(instanceId);
				await startInstance(instanceId);
			} else {
				await stopInstance(instanceId);
			}
		} catch (err) {
			// The stored flag is the source of truth; the runtime can be retried.
			logger.warn('[RESTAURANT] runtime toggle failed for ' + instanceId + ': ' + err.message);
		}

		return Object.assign({}, result, { active: enabled });
	}

	return {
		STEP_NAMES: STEP_NAMES,
		destroy: destroy,
		duplicate: duplicate,
		instanceStatus: instanceStatus,
		provision: provision,
		setActive: setActive,
		validateInput: validateInput,
		__internal: {
			createJournal: createJournal,
			invalidFields: invalidFields,
			registerInstance: registerInstance,
			removeScanRequests: removeScanRequests,
			unregisterInstance: unregisterInstance,
			waitForQr: waitForQr
		}
	};
}

module.exports = {
	INSTANCE_STORE_KEY: INSTANCE_STORE_KEY,
	SCAN_REQUESTS_KEY: SCAN_REQUESTS_KEY,
	STEP_NAMES: STEP_NAMES,
	createRestaurantService: createRestaurantService,
	validateInput: validateInput
};
