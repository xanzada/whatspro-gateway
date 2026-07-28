'use strict';

/**
 * Tenant provisioning primitives.
 *
 * This module deliberately holds no I/O clients of its own. Callers pass in the
 * Redis client and an existence predicate, which keeps every rule in here unit
 * testable without a running NocoDB or Redis.
 *
 * Responsibilities:
 *   - normalise and validate operator input (instance id, phone, domain, hours)
 *   - allocate a unique instance id from a restaurant name
 *   - reserve that id briefly so two concurrent creates cannot collide
 *   - enumerate and purge every Redis key that belongs to a tenant
 */

const MIN_INSTANCE_ID_LENGTH = 2;
const MAX_INSTANCE_ID_LENGTH = 64;
const MAX_ALLOCATION_ATTEMPTS = 200;

const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;
const INSTANCE_ID_LOCK_PREFIX = 'whatspro:idlock:';
const DEFAULT_LOCK_TTL_SECONDS = 120;

const SCAN_BATCH_SIZE = 500;

const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;

const WORK_HOURS_PATTERN = /^([01]\d|2[0-3]):[0-5]\d - ([01]\d|2[0-3]):[0-5]\d$/;
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Transliteration for the Cyrillic brand names this platform actually sees. */
const TRANSLITERATION = {
	а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
	з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
	п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
	ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu',
	я: 'ya', і: 'i', ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u',
	ү: 'u', һ: 'h'
};

function asText(value) {
	if (value === null || value === undefined) return '';
	return String(value);
}

/**
 * Build an Error carrying a machine-readable code, so routes can map failures
 * onto HTTP statuses without string matching.
 */
function provisioningError(code, message, extra) {
	const error = new Error(message || code);
	error.code = code;
	if (extra && typeof extra === 'object') {
		for (const key of Object.keys(extra)) error[key] = extra[key];
	}
	return error;
}

// ------------------------------------------------------------------ instance id

/**
 * Turn a restaurant name into a usable instance id stem.
 * 'Crazy Sushi' -> 'crazy-sushi', 'Crazy суши' -> 'crazy-sushi'.
 * Returns '' when nothing usable survives, so callers can supply a fallback.
 */
function normalizeInstanceIdBase(value) {
	const lowered = asText(value).trim().toLowerCase();
	if (!lowered) return '';

	let out = '';
	for (const char of lowered) {
		if (Object.prototype.hasOwnProperty.call(TRANSLITERATION, char)) {
			out += TRANSLITERATION[char];
		} else if (/[a-z0-9]/.test(char)) {
			out += char;
		} else {
			out += '-';
		}
	}

	out = out.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
	if (out.length > MAX_INSTANCE_ID_LENGTH) {
		out = out.slice(0, MAX_INSTANCE_ID_LENGTH).replace(/-+$/, '');
	}
	return out;
}

function isValidInstanceId(value) {
	const text = asText(value);
	if (text.length < MIN_INSTANCE_ID_LENGTH) return false;
	if (text.length > MAX_INSTANCE_ID_LENGTH) return false;
	return INSTANCE_ID_PATTERN.test(text);
}

function instanceIdLockKey(instanceId) {
	return INSTANCE_ID_LOCK_PREFIX + asText(instanceId);
}

/**
 * Claim an instance id for a short window using SET NX EX.
 * Returns true when this caller won the race.
 */
async function reserveInstanceId(redis, instanceId, ttlSeconds) {
	if (!redis || typeof redis.set !== 'function') return true;
	const ttl = Number.isInteger(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : DEFAULT_LOCK_TTL_SECONDS;
	const reply = await redis.set(instanceIdLockKey(instanceId), '1', { NX: true, EX: ttl });
	return reply === 'OK' || reply === true;
}

/** Drop a reservation. Safe to call for an id that was never reserved. */
async function releaseInstanceId(redis, instanceId) {
	if (!redis || typeof redis.del !== 'function') return false;
	const removed = await redis.del(instanceIdLockKey(instanceId));
	return Number(removed) > 0;
}

/**
 * Find a free instance id derived from a restaurant name.
 * 'Crazy Sushi' -> crazy-sushi, then crazy-sushi-2, crazy-sushi-3, ...
 *
 * @param {string} rawBase       restaurant name or explicit stem
 * @param {object} options
 * @param {Function} options.exists   async (id) => boolean, checks the record store
 * @param {object}  [options.redis]   redis client used to reserve the id
 * @param {number}  [options.ttlSeconds]
 * @param {string}  [options.fallback]
 * @returns {Promise<{instanceId:string, base:string, attempts:number, reserved:boolean}>}
 */
async function allocateInstanceId(rawBase, options) {
	const opts = options || {};
	const exists = typeof opts.exists === 'function' ? opts.exists : async () => false;
	const fallback = normalizeInstanceIdBase(opts.fallback || 'restaurant') || 'restaurant';

	let base = normalizeInstanceIdBase(rawBase) || fallback;
	if (base.length < MIN_INSTANCE_ID_LENGTH) base = fallback;

	for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
		const suffix = attempt === 1 ? '' : '-' + attempt;
		let candidate = base;

		// Keep room for the suffix rather than overflowing the length limit.
		if (candidate.length + suffix.length > MAX_INSTANCE_ID_LENGTH) {
			candidate = candidate.slice(0, MAX_INSTANCE_ID_LENGTH - suffix.length).replace(/-+$/, '');
		}
		candidate += suffix;

		if (!isValidInstanceId(candidate)) continue;
		if (await exists(candidate)) continue;

		const reserved = await reserveInstanceId(opts.redis, candidate, opts.ttlSeconds);
		if (!reserved) continue;

		// Re-check after winning the lock: a slower writer may have landed first.
		if (await exists(candidate)) {
			await releaseInstanceId(opts.redis, candidate);
			continue;
		}

		return { instanceId: candidate, base: base, attempts: attempt, reserved: true };
	}

	throw provisioningError(
		'INSTANCE_ID_EXHAUSTED',
		'Could not find a free instance id for "' + base + '" after ' + MAX_ALLOCATION_ATTEMPTS + ' attempts',
		{ base: base }
	);
}

// ---------------------------------------------------------------------- phone

function digitsOf(value) {
	return asText(value).replace(/\D+/g, '');
}

function isValidPhone(value) {
	const digits = digitsOf(value);
	return digits.length >= MIN_PHONE_DIGITS && digits.length <= MAX_PHONE_DIGITS;
}

// --------------------------------------------------------------- work hours

/** Collapse whitespace and unify dash styles into 'HH:MM - HH:MM'. */
function normalizeWorkHours(value) {
	const text = asText(value).trim();
	if (!text) return '';
	return text
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/\s*-\s*/g, ' - ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Blank is not valid here; callers treat work hours as optional themselves. */
function isValidWorkHours(value) {
	return WORK_HOURS_PATTERN.test(normalizeWorkHours(value));
}

// -------------------------------------------------------------------- domain

/** Strip scheme, path, port and trailing dots, and lowercase the host. */
function normalizeDomain(value) {
	let text = asText(value).trim().toLowerCase();
	if (!text) return '';
	text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
	text = text.split('/')[0];
	text = text.split('?')[0];
	text = text.split('#')[0];
	text = text.split('@').pop();
	text = text.split(':')[0];
	text = text.replace(/\.+$/, '');
	return text;
}

function isValidDomain(value) {
	const host = normalizeDomain(value);
	if (!host || host.length > 253) return false;
	if (host.includes('..')) return false;
	return DOMAIN_PATTERN.test(host);
}

// --------------------------------------------------------------------- redis

/**
 * Every Redis key pattern owned by one tenant.
 * Kept in one place so purge and audit can never drift apart.
 */
function tenantKeyPatterns(instanceId) {
	const i = asText(instanceId);
	return [
		'chatwoot:history:' + i + ':*',
		'history:' + i + ':*',
		'chatwoot:inbox:' + i,
		'chatwoot:archive:' + i,
		'chatwoot:archive:' + i + ':*',
		'chatwoot:state:' + i + ':*',
		'chatwoot:viewed:' + i,
		'chatwoot:media:' + i + ':*',
		'chatwoot:media-ids:' + i + ':*',
		'chatwoot:message-ids:' + i + ':*',
		'chatwoot:deleted:' + i + ':*',
		'chatwoot:receipts:' + i + ':*',
		'chatwoot:expiry:' + i,
		'chatwoot:sos:' + i,
		'chatwoot:sos:' + i + ':*',
		'chatwoot:sos-unread:' + i + ':*',
		'chatwoot:events:' + i,
		'chatwoot:send-idempotency:' + i + ':*',
		'operator_active:' + i + ':*',
		'mute:' + i + ':*',
		'kanban_lock:' + i + ':*'
	];
}

/**
 * Delete every Redis key belonging to a tenant.
 * Uses SCAN rather than KEYS so a large database is not blocked.
 *
 * @returns {Promise<{deleted:number, patterns:string[]}>}
 */
async function purgeTenantRedis(redis, instanceId, options) {
	const opts = options || {};
	const patterns = tenantKeyPatterns(instanceId);
	if (!redis || typeof redis.scan !== 'function' || typeof redis.del !== 'function') {
		return { deleted: 0, patterns: patterns };
	}

	const count = Number.isInteger(opts.batchSize) && opts.batchSize > 0 ? opts.batchSize : SCAN_BATCH_SIZE;
	const found = new Set();

	for (const pattern of patterns) {
		let cursor = 0;
		do {
			const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: count });
			const nextCursor = Array.isArray(reply) ? reply[0] : reply.cursor;
			const keys = Array.isArray(reply) ? reply[1] : reply.keys;
			for (const key of keys || []) found.add(key);
			cursor = Number(nextCursor) || 0;
		} while (cursor !== 0);
	}

	if (found.size === 0) return { deleted: 0, patterns: patterns };

	const keys = Array.from(found);
	let deleted = 0;
	for (let i = 0; i < keys.length; i += count) {
		const removed = await redis.del(keys.slice(i, i + count));
		deleted += Number(removed) || 0;
	}

	return { deleted: deleted, patterns: patterns };
}

module.exports = {
	MAX_ALLOCATION_ATTEMPTS: MAX_ALLOCATION_ATTEMPTS,
	MAX_INSTANCE_ID_LENGTH: MAX_INSTANCE_ID_LENGTH,
	MAX_PHONE_DIGITS: MAX_PHONE_DIGITS,
	MIN_INSTANCE_ID_LENGTH: MIN_INSTANCE_ID_LENGTH,
	MIN_PHONE_DIGITS: MIN_PHONE_DIGITS,
	allocateInstanceId: allocateInstanceId,
	digitsOf: digitsOf,
	instanceIdLockKey: instanceIdLockKey,
	isValidDomain: isValidDomain,
	isValidInstanceId: isValidInstanceId,
	isValidPhone: isValidPhone,
	isValidWorkHours: isValidWorkHours,
	normalizeDomain: normalizeDomain,
	normalizeInstanceIdBase: normalizeInstanceIdBase,
	normalizeWorkHours: normalizeWorkHours,
	provisioningError: provisioningError,
	purgeTenantRedis: purgeTenantRedis,
	releaseInstanceId: releaseInstanceId,
	reserveInstanceId: reserveInstanceId,
	tenantKeyPatterns: tenantKeyPatterns
};
