'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const adminAuth = require('../services/adminAuth');
const {
	MIN_PLAINTEXT_LENGTH,
	adminUsername,
	authConfig,
	hashPassword,
	isBcryptHash,
	isScryptHash,
	isWeakPlaintext,
	loginConfigured,
	parseScryptHash,
	safeEqual,
	verifyCredentials,
	verifyScryptPassword
} = adminAuth;

const ENV_KEYS = ['ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'WHATSPRO_USER', 'WHATSPRO_PASSWORD'];

/** Run fn with exactly the given auth env vars set, restoring the real ones after. */
function withEnv(vars, fn) {
	const saved = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	for (const key of Object.keys(vars)) {
		if (vars[key] !== undefined) process.env[key] = vars[key];
	}
	try {
		return fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		adminAuth.__test.resetWarningThrottle();
	}
}

const STRONG = 'correct-horse-battery';

// ---------------------------------------------------------------- hashPassword

test('hashPassword produces the documented scrypt format', () => {
	const hash = hashPassword(STRONG);
	const parts = hash.split('$');
	assert.equal(parts.length, 4);
	assert.equal(parts[0], 'scrypt');
	assert.equal(parts[1], '32');
	assert.match(parts[2], /^[0-9a-f]{32}$/);
	assert.match(parts[3], /^[0-9a-f]{64}$/);
});

test('hashPassword salts each call so two hashes never match', () => {
	assert.notEqual(hashPassword(STRONG), hashPassword(STRONG));
});

test('hashPassword rejects an empty password', () => {
	assert.throws(() => hashPassword(''), /non-empty/);
});

test('hashPassword rejects an out-of-range keylen', () => {
	assert.throws(() => hashPassword(STRONG, { keylen: 8 }), /keylen/);
	assert.throws(() => hashPassword(STRONG, { keylen: 999 }), /keylen/);
});

test('hashPassword honours a custom keylen', () => {
	const hash = hashPassword(STRONG, { keylen: 64 });
	const parsed = parseScryptHash(hash);
	assert.equal(parsed.keylen, 64);
	assert.equal(parsed.digest.length, 128);
});

// ------------------------------------------------------------ verifyScrypt

test('verifyScryptPassword accepts the original password', () => {
	assert.equal(verifyScryptPassword(STRONG, hashPassword(STRONG)), true);
});

test('verifyScryptPassword rejects a wrong password', () => {
	assert.equal(verifyScryptPassword('wrong-password-here', hashPassword(STRONG)), false);
});

test('verifyScryptPassword returns false rather than throwing on junk', () => {
	assert.equal(verifyScryptPassword(STRONG, 'not-a-hash'), false);
	assert.equal(verifyScryptPassword(STRONG, ''), false);
	assert.equal(verifyScryptPassword(STRONG, null), false);
	assert.equal(verifyScryptPassword('', hashPassword(STRONG)), false);
});

// ------------------------------------------------------------ parse / detect

test('parseScryptHash returns the parts of a valid hash', () => {
	const parsed = parseScryptHash(hashPassword(STRONG));
	assert.equal(parsed.keylen, 32);
	assert.equal(parsed.salt.length, 32);
	assert.equal(parsed.digest.length, 64);
});

test('parseScryptHash rejects malformed hashes', () => {
	assert.equal(parseScryptHash('scrypt$32$abcd'), null);
	assert.equal(parseScryptHash('scrypt$0$aa$bb'), null);
	assert.equal(parseScryptHash('scrypt$32$zz$' + 'a'.repeat(64)), null);
	assert.equal(parseScryptHash('scrypt$32$aa$tooshort'), null);
	assert.equal(parseScryptHash('$2b$10$abcdefghijklmnopqrstuv'), null);
	assert.equal(parseScryptHash(''), null);
});

test('isScryptHash and isBcryptHash identify their own formats only', () => {
	const scrypt = hashPassword(STRONG);
	const bcrypt = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.' + 'a'.repeat(22);
	assert.equal(isScryptHash(scrypt), true);
	assert.equal(isBcryptHash(scrypt), false);
	assert.equal(isBcryptHash(bcrypt), true);
	assert.equal(isScryptHash(bcrypt), false);
});

test('isBcryptHash accepts the 2a, 2b, 2x and 2y variants', () => {
	for (const tag of ['2a', '2b', '2x', '2y']) {
		assert.equal(isBcryptHash('$' + tag + '$10$' + 'a'.repeat(53)), true, tag);
	}
});

// ---------------------------------------------------------------- weak check

test('isWeakPlaintext rejects short, empty and well-known passwords', () => {
	assert.equal(isWeakPlaintext(''), true);
	assert.equal(isWeakPlaintext(null), true);
	assert.equal(isWeakPlaintext('short'), true);
	assert.equal(isWeakPlaintext('Password'), true);
	assert.equal(isWeakPlaintext('CHANGE-ME'), true);
});

test('isWeakPlaintext accepts a long unlisted password', () => {
	assert.equal(isWeakPlaintext(STRONG), false);
	assert.equal(STRONG.length >= MIN_PLAINTEXT_LENGTH, true);
});

// ---------------------------------------------------------------- safeEqual

test('safeEqual compares by value and tolerates length mismatch', () => {
	assert.equal(safeEqual('abc', 'abc'), true);
	assert.equal(safeEqual('abc', 'abd'), false);
	assert.equal(safeEqual('abc', 'abcdef'), false);
	assert.equal(safeEqual('', ''), true);
	assert.equal(safeEqual(null, ''), true);
});

// --------------------------------------------------------------- authConfig

test('authConfig reports scrypt mode when a valid hash is set', () => {
	withEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: hashPassword(STRONG) }, () => {
		const config = authConfig();
		assert.equal(config.configured, true);
		assert.equal(config.mode, 'scrypt');
		assert.equal(loginConfigured(), true);
	});
});

test('authConfig refuses a bcrypt hash and explains why', () => {
	const bcrypt = '$2b$12$' + 'a'.repeat(53);
	withEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: bcrypt }, () => {
		const config = authConfig();
		assert.equal(config.configured, false);
		assert.equal(config.mode, 'bcrypt');
		assert.match(config.reason, /bcrypt is not installed/);
	});
});

test('authConfig reports invalid mode for a malformed hash', () => {
	withEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: 'scrypt$32$oops' }, () => {
		const config = authConfig();
		assert.equal(config.configured, false);
		assert.equal(config.mode, 'invalid');
	});
});

test('authConfig is unconfigured when no username is present', () => {
	withEnv({ ADMIN_PASSWORD_HASH: hashPassword(STRONG) }, () => {
		const config = authConfig();
		assert.equal(config.configured, false);
		assert.equal(config.mode, 'none');
		assert.match(config.reason, /ADMIN_USERNAME/);
	});
});

test('authConfig falls back to legacy plaintext when the password is strong', () => {
	withEnv({ WHATSPRO_USER: 'admin', WHATSPRO_PASSWORD: STRONG }, () => {
		const config = authConfig();
		assert.equal(config.configured, true);
		assert.equal(config.mode, 'plaintext');
		assert.match(config.reason, /legacy plaintext/);
	});
});

test('authConfig rejects a weak legacy plaintext password', () => {
	withEnv({ WHATSPRO_USER: 'admin', WHATSPRO_PASSWORD: 'admin' }, () => {
		const config = authConfig();
		assert.equal(config.configured, false);
		assert.equal(config.mode, 'none');
		assert.match(config.reason, /at least 12 characters/);
	});
});

test('a scrypt hash takes precedence over a legacy plaintext password', () => {
	withEnv({
		ADMIN_USERNAME: 'admin',
		ADMIN_PASSWORD_HASH: hashPassword(STRONG),
		WHATSPRO_PASSWORD: 'a-different-password'
	}, () => {
		assert.equal(authConfig().mode, 'scrypt');
		assert.equal(verifyCredentials('admin', STRONG), true);
		assert.equal(verifyCredentials('admin', 'a-different-password'), false);
	});
});

// ------------------------------------------------------------- adminUsername

test('adminUsername prefers ADMIN_USERNAME and falls back to WHATSPRO_USER', () => {
	withEnv({ ADMIN_USERNAME: 'newadmin', WHATSPRO_USER: 'legacy' }, () => {
		assert.equal(adminUsername(), 'newadmin');
	});
	withEnv({ WHATSPRO_USER: 'legacy' }, () => {
		assert.equal(adminUsername(), 'legacy');
	});
	withEnv({}, () => {
		assert.equal(adminUsername(), '');
	});
});

// --------------------------------------------------------- verifyCredentials

test('verifyCredentials accepts the right pair in scrypt mode', () => {
	withEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: hashPassword(STRONG) }, () => {
		assert.equal(verifyCredentials('admin', STRONG), true);
		assert.equal(verifyCredentials('admin', 'nope-nope-nope'), false);
		assert.equal(verifyCredentials('root', STRONG), false);
	});
});

test('verifyCredentials works on the legacy plaintext path', () => {
	withEnv({ WHATSPRO_USER: 'admin', WHATSPRO_PASSWORD: STRONG }, () => {
		assert.equal(verifyCredentials('admin', STRONG), true);
		assert.equal(verifyCredentials('admin', 'wrong-password-xx'), false);
	});
});

test('verifyCredentials denies everything when login is unconfigured', () => {
	withEnv({}, () => {
		assert.equal(verifyCredentials('admin', STRONG), false);
		assert.equal(verifyCredentials('', ''), false);
	});
});

test('verifyCredentials warns once on the legacy path and then throttles', () => {
	withEnv({ WHATSPRO_USER: 'admin', WHATSPRO_PASSWORD: STRONG }, () => {
		adminAuth.__test.resetWarningThrottle();
		const warnings = [];
		const logger = { warn: (msg) => warnings.push(msg) };

		verifyCredentials('admin', STRONG, { logger: logger });
		verifyCredentials('admin', STRONG, { logger: logger });

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /hash-password/);
	});
});

test('verifyCredentials does not warn in scrypt mode', () => {
	withEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD_HASH: hashPassword(STRONG) }, () => {
		adminAuth.__test.resetWarningThrottle();
		const warnings = [];
		verifyCredentials('admin', STRONG, { logger: { warn: (m) => warnings.push(m) } });
		assert.equal(warnings.length, 0);
	});
});

test('verifyCredentials tolerates a missing logger', () => {
	withEnv({ WHATSPRO_USER: 'admin', WHATSPRO_PASSWORD: STRONG }, () => {
		assert.equal(verifyCredentials('admin', STRONG), true);
		assert.equal(verifyCredentials('admin', STRONG, {}), true);
		assert.equal(verifyCredentials('admin', STRONG, { logger: null }), true);
	});
});
