'use strict';

// One PDF receipt walked through every layer it actually crosses in production:
// the ingestion predicates that decide whether WhatsApp media is downloaded at
// all, the byte validator, the chat store, the HTTP media handler the operator's
// browser calls, and the classifier that turns a stored message into a bubble.
// The unit tests cover these individually; this one proves they still line up.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { __test: whatsappTest } = require('../services/whatsappManager');
const { __test: webhookTest } = require('../services/incomingWebhook');
const { createChatStore } = require('../services/chatStore');
const { createChatMediaHandler } = require('../services/chatMedia');
const core = require('../public/chat-core');

// Only the handful of commands storeMedia/readMedia issue.
class MediaRedis {
  constructor() {
    this.data = new Map();
    this.expires = new Map();
    this.isOpen = true;
  }

  async sendCommand(args) {
    const command = String(args[0]).toUpperCase();
    const key = args[1];
    if (command === 'SET') {
      this.data.set(key, args[2]);
      const ex = args.indexOf('EX');
      if (ex >= 0) this.expires.set(key, Number(args[ex + 1]));
      return 'OK';
    }
    if (command === 'GET') return this.data.get(key) ?? null;
    if (command === 'SADD') {
      const set = this.data.get(key) instanceof Set ? this.data.get(key) : new Set();
      set.add(args[2]);
      this.data.set(key, set);
      return 1;
    }
    if (command === 'EXPIRE') {
      this.expires.set(key, Number(args[2]));
      return 1;
    }
    return null;
  }
}

test('a mime-less Kaspi PDF survives ingestion, storage, serving and rendering', async t => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF');
  const base64 = pdf.toString('base64');
  const instanceId = 'prestige';
  const phone = '77015550101';
  const messageId = 'PDFRECEIPT1';

  // 1. WhatsApp hands over a document with no mimetype whatsoever.
  const msg = { hasMedia: true, type: 'document', id: { id: messageId } };
  assert.equal(whatsappTest.isChatMediaCandidate(msg), true, 'the receipt must be downloaded, not skipped');
  assert.equal(whatsappTest.isQualifiedDocument(msg), true);
  assert.equal(whatsappTest.isQualifiedAudio(msg, { mimetype: 'application/pdf' }), false);
  assert.equal(whatsappTest.isQualifiedImage(msg, { mimetype: 'application/pdf' }), false);

  // 2. The downloaded bytes decide the type the declaration never carried.
  assert.equal(whatsappTest.validateDocumentBase64(base64), base64);

  // 3. The history entry must advertise the media, or the bubble never renders
  // even though the bytes are sitting in the store.
  const entry = webhookTest.buildHistoryEntry(
    { messageId, type: 'document', hasMedia: true, mediaType: 'application/pdf', mediaData: base64, body: 'Чек' },
    instanceId,
    phone,
    1785083964000
  );
  assert.equal(entry.hasMedia, true);
  assert.equal(entry.mediaType, 'application/pdf');
  assert.equal(entry.mediaData, base64);

  // A document WhatsApp never typed still lands as a PDF.
  const untyped = webhookTest.buildHistoryEntry(
    { messageId, type: 'document', hasMedia: true, mediaData: base64 },
    instanceId,
    phone,
    1785083964000
  );
  assert.equal(untyped.hasMedia, true);
  assert.equal(untyped.mediaType, 'application/pdf');

  // 4. The store keeps it verbatim under its real mime.
  const redis = new MediaRedis();
  const store = createChatStore(redis);
  assert.equal(await store.storeMedia(instanceId, phone, messageId, base64, 'application/pdf'), true);
  const stored = await store.readMedia(instanceId, messageId);
  assert.equal(stored, `data:application/pdf;base64,${base64}`);

  // 5. The operator's browser fetches it over the real handler.
  const app = express();
  app.get('/api/chat/media/:instanceId/:messageId', createChatMediaHandler({
    readMedia: (instance, id) => store.readMedia(instance, id)
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/media/${instanceId}/${messageId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  // No CSP sandbox header: a bare sandbox directive makes the browser block
  // its own built-in PDF viewer - the receipt "would not open" (2026-08-20).
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const delivered = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(delivered, pdf, 'the operator receives the exact bytes the customer sent');
  assert.equal(delivered.subarray(0, 5).toString('ascii'), '%PDF-');

  // 6. The renderer turns that stored entry into a document bubble.
  assert.deepEqual(core.messageParts(entry), [
    { kind: 'text', text: 'Чек' },
    { kind: 'document', id: messageId }
  ]);
});
