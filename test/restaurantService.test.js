'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	INSTANCE_STORE_KEY,
	SCAN_REQUESTS_KEY,
	STEP_NAMES,
	createRestaurantService,
	validateInput
} = require('../services/restaurantService');

// --------------------------------------------------------------------- doubles

/** In-memory stand-in for the NocoDB record layer. */
function fakeTenantAdmin(seed) {
	const rows = new Map();
	for (const row of seed || []) rows.set(row.instance_id, row);

	return {
		rows: rows,
		calls: [],
		failOn: null,
		async findRow(instanceId) {
			return rows.get(instanceId) || null;
		},
		platformFields(base) {
			this.calls.push('platformFields:' + base);
			return { whatspro_api_token: 'wp_test', webhook_secret: 'hook_test', whatspro_base_url: base };
		},
		async createTenant(input, options) {
			this.calls.push('createTenant:' + input.instanceId);
			if (this.failOn === 'createTenant') throw new Error('nocodb write refused');
			rows.set(input.instanceId, {
				instance_id: input.instanceId,
				brand: input.brand,
				whatsapp_phone: input.whatsappPhone,
				work_hours: input.workHours,
				domain: input.domain,
				address: input.address,
				system_prompt: input.systemPrompt,
				active: input.active,
				platform: (options || {}).platform
			});
			return { instanceId: input.instanceId };
		},
		async deleteTenant(instanceId) {
			this.calls.push('deleteTenant:' + instanceId);
			if (this.failOn === 'deleteTenant') throw new Error('delete refused');
			rows.delete(instanceId);
			return { instanceId: instanceId, deleted: true };
		},
		async setActive(instanceId, active) {
			this.calls.push('setActive:' + instanceId + ':' + active);
			const row = rows.get(instanceId);
			if (row) row.active = active;
			return { instanceId: instanceId, updated: true };
		},
		presentableTenant(row) {
			if (!row) return null;
			return {
				instanceId: row.instance_id,
				brand: row.brand,
				whatsappPhone: row.whatsapp_phone,
				workHours: row.work_hours,
				domain: row.domain,
				address: row.address,
				systemPrompt: row.system_prompt,
				active: row.active,
				secrets: { apiToken: true, webhookSecret: true, kanbanSecret: true }
			};
		}
	};
}

function fakeRedis(initialKeys) {
	const store = new Map();
	const sets = new Map();
	const hashes = new Map();
	for (const key of initialKeys || []) store.set(key, '1');

	return {
		store: store,
		sets: sets,
		hashes: hashes,
		async set(key, value, options) {
			if (options && options.NX && store.has(key)) return null;
			store.set(key, value);
			return 'OK';
		},
		async del(key) {
			const keys = Array.isArray(key) ? key : [key];
			let removed = 0;
			for (const k of keys) if (store.delete(k)) removed++;
			return removed;
		},
		async scan(cursor, options) {
			const match = (options && options.MATCH) || '*';
			const rx = new RegExp('^' + match.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
			return { cursor: 0, keys: Array.from(store.keys()).filter((k) => rx.test(k)) };
		},
		async sAdd(key, member) {
			if (!sets.has(key)) sets.set(key, new Set());
			sets.get(key).add(member);
			return 1;
		},
		async sRem(key, member) {
			const set = sets.get(key);
			return set && set.delete(member) ? 1 : 0;
		},
		async hDel(key, field) {
			const hash = hashes.get(key);
			return hash && hash.delete(field) ? 1 : 0;
		}
	};
}

function fakeWhatsapp(statusSequence) {
	const queue = Array.isArray(statusSequence) ? statusSequence.slice() : null;
	return {
		started: [],
		stopped: [],
		failStart: false,
		async start(instanceId) {
			if (this.failStart) throw new Error('chromium would not launch');
			this.started.push(instanceId);
		},
		async stop(instanceId) {
			this.stopped.push(instanceId);
		},
		async status() {
			if (!queue) return { status: 'qr_ready', qr: 'data:image/png;base64,AAA' };
			return queue.length > 1 ? queue.shift() : queue[0];
		}
	};
}

const quietLogger = { warn() {}, error() {}, log() {} };

function buildService(overrides) {
	const parts = Object.assign(
		{
			tenantAdmin: fakeTenantAdmin(),
			redis: fakeRedis(),
			whatsapp: fakeWhatsapp(),
			invalidated: []
		},
		overrides || {}
	);

	const service = createRestaurantService({
		tenantAdmin: parts.tenantAdmin,
		redis: parts.redis,
		whatsapp: parts.whatsapp,
		publicBase: () => 'https://whatspro.bekaba.com',
		invalidateTenant: async (id) => { parts.invalidated.push(id); },
		logger: quietLogger,
		qrTimeoutMs: 40,
		qrPollMs: 5
	});

	return Object.assign({ service: service }, parts);
}

const GOOD_INPUT = {
	brand: 'Crazy Sushi',
	whatsappPhone: '+7 700 344 95 05',
	workHours: '09:00 - 03:00',
	domain: 'crazy.bekaba.com',
	address: 'Almaty, Abay 1',
	systemPrompt: 'You are a sushi bot.'
};

// ------------------------------------------------------------------ contract

test('the module exports the documented surface', () => {
	assert.equal(INSTANCE_STORE_KEY, 'whatspro:instances');
	assert.equal(SCAN_REQUESTS_KEY, 'whatspro:scan-requests');
	assert.equal(typeof createRestaurantService, 'function');
	assert.equal(typeof validateInput, 'function');
});

test('STEP_NAMES lists the eight provisioning steps in order', () => {
	assert.deepEqual(STEP_NAMES, [
		'validate', 'allocate_id', 'generate_secrets', 'create_record',
		'verify_record', 'prepare_redis', 'start_instance', 'prepare_qr'
	]);
});

test('the factory requires a tenantAdmin dependency', () => {
	assert.throws(() => createRestaurantService({}), /tenantAdmin/);
});

test('the factory exposes the documented methods', () => {
	const { service } = buildService();
	for (const name of ['provision', 'duplicate', 'destroy', 'setActive', 'instanceStatus', 'validateInput']) {
		assert.equal(typeof service[name], 'function', name);
	}
});

// ---------------------------------------------------------------- validation

test('validateInput normalises every operator field', () => {
	const out = validateInput({
		brand: '  Crazy   Sushi  ',
		whatsappPhone: ' +7 700 344 95 05 ',
		workHours: '09:00-03:00',
		domain: 'https://Crazy.Bekaba.com/',
		address: '  Almaty,  Abay 1 ',
		systemPrompt: '  be nice  '
	});
	assert.equal(out.brand, 'Crazy Sushi');
	assert.equal(out.workHours, '09:00 - 03:00');
	assert.equal(out.domain, 'crazy.bekaba.com');
	assert.equal(out.address, 'Almaty, Abay 1');
	assert.equal(out.systemPrompt, 'be nice');
	assert.equal(out.active, true);
});

test('validateInput requires a restaurant name', () => {
	assert.throws(() => validateInput({ brand: '   ' }), (err) => {
		assert.equal(err.code, 'VALIDATION_FAILED');
		assert.equal(err.status, 400);
		assert.equal(err.fields[0].field, 'brand');
		return true;
	});
});

test('validateInput reports every bad field at once', () => {
	assert.throws(
		() => validateInput({ brand: '', whatsappPhone: '123', workHours: 'all day', domain: 'nope..com' }),
		(err) => {
			const fields = err.fields.map((f) => f.field);
			assert.deepEqual(fields.sort(), ['brand', 'domain', 'whatsappPhone', 'workHours']);
			return true;
		}
	);
});

test('validateInput treats phone, hours, domain and prompt as optional', () => {
	const out = validateInput({ brand: 'Solo' });
	assert.equal(out.whatsappPhone, '');
	assert.equal(out.workHours, '');
	assert.equal(out.domain, '');
	assert.equal(out.systemPrompt, '');
});

test('validateInput honours an explicit inactive flag', () => {
	assert.equal(validateInput({ brand: 'Solo', active: false }).active, false);
});

// --------------------------------------------------------------- provisioning

test('provision creates a restaurant and returns its generated id', async () => {
	const { service, tenantAdmin } = buildService();
	const result = await service.provision(GOOD_INPUT);

	assert.equal(result.instanceId, 'crazy-sushi');
	assert.equal(tenantAdmin.rows.has('crazy-sushi'), true);
	assert.equal(result.tenant.brand, 'Crazy Sushi');
});

test('provision never asks the operator for an instance id', async () => {
	const { service } = buildService();
	// An id supplied by the client is ignored entirely.
	const result = await service.provision(Object.assign({}, GOOD_INPUT, { instanceId: 'hacker-chosen' }));
	assert.equal(result.instanceId, 'crazy-sushi');
});

test('provision suffixes the id when the name is already taken', async () => {
	const { service, tenantAdmin } = buildService();
	await service.provision(GOOD_INPUT);
	const second = await service.provision(GOOD_INPUT);
	assert.equal(second.instanceId, 'crazy-sushi-2');
	assert.equal(tenantAdmin.rows.size, 2);
});

test('provision walks all eight steps in order', async () => {
	const { service } = buildService();
	const result = await service.provision(GOOD_INPUT);
	const completed = result.steps.filter((s) => s.status === 'ok' || s.status === 'partial').map((s) => s.step);
	assert.deepEqual(completed, STEP_NAMES);
});

test('provision streams each step to the onStep listener', async () => {
	const { service } = buildService();
	const seen = [];
	await service.provision(GOOD_INPUT, { onStep: (entry) => seen.push(entry.step + ':' + entry.status) });
	assert.equal(seen[0], 'validate:running');
	assert.equal(seen[1], 'validate:ok');
	assert.equal(seen.includes('allocate_id:ok'), true);
	assert.equal(seen[seen.length - 1], 'prepare_qr:ok');
});

test('provision generates the platform secrets from the public base', async () => {
	const { service, tenantAdmin } = buildService();
	await service.provision(GOOD_INPUT);
	assert.equal(tenantAdmin.calls.includes('platformFields:https://whatspro.bekaba.com'), true);
	assert.equal(tenantAdmin.rows.get('crazy-sushi').platform.whatspro_api_token, 'wp_test');
});

test('provision registers the instance in the gateway set', async () => {
	const { service, redis } = buildService();
	await service.provision(GOOD_INPUT);
	assert.equal(redis.sets.get(INSTANCE_STORE_KEY).has('crazy-sushi'), true);
});

test('provision starts the WhatsApp instance and invalidates the cache', async () => {
	const { service, whatsapp, invalidated } = buildService();
	await service.provision(GOOD_INPUT);
	assert.deepEqual(whatsapp.started, ['crazy-sushi']);
	assert.equal(invalidated.includes('crazy-sushi'), true);
});

test('provision releases the id lock once the record exists', async () => {
	const { service, redis } = buildService();
	await service.provision(GOOD_INPUT);
	assert.equal(redis.store.has('whatspro:idlock:crazy-sushi'), false);
});

test('provision skips start and QR when the restaurant is created disabled', async () => {
	const { service, whatsapp } = buildService();
	const result = await service.provision(Object.assign({}, GOOD_INPUT, { active: false }));
	assert.deepEqual(whatsapp.started, []);
	const qrStep = result.steps.find((s) => s.step === 'prepare_qr' && s.status === 'ok');
	assert.match(qrStep.detail, /disabled/);
});

test('provision reports a partial QR step instead of failing on a slow start', async () => {
	const { service, tenantAdmin } = buildService({ whatsapp: fakeWhatsapp([{ status: 'starting', qr: null }]) });
	const result = await service.provision(GOOD_INPUT);
	const qrStep = result.steps.find((s) => s.step === 'prepare_qr' && s.status !== 'running');
	assert.equal(qrStep.status, 'partial');
	// The restaurant itself is fine and must survive.
	assert.equal(tenantAdmin.rows.has('crazy-sushi'), true);
});

test('provision accepts a connected instance as a finished QR step', async () => {
	const { service } = buildService({ whatsapp: fakeWhatsapp([{ status: 'connected', qr: null }]) });
	const result = await service.provision(GOOD_INPUT);
	const qrStep = result.steps.find((s) => s.step === 'prepare_qr' && s.status === 'ok');
	assert.equal(qrStep.detail, 'connected');
});

test('provision falls back to the shared prompt when none is supplied', async () => {
	const { service, tenantAdmin } = buildService();
	await service.provision({ brand: 'Solo' }, { sharedPrompt: 'shared house prompt' });
	assert.equal(tenantAdmin.rows.get('solo').system_prompt, 'shared house prompt');
});

// ----------------------------------------------------------------- rollback

test('provision rolls back the id lock when the record cannot be written', async () => {
	const tenantAdmin = fakeTenantAdmin();
	tenantAdmin.failOn = 'createTenant';
	const { service, redis } = buildService({ tenantAdmin: tenantAdmin });

	await assert.rejects(() => service.provision(GOOD_INPUT), /nocodb write refused/);
	assert.equal(redis.store.has('whatspro:idlock:crazy-sushi'), false);
	assert.equal(tenantAdmin.rows.size, 0);
});

test('a failed provision leaves no partially created restaurant', async () => {
	const whatsapp = fakeWhatsapp();
	whatsapp.failStart = true;
	const { service, tenantAdmin, redis } = buildService({ whatsapp: whatsapp });

	await assert.rejects(() => service.provision(GOOD_INPUT), /chromium would not launch/);

	assert.equal(tenantAdmin.rows.size, 0, 'the NocoDB record must be gone');
	assert.equal(redis.sets.get(INSTANCE_STORE_KEY).has('crazy-sushi'), false, 'the instance must be unregistered');
	assert.equal(redis.store.has('whatspro:idlock:crazy-sushi'), false, 'the id must be released');
});

test('a failed provision annotates the error with the failing step', async () => {
	const whatsapp = fakeWhatsapp();
	whatsapp.failStart = true;
	const { service } = buildService({ whatsapp: whatsapp });

	await assert.rejects(() => service.provision(GOOD_INPUT), (err) => {
		assert.equal(err.step, 'start_instance');
		assert.equal(err.instanceId, 'crazy-sushi');
		assert.equal(err.rollback.clean, true);
		assert.equal(err.steps.some((s) => s.step === 'start_instance' && s.status === 'failed'), true);
		assert.equal(err.steps.some((s) => s.step === 'rollback'), true);
		return true;
	});
});

test('provision fails loudly when the record does not persist', async () => {
	const tenantAdmin = fakeTenantAdmin();
	const originalCreate = tenantAdmin.createTenant.bind(tenantAdmin);
	tenantAdmin.createTenant = async (input, options) => {
		await originalCreate(input, options);
		tenantAdmin.rows.delete(input.instanceId); // simulate a silent NocoDB drop
		return { instanceId: input.instanceId };
	};
	const { service } = buildService({ tenantAdmin: tenantAdmin });

	await assert.rejects(() => service.provision(GOOD_INPUT), (err) => {
		assert.equal(err.code, 'RECORD_NOT_PERSISTED');
		assert.equal(err.step, 'verify_record');
		return true;
	});
});

test('a rollback that itself fails is reported rather than hidden', async () => {
	const whatsapp = fakeWhatsapp();
	whatsapp.failStart = true;
	const tenantAdmin = fakeTenantAdmin();
	tenantAdmin.failOn = 'deleteTenant';
	const { service } = buildService({ tenantAdmin: tenantAdmin, whatsapp: whatsapp });

	await assert.rejects(() => service.provision(GOOD_INPUT), (err) => {
		assert.equal(err.rollback.clean, false);
		assert.equal(err.steps.some((s) => s.step === 'rollback' && /manual review/.test(s.detail || '')), true);
		return true;
	});
});

test('validation failures never reach NocoDB', async () => {
	const { service, tenantAdmin } = buildService();
	await assert.rejects(() => service.provision({ brand: '' }), (err) => {
		assert.equal(err.code, 'VALIDATION_FAILED');
		assert.equal(err.step, 'validate');
		return true;
	});
	assert.equal(tenantAdmin.calls.length, 0);
});

// ---------------------------------------------------------------- duplicate

test('duplicate copies the descriptive fields only', async () => {
	const { service, tenantAdmin } = buildService();
	await service.provision(GOOD_INPUT);

	const copy = await service.duplicate('crazy-sushi', {});
	const row = tenantAdmin.rows.get(copy.instanceId);

	assert.equal(row.brand, 'Crazy Sushi copy');
	assert.equal(row.work_hours, '09:00 - 03:00');
	assert.equal(row.address, 'Almaty, Abay 1');
	assert.equal(row.system_prompt, 'You are a sushi bot.');
	assert.equal(row.domain, '', 'the domain must not be copied');
	assert.equal(row.whatsapp_phone, '', 'the phone number must not be copied');
});

test('duplicate always creates the copy disabled', async () => {
	const { service, tenantAdmin, whatsapp } = buildService();
	await service.provision(GOOD_INPUT);
	const copy = await service.duplicate('crazy-sushi', {});
	assert.equal(tenantAdmin.rows.get(copy.instanceId).active, false);
	assert.deepEqual(whatsapp.started, ['crazy-sushi']);
});

test('duplicate gives the copy its own instance id', async () => {
	const { service } = buildService();
	await service.provision(GOOD_INPUT);
	const copy = await service.duplicate('crazy-sushi', { brand: 'Crazy Sushi' });
	assert.equal(copy.instanceId, 'crazy-sushi-2');
});

test('duplicate rejects an unknown or malformed source', async () => {
	const { service } = buildService();
	await assert.rejects(() => service.duplicate('nope', {}), (err) => {
		assert.equal(err.code, 'TENANT_NOT_FOUND');
		assert.equal(err.status, 404);
		return true;
	});
	await assert.rejects(() => service.duplicate('BAD ID', {}), (err) => {
		assert.equal(err.code, 'BAD_INSTANCE_ID');
		assert.equal(err.status, 400);
		return true;
	});
});

// ------------------------------------------------------------------ destroy

test('destroy removes the record, the runtime and the Redis keys', async () => {
	const { service, tenantAdmin, redis, whatsapp, invalidated } = buildService();
	await service.provision(GOOD_INPUT);
	redis.store.set('chatwoot:inbox:crazy-sushi', '1');
	redis.store.set('chatwoot:history:crazy-sushi:77001112233', '1');
	redis.store.set('chatwoot:inbox:other', '1');

	const report = await service.destroy('crazy-sushi');

	assert.equal(report.recordDeleted, true);
	assert.equal(report.stopped, true);
	assert.equal(report.redisKeys, 2);
	assert.equal(tenantAdmin.rows.has('crazy-sushi'), false);
	assert.equal(redis.sets.get(INSTANCE_STORE_KEY).has('crazy-sushi'), false);
	assert.equal(redis.store.has('chatwoot:inbox:other'), true, 'other tenants must be untouched');
	assert.equal(whatsapp.stopped.includes('crazy-sushi'), true);
	assert.equal(invalidated.includes('crazy-sushi'), true);
});

test('destroy deletes the NocoDB record last', async () => {
	const { service, tenantAdmin } = buildService();
	await service.provision(GOOD_INPUT);
	tenantAdmin.calls.length = 0;
	await service.destroy('crazy-sushi');
	assert.equal(tenantAdmin.calls[tenantAdmin.calls.length - 1], 'deleteTenant:crazy-sushi');
});

test('destroy still completes when the instance refuses to stop', async () => {
	const whatsapp = fakeWhatsapp();
	const { service, tenantAdmin } = buildService({ whatsapp: whatsapp });
	await service.provision(GOOD_INPUT);
	whatsapp.stop = async () => { throw new Error('already dead'); };

	const report = await service.destroy('crazy-sushi');
	assert.equal(report.recordDeleted, true);
	assert.equal(tenantAdmin.rows.has('crazy-sushi'), false);
});

test('destroy rejects an unknown or malformed instance id', async () => {
	const { service } = buildService();
	await assert.rejects(() => service.destroy('nope'), (err) => {
		assert.equal(err.code, 'TENANT_NOT_FOUND');
		return true;
	});
	await assert.rejects(() => service.destroy('BAD ID'), (err) => {
		assert.equal(err.code, 'BAD_INSTANCE_ID');
		return true;
	});
});

// ---------------------------------------------------------------- setActive

test('setActive disables a restaurant and stops its instance', async () => {
	const { service, tenantAdmin, whatsapp } = buildService();
	await service.provision(GOOD_INPUT);

	const result = await service.setActive('crazy-sushi', false);
	assert.equal(result.active, false);
	assert.equal(tenantAdmin.rows.get('crazy-sushi').active, false);
	assert.equal(whatsapp.stopped.includes('crazy-sushi'), true);
});

test('setActive re-enables a restaurant and starts its instance', async () => {
	const { service, whatsapp, redis } = buildService();
	await service.provision(Object.assign({}, GOOD_INPUT, { active: false }));

	const result = await service.setActive('crazy-sushi', true);
	assert.equal(result.active, true);
	assert.deepEqual(whatsapp.started, ['crazy-sushi']);
	assert.equal(redis.sets.get(INSTANCE_STORE_KEY).has('crazy-sushi'), true);
});

test('setActive keeps the stored flag even if the runtime toggle fails', async () => {
	const whatsapp = fakeWhatsapp();
	const { service, tenantAdmin } = buildService({ whatsapp: whatsapp });
	await service.provision(GOOD_INPUT);
	whatsapp.stop = async () => { throw new Error('stop exploded'); };

	const result = await service.setActive('crazy-sushi', false);
	assert.equal(result.active, false);
	assert.equal(tenantAdmin.rows.get('crazy-sushi').active, false);
});

test('setActive rejects an unknown or malformed instance id', async () => {
	const { service } = buildService();
	await assert.rejects(() => service.setActive('nope', true), (err) => {
		assert.equal(err.code, 'TENANT_NOT_FOUND');
		return true;
	});
	await assert.rejects(() => service.setActive('BAD ID', true), (err) => {
		assert.equal(err.code, 'BAD_INSTANCE_ID');
		return true;
	});
});

// ------------------------------------------------------------ misc behaviour

test('instanceStatus reports not_running without a whatsapp dependency', async () => {
	const service = createRestaurantService({ tenantAdmin: fakeTenantAdmin(), publicBase: () => '' });
	assert.deepEqual(await service.instanceStatus('anything'), { status: 'not_running', qr: null });
});

test('a throwing onStep listener cannot break a provision', async () => {
	const { service } = buildService();
	const result = await service.provision(GOOD_INPUT, {
		onStep: () => { throw new Error('the SSE client vanished'); }
	});
	assert.equal(result.instanceId, 'crazy-sushi');
});

test('the service works without redis, whatsapp or a cache invalidator', async () => {
	const tenantAdmin = fakeTenantAdmin();
	const service = createRestaurantService({
		tenantAdmin: tenantAdmin,
		publicBase: () => 'https://whatspro.bekaba.com',
		logger: quietLogger,
		qrTimeoutMs: 20,
		qrPollMs: 5
	});

	const result = await service.provision(GOOD_INPUT);
	assert.equal(result.instanceId, 'crazy-sushi');
	assert.equal(tenantAdmin.rows.has('crazy-sushi'), true);

	const report = await service.destroy('crazy-sushi');
	assert.equal(report.recordDeleted, true);
	assert.equal(report.redisKeys, 0);
});

test('publicBase given as a plain string is ignored rather than misused', async () => {
	const tenantAdmin = fakeTenantAdmin();
	const service = createRestaurantService({
		tenantAdmin: tenantAdmin,
		publicBase: 'https://whatspro.bekaba.com',
		logger: quietLogger,
		qrTimeoutMs: 20,
		qrPollMs: 5
	});
	await service.provision(GOOD_INPUT);
	assert.equal(tenantAdmin.calls.includes('platformFields:'), true);
});
