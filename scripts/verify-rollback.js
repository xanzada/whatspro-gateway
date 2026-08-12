#!/usr/bin/env node
/**
 * Proves the Chromium rollback transport can still be used.
 *
 * The gateway runs on Baileys, which has no stable release at all -- npm's
 * `latest` is a release candidate. The Chromium transport is kept as insurance
 * against Baileys-specific breakage, reachable by env alone
 * (WHATSPRO_TRANSPORT=wwebjs, or WHATSPRO_WWEBJS_INSTANCES=<id>) so a rollback
 * needs a restart and not a migration.
 *
 * Insurance nobody has ever tested is not insurance. This script answers, from
 * inside the running container, whether that path would actually come up:
 *
 *   docker exec -w /app <whatspro-container> npm run verify:rollback
 *
 * It does not launch a browser and does not connect to WhatsApp -- a second
 * socket for a live tenant is exactly the thing not to do casually. It checks
 * the things that silently rot: the module, the browser binary, the env
 * pointing at it, and whether the stored profile still holds a pairing.
 *
 * Exit code 0 = the rollback is available. 1 = something would stop it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const AUTH_PATH = process.env.WHATSAPP_AUTH_PATH || path.join(process.cwd(), 'whatsapp_auth');
const results = [];

function check(name, fn) {
    try {
        const detail = fn();
        results.push({ name, ok: true, detail: detail || 'ok' });
    } catch (error) {
        results.push({ name, ok: false, detail: error?.message || String(error) });
    }
}

check('whatsapp-web.js loads', () => {
    const wwebjs = require('whatsapp-web.js');
    for (const name of ['Client', 'LocalAuth', 'MessageMedia']) {
        if (typeof wwebjs[name] !== 'function') throw new Error(`${name} missing`);
    }
    return `v${require('whatsapp-web.js/package.json').version}`;
});

check('a browser binary exists', () => {
    // The same probe order whatsappManager.js uses when it builds the client.
    const candidates = ['/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/chromium'];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) throw new Error(`none of ${candidates.join(', ')}`);
    return found;
});

check('PUPPETEER_EXECUTABLE_PATH points at it', () => {
    // Only scripts that launch puppeteer without an explicit path depend on
    // this, which is why it stayed wrong for so long. Still worth failing on:
    // a variable naming a file that does not exist is a trap for the next
    // person, not a harmless leftover.
    const configured = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!configured) throw new Error('not set');
    if (!fs.existsSync(configured)) throw new Error(`set to ${configured}, which does not exist`);
    return configured;
});

check('the wa-js call bundle is readable', () => {
    // Call rejection under the Chromium transport goes through this bundle
    // first; without it a rejected call is never confirmed by the server.
    const bundle = path.join(process.cwd(), 'node_modules', '@wppconnect', 'wa-js', 'dist', 'wppconnect-wa.js');
    const size = fs.statSync(bundle).size;
    if (size < 100000) throw new Error(`only ${size} bytes, expected a full bundle`);
    return `${Math.round(size / 1024)}KB`;
});

check('a stored Chromium profile could skip the QR scan', () => {
    // A rollback with no profile still works -- it just costs a physical phone
    // scan, which is the whole thing worth avoiding. IndexedDB is where
    // WhatsApp Web keeps the keys, so its presence is what makes the profile
    // worth its disk. Whether the linked device is still live can only be
    // learned by connecting, which this script deliberately does not do.
    const profiles = fs.existsSync(AUTH_PATH)
        ? fs.readdirSync(AUTH_PATH).filter(entry => entry.startsWith('session-'))
        : [];
    if (!profiles.length) return 'none stored (a rollback would need a QR scan)';
    const usable = profiles.filter(profile =>
        fs.existsSync(path.join(AUTH_PATH, profile, 'Default', 'IndexedDB')));
    return `${usable.length}/${profiles.length} with IndexedDB: ${usable.join(', ') || '-'}`;
});

check('the env switches are still read by the manager', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8');
    for (const flag of ['WHATSPRO_TRANSPORT', 'WHATSPRO_WWEBJS_INSTANCES']) {
        if (!source.includes(flag)) throw new Error(`${flag} no longer referenced`);
    }
    return 'WHATSPRO_TRANSPORT, WHATSPRO_WWEBJS_INSTANCES';
});

const failed = results.filter(item => !item.ok);
for (const item of results) {
    console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}`);
}
console.log(failed.length
    ? `\nrollback NOT available: ${failed.length} of ${results.length} checks failed`
    : `\nrollback available: set WHATSPRO_WWEBJS_INSTANCES=<instanceId> (or WHATSPRO_TRANSPORT=wwebjs) and restart`);
process.exit(failed.length ? 1 : 0);
