const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manager = require('../services/whatsappManager');
const wa = manager.__test;

test('Baileys is the default transport and a pinned tenant stays on Chromium', () => {
    assert.equal(wa.configuredTransport('fresh-tenant'), 'baileys');
    // Env is read at module load, so the pinned set is exercised through the
    // recorded map, which is the same switch startWhatsAppInstance flips.
    wa.instanceTransports.set('pinned-tenant', 'wwebjs');
    assert.equal(wa.activeTransport('pinned-tenant'), 'wwebjs');
    assert.equal(wa.usesBaileys('pinned-tenant'), false);
    assert.equal(wa.usesBaileys('fresh-tenant'), true);
    wa.instanceTransports.delete('pinned-tenant');
});

test('each transport keeps its own credential directory', () => {
    assert.match(wa.getSessionPath('acme'), /baileys-acme$/);
    wa.instanceTransports.set('acme', 'wwebjs');
    assert.match(wa.getSessionPath('acme'), /session-acme$/);
    wa.instanceTransports.delete('acme');
});

test('a Baileys directory without creds.json is not a restorable session', () => {
    const dir = wa.getBaileysSessionPath('probe-session-test');
    const authRoot = path.dirname(dir);
    const rootExisted = fs.existsSync(authRoot);
    fs.mkdirSync(dir, { recursive: true });
    try {
        fs.writeFileSync(path.join(dir, 'pre-key-1.json'), '{}');
        assert.equal(wa.hasStoredSession('probe-session-test'), false, 'signal keys alone must still ask for a QR');
        fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
        assert.equal(wa.hasStoredSession('probe-session-test'), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        if (!rootExisted) fs.rmSync(authRoot, { recursive: true, force: true });
    }
});

test('the Chromium lock sweeper does not run on the Baileys transport', () => {
    assert.equal(wa.cleanupChromiumRuntimeLocks('baileys-only-tenant'), 0);
});

test('a negative ack is reported as failed instead of sent', () => {
    assert.equal(wa.deliveryStatusFromAck(-1), 'failed');
    assert.equal(wa.deliveryStatusFromAck(0), 'sent');
    assert.equal(wa.deliveryStatusFromAck(2), 'delivered');
    assert.equal(wa.deliveryStatusFromAck(3), 'read');
});

test('outgoing media is described for Baileys without loading whatsapp-web.js', () => {
    const { mimeType, cleanBase64 } = wa.splitBase64Payload('data:image/png;base64,QUJD');
    assert.equal(mimeType, 'image/png');
    assert.equal(cleanBase64, 'QUJD');

    const media = wa.buildOutgoingMedia('baileys-tenant', mimeType, cleanBase64, 'receipt.png');
    assert.deepEqual(media, { mimetype: 'image/png', data: 'QUJD', filename: 'receipt.png' });
});

test('an operator image survives a transient failure instead of being lost', async () => {
    const instanceId = 'media-queue-tenant';
    wa.clearPendingTextQueue(instanceId);
    wa.clearJidMap();

    wa.queueOutgoingMedia(instanceId, '77000000001', {
        base64Data: 'data:image/png;base64,QUJD',
        fileName: 'receipt.png',
        caption: 'чек'
    }, 'transport_failed');

    const queued = wa.getPendingTextQueue(instanceId);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].media.fileName, 'receipt.png');
    assert.equal(queued[0].media.caption, 'чек');

    const sent = [];
    const fakeClient = {
        async sendMessage(chatId, media, options) {
            sent.push({ chatId, media, options });
            return { id: { id: 'MEDIA1' }, ack: 1 };
        }
    };

    const result = await wa.deliverWhatsAppMedia(
        fakeClient, instanceId, '77000000001', 'data:image/png;base64,QUJD', 'receipt.png', 'чек'
    );
    assert.equal(result.success, true);
    assert.equal(result.messageId, 'MEDIA1');
    assert.equal(sent[0].chatId, '77000000001@c.us');
    assert.equal(sent[0].media.mimetype, 'image/png');
    assert.equal(sent[0].options.caption, 'чек');

    wa.clearPendingTextQueue(instanceId);
    wa.clearLocalBotSends();
});

test('presence state "read" marks the chat seen instead of typing', async () => {
    const instanceId = 'presence-tenant';
    const calls = [];
    manager.clients.set(instanceId, {
        async getChatById() {
            return {
                async sendSeen() { calls.push('seen'); },
                async sendStateTyping() { calls.push('typing'); }
            };
        }
    });

    try {
        assert.equal(await manager.sendPresence(instanceId, '77000000001', 'read'), true);
        assert.equal(await manager.sendPresence(instanceId, '77000000001'), true);
        assert.deepEqual(calls, ['seen', 'typing']);
    } finally {
        manager.clients.delete(instanceId);
        wa.clearJidMap();
    }
});

test('the single-QR transport never advertises a second call-watcher code', () => {
    wa.callWatcherQrs.set('baileys-tenant', { qr: 'x', at: Date.now() });
    try {
        assert.equal(wa.getCallWatcherQr('baileys-tenant'), null);
    } finally {
        wa.callWatcherQrs.delete('baileys-tenant');
    }
});

test('the facade tells the onboarding pages which tenants need one scan', () => {
    assert.equal(manager.usesSingleQr('fresh-tenant'), true);
    wa.instanceTransports.set('pinned-tenant', 'wwebjs');
    try {
        assert.equal(manager.usesSingleQr('pinned-tenant'), false);
        assert.equal(manager.activeTransport('pinned-tenant'), 'wwebjs');
    } finally {
        wa.instanceTransports.delete('pinned-tenant');
    }
});

test('a Baileys client between reconnects is starting, not a health failure', async () => {
    const instanceId = 'health-tenant';
    // A dead socket that still remembers who it is must not read as connected,
    // and a reconnecting one must not be counted against the restart budget.
    manager.clients.set(instanceId, {
        async getState() { return null; },
        info: { wid: { _serialized: '77000000001@c.us' } }
    });
    try {
        const status = await manager.getInstanceStatus(instanceId);
        assert.equal(status.status, 'starting');
    } finally {
        manager.clients.delete(instanceId);
    }
});

test('the single-QR connect flow is server-side, so the page needs no second step', async () => {
    const server = await fs.promises.readFile(
        path.join(__dirname, '..', 'src', 'server.js'), 'utf8'
    );
    assert.match(server, /usesSingleQr/);
    // The call-watcher route stays reachable for back-compat and for a tenant
    // pinned to Chromium, which genuinely still needs a second linked device.
    assert.match(server, /call-watcher/);
    const page = await fs.promises.readFile(
        path.join(__dirname, '..', 'public', 'connect.js'), 'utf8'
    );
    assert.match(page, /callsConnected/);
});

test('the source keeps a rollback path to the Chromium transport', async () => {
    const source = await fs.promises.readFile(
        path.join(__dirname, '..', 'services', 'whatsappManager.js'), 'utf8'
    );
    assert.match(source, /WHATSPRO_TRANSPORT/);
    assert.match(source, /WHATSPRO_WWEBJS_INSTANCES/);
    // whatsapp-web.js must not be pulled in at require time, or every boot still
    // pays for puppeteer even when no tenant uses it.
    assert.doesNotMatch(source, /^const \{ Client, LocalAuth, MessageMedia \} = require\('whatsapp-web\.js'\)/m);
    assert.match(source, /function loadWwebjs/);
    assert.ok(os.platform());
});

test('the rollback path keeps the pieces it needs to actually come up', async () => {
    // Baileys has no stable release -- npm's `latest` is a release candidate --
    // so the Chromium transport is kept as insurance against Baileys-specific
    // breakage. Insurance rots quietly: a dependency dropped in a cleanup, a
    // browser removed from the image, and the rollback is a rollback on paper
    // only. Each assertion below is a thing whose removal would break it.
    const root = path.join(__dirname, '..');
    const manifest = JSON.parse(await fs.promises.readFile(path.join(root, 'package.json'), 'utf8'));
    for (const dependency of ['whatsapp-web.js', 'puppeteer', '@wppconnect/wa-js']) {
        assert.ok(manifest.dependencies?.[dependency], `${dependency} is part of the rollback path`);
    }
    assert.ok(manifest.scripts?.['verify:rollback'], 'the rollback must stay checkable from inside the container');

    const dockerfile = await fs.promises.readFile(path.join(root, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^\s+chromium\s*\\?$/m, 'the image must still install a browser');
    // Debian installs /usr/bin/chromium and has never shipped
    // /usr/bin/chromium-browser. Pointing the variable at the latter is the bug
    // this pins shut; anything launching puppeteer without an explicit path
    // (scripts/browser-qa.js) depends on it being right.
    assert.match(dockerfile, /PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium(?![-\w])/);
    assert.doesNotMatch(dockerfile, /PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium-browser/);
});
