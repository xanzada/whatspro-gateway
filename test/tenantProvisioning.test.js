'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	MAX_ALLOCATION_ATTEMPTS,
	MAX_INSTANCE_ID_LENGTH,
	MIN_INSTANCE_ID_LENGTH,
	allocateInstanceId,
	digitsOf,
	instanceIdLockKey,
	isValidDomain,
	isValidInstanceId,
	isValidPhone,
	isValidWorkHours,
	normalizeDomain,
	normalizeInstanceIdBase,
	normalizeWorkHours,
	provisioningError,
	purgeTenantRedis,
	releaseInstanceId,
	reserveInstanceId,
	tenantKeyPatterns
} = require('../services/tenantProvisioning');

/** Minimal in-memory stand-in for the node-redis client surface we use. */
function fakeRedis(initialKeys) {
	const store = new Map();
	for (const key of initialKeys || []) store.set(key, '1');
	return {
		store: store,
		calls: { scan: 0, del: 0, set: 0 },
		async set(key, value, options) {
			this.calls.set++;
			if (options && options.NX && store.has(key)) return null;
			store.set(key, value);
			return 'OK';
		},
		async del(key) {
			this.calls.del++;
			const keys = Array.isArray(key) ? key : [key];
			let removed = 0;
			for (const k of keys) if (store.delete(k)) removed++;
			return removed;
		},
		async scan(cursor, options) {
			this.calls.scan++;
			const match = (options && options.MATCH) || '*';
			const rx = new RegExp('^' + match.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
			const keys = Array.from(store.keys()).filter((k) => rx.test(k));
			return { cursor: 0, keys: keys };
		}
	};
}

// ------------------------------------------------------- normalizeInstanceIdBase

test('normalizeInstanceIdBase slugifies a plain restaurant name', () => {
	assert.equal(normalizeInstanceIdBase('Crazy Sushi'), 'crazy-sushi');
	assert.equal(normalizeInstanceIdBase('  Burger   King  '), 'burger-king');
	assert.equal(normalizeInstanceIdBase('KFC'), 'kfc');
});

test('normalizeInstanceIdBase transliterates Cyrillic and Kazakh letters', () => {
	assert.equal(normalizeInstanceIdBase('Crazy суши'), 'crazy-sushi');
	assert.equal(normalizeInstanceIdBase('Престиж'), 'prestizh');
	assert.equal(normalizeInstanceIdBase('Ақжол'), 'akzhol');
});

test('normalizeInstanceIdBase strips punctuation and collapses separators', () => {
	assert.equal(normalizeInstanceIdBase("Joe's  Pizza & Grill!!!"), 'joe-s-pizza-grill');
	assert.equal(normalizeInstanceIdBase('---abc---'), 'abc');
});

test('normalizeInstanceIdBase returns empty for unusable input', () => {
	assert.equal(normalizeInstanceIdBase(''), '');
	assert.equal(normalizeInstanceIdBase('   '), '');
	assert.equal(normalizeInstanceIdBase('!!!'), '');
	assert.equal(normalizeInstanceIdBase(null), '');
	assert.equal(normalizeInstanceIdBase(undefined), '');
});

test('normalizeInstanceIdBase respects the maximum length', () => {
	const out = normalizeInstanceIdBase('a'.repeat(200));
	assert.equal(out.length, MAX_INSTANCE_ID_LENGTH);
	assert.equal(isValidInstanceId(out), true);
});

// -------------------------------------------------------------- isValidInstanceId

test('isValidInstanceId accepts the ids this platform generates', () => {
	for (const id of ['prestige', 'crazy-sushi', 'crazy-sushi-2', 'ab', 'a1', 'test_doner']) {
		assert.equal(isValidInstanceId(id), true, id);
	}
});

test('isValidInstanceId rejects bad shapes', () => {
	for (const id of ['', 'a', '-abc', 'abc-', '_abc', 'Abc', 'a b', 'a.b', 'a'.repeat(65), null]) {
		assert.equal(isValidInstanceId(id), false, String(id));
	}
	assert.equal(MIN_INSTANCE_ID_LENGTH, 2);
});

// ------------------------------------------------------------------- reservation

test('instanceIdLockKey is namespaced under whatspro', () => {
	assert.equal(instanceIdLockKey('crazy-sushi'), 'whatspro:idlock:crazy-sushi');
});

test('reserveInstanceId succeeds once and then refuses the same id', async () => {
	const redis = fakeRedis();
	assert.equal(await reserveInstanceId(redis, 'crazy-sushi'), true);
	assert.equal(await reserveInstanceId(redis, 'crazy-sushi'), false);
});

test('releaseInstanceId frees the id for the next caller', async () => {
	const redis = fakeRedis();
	await reserveInstanceId(redis, 'crazy-sushi');
	assert.equal(await releaseInstanceId(redis, 'crazy-sushi'), true);
	assert.equal(await reserveInstanceId(redis, 'crazy-sushi'), true);
});

test('reservation helpers degrade gracefully without a redis client', async () => {
	assert.equal(await reserveInstanceId(null, 'x'), true);
	assert.equal(await releaseInstanceId(null, 'x'), false);
});

// ---------------------------------------------------------------- allocation

test('allocateInstanceId returns the plain slug when nothing exists', async () => {
	const result = await allocateInstanceId('Crazy Sushi', { exists: async () => false });
	assert.equal(result.instanceId, 'crazy-sushi');
	assert.equal(result.attempts, 1);
	assert.equal(result.base, 'crazy-sushi');
});

test('allocateInstanceId appends -2 then -3 as collisions accumulate', async () => {
	const taken = new Set(['crazy-sushi']);
	const exists = async (id) => taken.has(id);

	const second = await allocateInstanceId('Crazy Sushi', { exists: exists });
	assert.equal(second.instanceId, 'crazy-sushi-2');
	taken.add('crazy-sushi-2');

	const third = await allocateInstanceId('Crazy Sushi', { exists: exists });
	assert.equal(third.instanceId, 'crazy-sushi-3');
	assert.equal(third.attempts, 3);
});

test('allocateInstanceId skips ids locked by a concurrent create', async () => {
	const redis = fakeRedis();
	await reserveInstanceId(redis, 'crazy-sushi');
	const result = await allocateInstanceId('Crazy Sushi', { exists: async () => false, redis: redis });
	assert.equal(result.instanceId, 'crazy-sushi-2');
});

test('allocateInstanceId reserves the id it hands back', async () => {
	const redis = fakeRedis();
	const result = await allocateInstanceId('Crazy Sushi', { exists: async () => false, redis: redis });
	assert.equal(result.reserved, true);
	assert.equal(redis.store.has('whatspro:idlock:crazy-sushi'), true);
});

test('allocateInstanceId releases the lock if the record appears mid-flight', async () => {
	const redis = fakeRedis();
	let seen = 0;
	const exists = async (id) => {
		// Free before the lock, taken on the post-lock recheck, only for the first id.
		if (id !== 'crazy-sushi') return false;
		seen++;
		return seen === 2;
	};
	const result = await allocateInstanceId('Crazy Sushi', { exists: exists, redis: redis });
	assert.equal(result.instanceId, 'crazy-sushi-2');
	assert.equal(redis.store.has('whatspro:idlock:crazy-sushi'), false);
});

test('allocateInstanceId falls back when the name yields no usable slug', async () => {
	const result = await allocateInstanceId('!!!', { exists: async () => false });
	assert.equal(result.instanceId, 'restaurant');
});

test('allocateInstanceId honours a custom fallback', async () => {
	const result = await allocateInstanceId('', { exists: async () => false, fallback: 'Tenant Site' });
	assert.equal(result.instanceId, 'tenant-site');
});

test('allocateInstanceId keeps suffixed ids inside the length limit', async () => {
	const taken = new Set(['a'.repeat(MAX_INSTANCE_ID_LENGTH)]);
	const result = await allocateInstanceId('a'.repeat(MAX_INSTANCE_ID_LENGTH), { exists: async (id) => taken.has(id) });
	assert.equal(result.instanceId.length <= MAX_INSTANCE_ID_LENGTH, true);
	assert.equal(isValidInstanceId(result.instanceId), true);
	assert.match(result.instanceId, /-2$/);
});

test('allocateInstanceId gives up with a coded error when everything is taken', async () => {
	await assert.rejects(
		() => allocateInstanceId('Crazy Sushi', { exists: async () => true }),
		(err) => {
			assert.equal(err.code, 'INSTANCE_ID_EXHAUSTED');
			assert.equal(err.base, 'crazy-sushi');
			assert.match(err.message, new RegExp(String(MAX_ALLOCATION_ATTEMPTS)));
			return true;
		}
	);
});

// -------------------------------------------------------------------- phone

test('digitsOf keeps only digits', () => {
	assert.equal(digitsOf('+7 (747) 688-49-56'), '77476884956');
	assert.equal(digitsOf(''), '');
	assert.equal(digitsOf(null), '');
});

test('isValidPhone accepts real numbers and rejects the rest', () => {
	assert.equal(isValidPhone('+7 747 688 49 56'), true);
	assert.equal(isValidPhone('77003449505'), true);
	assert.equal(isValidPhone('12345'), false);
	assert.equal(isValidPhone('1'.repeat(16)), false);
	assert.equal(isValidPhone(''), false);
});

// --------------------------------------------------------------- work hours

test('normalizeWorkHours unifies spacing and dash characters', () => {
	assert.equal(normalizeWorkHours('09:00-03:00'), '09:00 - 03:00');
	assert.equal(normalizeWorkHours('09:00   \u2014   03:00'), '09:00 - 03:00');
	assert.equal(normalizeWorkHours('  10:00 - 22:00  '), '10:00 - 22:00');
	assert.equal(normalizeWorkHours(''), '');
});

test('isValidWorkHours accepts a 24h range and rejects nonsense', () => {
	assert.equal(isValidWorkHours('09:00 - 03:00'), true);
	assert.equal(isValidWorkHours('09:00-03:00'), true);
	assert.equal(isValidWorkHours('00:00 - 23:59'), true);
	assert.equal(isValidWorkHours('24:00 - 03:00'), false);
	assert.equal(isValidWorkHours('9:00 - 3:00'), false);
	assert.equal(isValidWorkHours('all day'), false);
	assert.equal(isValidWorkHours(''), false);
});

// ------------------------------------------------------------------- domain

test('normalizeDomain reduces a URL to a bare host', () => {
	assert.equal(normalizeDomain('https://prestige.bekaba.com/'), 'prestige.bekaba.com');
	assert.equal(normalizeDomain('HTTP://Prestige.Bekaba.COM:8080/path?x=1'), 'prestige.bekaba.com');
	assert.equal(normalizeDomain('prestige.bekaba.com.'), 'prestige.bekaba.com');
	assert.equal(normalizeDomain(''), '');
});

test('isValidDomain accepts hostnames and rejects malformed ones', () => {
	assert.equal(isValidDomain('prestige.bekaba.com'), true);
	assert.equal(isValidDomain('https://prestige.bekaba.com/'), true);
	assert.equal(isValidDomain('localhost'), false);
	assert.equal(isValidDomain('bekaba..com'), false);
	assert.equal(isValidDomain('-bad.com'), false);
	assert.equal(isValidDomain(''), false);
});

// -------------------------------------------------------------------- purge

test('tenantKeyPatterns covers every tenant namespace exactly once', () => {
	const patterns = tenantKeyPatterns('prestige');
	assert.equal(patterns.length, 21);
	assert.equal(new Set(patterns).size, 21);
	for (const pattern of patterns) assert.match(pattern, /prestige/);
	assert.equal(patterns.includes('chatwoot:inbox:prestige'), true);
	assert.equal(patterns.includes('history:prestige:*'), true);
	assert.equal(patterns.includes('operator_active:prestige:*'), true);
});

test('purgeTenantRedis deletes only the target tenant keys', async () => {
	const redis = fakeRedis([
		'chatwoot:history:prestige:77001112233',
		'history:prestige:77001112233',
		'chatwoot:inbox:prestige',
		'chatwoot:media:prestige:AC66E9',
		'operator_active:prestige:77001112233',
		'mute:prestige:77001112233',
		'chatwoot:inbox:other',
		'chatwoot:history:other:77001112233',
		'whatspro:instances'
	]);

	const result = await purgeTenantRedis(redis, 'prestige');

	assert.equal(result.deleted, 6);
	assert.equal(result.patterns.length, 21);
	assert.equal(redis.store.has('chatwoot:inbox:other'), true);
	assert.equal(redis.store.has('chatwoot:history:other:77001112233'), true);
	assert.equal(redis.store.has('whatspro:instances'), true);
	assert.equal(redis.store.has('chatwoot:inbox:prestige'), false);
});

test('purgeTenantRedis is a no-op when the tenant has no keys', async () => {
	const redis = fakeRedis(['chatwoot:inbox:other']);
	const result = await purgeTenantRedis(redis, 'prestige');
	assert.equal(result.deleted, 0);
	assert.equal(redis.calls.del, 0);
	assert.equal(redis.store.size, 1);
});

test('purgeTenantRedis counts an overlapping key only once', async () => {
	// chatwoot:sos:prestige matches both a literal pattern and no other.
	const redis = fakeRedis(['chatwoot:sos:prestige', 'chatwoot:sos:prestige:77001112233']);
	const result = await purgeTenantRedis(redis, 'prestige');
	assert.equal(result.deleted, 2);
	assert.equal(redis.store.size, 0);
});

test('purgeTenantRedis still reports its patterns without a redis client', async () => {
	const result = await purgeTenantRedis(null, 'prestige');
	assert.equal(result.deleted, 0);
	assert.equal(result.patterns.length, 21);
});

// ------------------------------------------------------------------- errors

test('provisioningError carries a code and extra fields', () => {
	const err = provisioningError('BAD_INPUT', 'nope', { step: 'validate' });
	assert.equal(err instanceof Error, true);
	assert.equal(err.code, 'BAD_INPUT');
	assert.equal(err.message, 'nope');
	assert.equal(err.step, 'validate');
});

test('provisioningError falls back to the code as the message', () => {
	assert.equal(provisioningError('BAD_INPUT').message, 'BAD_INPUT');
});
