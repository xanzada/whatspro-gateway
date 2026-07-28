'use strict';

/**
 * Admin credential verification for the WhatsPro control panel.
 *
 * Password hashes use scrypt from node:crypto so the platform gains hashed
 * credentials without adding a native dependency. Format:
 *
 *   scrypt$<keylen>$<saltHex>$<hashHex>
 *
 * bcrypt hashes are recognised and reported clearly rather than silently
 * failing, because verifying them would require installing bcrypt.
 *
 * Environment:
 *   ADMIN_USERNAME       preferred username  (falls back to WHATSPRO_USER)
 *   ADMIN_PASSWORD_HASH  preferred password  (falls back to WHATSPRO_PASSWORD)
 *   WHATSPRO_PASSWORD    legacy plaintext, supported but warned about
 */

const crypto = require('crypto');

const SCRYPT_PREFIX = 'scrypt$';
const BCRYPT_PATTERN = /^\$2[abxy]?\$\d{2}\$/;

const DEFAULT_KEYLEN = 32;
const MIN_KEYLEN = 16;
const MAX_KEYLEN = 128;
const SALT_BYTES = 16;

const MIN_PLAINTEXT_LENGTH = 12;
const WEAK_PLAINTEXT = new Set([
	'change-me',
	'changeme',
	'password',
	'admin',
	'admin123',
	'secret',
	'whatspro'
]);

const WARNING_INTERVAL_MS = 60000;
let lastWarningAt = 0;

function asText(value) {
	if (value === null || value === undefined) return '';
	return String(value);
}

/** Constant-time comparison that does not leak length through early return. */
function safeEqual(a, b) {
	const left = Buffer.from(asText(a), 'utf8');
	const right = Buffer.from(asText(b), 'utf8');
	if (left.length !== right.length) {
		// Still burn a comparison so timing does not reveal the length mismatch.
		crypto.timingSafeEqual(left, left);
		return false;
	}
	return crypto.timingSafeEqual(left, right);
}

/** Constant-time comparison of two hex digests. */
function safeEqualHex(a, b) {
	const left = asText(a);
	const right = asText(b);
	if (left.length !== right.length || left.length === 0) return false;

	let leftBuf;
	let rightBuf;
	try {
		leftBuf = Buffer.from(left, 'hex');
		rightBuf = Buffer.from(right, 'hex');
	} catch (error) {
		return false;
	}
	if (leftBuf.length !== rightBuf.length || leftBuf.length === 0) return false;
	return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function isScryptHash(value) {
	return asText(value).trim().startsWith(SCRYPT_PREFIX);
}

function isBcryptHash(value) {
	return BCRYPT_PATTERN.test(asText(value).trim());
}

/**
 * Parse scrypt$<keylen>$<saltHex>$<hashHex> into its parts.
 * @returns {{keylen:number, salt:string, digest:string}|null}
 */
function parseScryptHash(value) {
	const text = asText(value).trim();
	if (!isScryptHash(text)) return null;

	const parts = text.split('$');
	if (parts.length !== 4) return null;

	const keylen = Number(parts[1]);
	const salt = parts[2];
	const digest = parts[3];

	if (!Number.isInteger(keylen) || keylen < MIN_KEYLEN || keylen > MAX_KEYLEN) return null;
	if (!/^[0-9a-f]+$/i.test(salt) || salt.length % 2 !== 0) return null;
	if (!/^[0-9a-f]+$/i.test(digest) || digest.length !== keylen * 2) return null;

	return { keylen: keylen, salt: salt, digest: digest };
}

/**
 * Hash a plaintext password for storage in ADMIN_PASSWORD_HASH.
 * @param {string} password
 * @param {{keylen?:number}} [options]
 * @returns {string}
 */
function hashPassword(password, options) {
	const opts = options || {};
	const text = asText(password);
	if (!text) throw new Error('hashPassword requires a non-empty password');

	const keylen = Number.isInteger(opts.keylen) ? opts.keylen : DEFAULT_KEYLEN;
	if (keylen < MIN_KEYLEN || keylen > MAX_KEYLEN) {
		throw new Error('hashPassword keylen must be between ' + MIN_KEYLEN + ' and ' + MAX_KEYLEN);
	}

	const salt = crypto.randomBytes(SALT_BYTES);
	const digest = crypto.scryptSync(text, salt, keylen);
	return SCRYPT_PREFIX + keylen + '$' + salt.toString('hex') + '$' + digest.toString('hex');
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Returns false for malformed hashes rather than throwing, so a bad env value
 * denies access instead of crashing the login route.
 */
function verifyScryptPassword(password, storedHash) {
	const parsed = parseScryptHash(storedHash);
	if (!parsed) return false;

	const text = asText(password);
	if (!text) return false;

	let computed;
	try {
		computed = crypto.scryptSync(text, Buffer.from(parsed.salt, 'hex'), parsed.keylen);
	} catch (error) {
		return false;
	}
	return safeEqualHex(computed.toString('hex'), parsed.digest);
}

function adminUsername() {
	const preferred = asText(process.env.ADMIN_USERNAME).trim();
	if (preferred) return preferred;
	return asText(process.env.WHATSPRO_USER).trim();
}

function adminPasswordHash() {
	return asText(process.env.ADMIN_PASSWORD_HASH).trim();
}

function legacyPlaintextPassword() {
	return asText(process.env.WHATSPRO_PASSWORD);
}

function isWeakPlaintext(password) {
	const text = asText(password);
	if (!text) return true;
	if (text.length < MIN_PLAINTEXT_LENGTH) return true;
	return WEAK_PLAINTEXT.has(text.toLowerCase());
}

/**
 * Describe how login is configured right now.
 * @returns {{configured:boolean, mode:string, reason:string}}
 */
function authConfig() {
	const username = adminUsername();
	const hash = adminPasswordHash();
	const plaintext = legacyPlaintextPassword();

	if (!username) {
		return { configured: false, mode: 'none', reason: 'ADMIN_USERNAME is not set' };
	}

	if (hash) {
		if (isBcryptHash(hash)) {
			return {
				configured: false,
				mode: 'bcrypt',
				reason: 'ADMIN_PASSWORD_HASH is a bcrypt hash, but bcrypt is not installed. Use a scrypt hash.'
			};
		}
		if (!isScryptHash(hash) || !parseScryptHash(hash)) {
			return {
				configured: false,
				mode: 'invalid',
				reason: 'ADMIN_PASSWORD_HASH is malformed. Expected scrypt$<keylen>$<saltHex>$<hashHex>.'
			};
		}
		return { configured: true, mode: 'scrypt', reason: '' };
	}

	if (plaintext && !isWeakPlaintext(plaintext)) {
		return { configured: true, mode: 'plaintext', reason: 'ADMIN_PASSWORD_HASH is not set; using legacy plaintext password' };
	}

	return {
		configured: false,
		mode: 'none',
		reason: 'No usable password. Set ADMIN_PASSWORD_HASH, or a WHATSPRO_PASSWORD of at least ' + MIN_PLAINTEXT_LENGTH + ' characters.'
	};
}

function loginConfigured() {
	return authConfig().configured;
}

/** Warn at most once a minute while login runs on the legacy plaintext path. */
function warnIfLegacy(config, logger) {
	if (!config || config.mode !== 'plaintext') return;
	if (!logger || typeof logger.warn !== 'function') return;

	const now = Date.now();
	if (now - lastWarningAt < WARNING_INTERVAL_MS) return;
	lastWarningAt = now;
	logger.warn('[AUTH] ' + config.reason + ". Generate one with: npm run hash-password -- 'your-password'");
}

/**
 * Verify a submitted username and password.
 * Synchronous by design, so the login route needs no await.
 * @param {string} username
 * @param {string} password
 * @param {{logger?:{warn:Function}}} [options]
 * @returns {boolean}
 */
function verifyCredentials(username, password, options) {
	const opts = options || {};
	const config = authConfig();
	if (!config.configured) return false;

	warnIfLegacy(config, opts.logger);

	const userOk = safeEqual(username, adminUsername());

	let passOk;
	if (config.mode === 'scrypt') {
		passOk = verifyScryptPassword(password, adminPasswordHash());
	} else {
		passOk = safeEqual(password, legacyPlaintextPassword());
	}

	return userOk && passOk;
}

module.exports = {
	MIN_PLAINTEXT_LENGTH: MIN_PLAINTEXT_LENGTH,
	adminPasswordHash: adminPasswordHash,
	adminUsername: adminUsername,
	authConfig: authConfig,
	hashPassword: hashPassword,
	isBcryptHash: isBcryptHash,
	isScryptHash: isScryptHash,
	isWeakPlaintext: isWeakPlaintext,
	loginConfigured: loginConfigured,
	parseScryptHash: parseScryptHash,
	safeEqual: safeEqual,
	verifyCredentials: verifyCredentials,
	verifyScryptPassword: verifyScryptPassword,
	__test: {
		legacyPlaintextPassword: legacyPlaintextPassword,
		safeEqualHex: safeEqualHex,
		resetWarningThrottle: function resetWarningThrottle() {
			lastWarningAt = 0;
		}
	}
};
