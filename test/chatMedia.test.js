const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const puppeteer = require('puppeteer');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createChatMediaHandler } = require('../services/chatMedia');

function oggCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function oggPage({ type, granule, serial, sequence, packet }) {
  const segments = [];
  for (let remaining = packet.length; remaining >= 255; remaining -= 255) segments.push(255);
  segments.push(packet.length % 255);
  const page = Buffer.alloc(27 + segments.length + packet.length);
  page.write('OggS', 0, 'ascii');
  page[4] = 0;
  page[5] = type;
  page.writeBigUInt64LE(BigInt(granule), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(sequence, 18);
  page[26] = segments.length;
  segments.forEach((size, index) => { page[27 + index] = size; });
  packet.copy(page, 27 + segments.length);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

function validOggOpus() {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48000, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  const vendor = Buffer.from('WhatsPro test', 'utf8');
  const tags = Buffer.alloc(16 + vendor.length);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  const serial = 0x5750524f;
  return Buffer.concat([
    oggPage({ type: 2, granule: 0, serial, sequence: 0, packet: head }),
    oggPage({ type: 0, granule: 0, serial, sequence: 1, packet: tags }),
    oggPage({ type: 4, granule: 960, serial, sequence: 2, packet: Buffer.from([0xf8, 0xff, 0xfe]) })
  ]);
}

function assertOggChecksums(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    assert.equal(buffer.subarray(offset, offset + 4).toString('ascii'), 'OggS');
    const segmentCount = buffer[offset + 26];
    let bodyLength = 0;
    for (let index = 0; index < segmentCount; index += 1) bodyLength += buffer[offset + 27 + index];
    const pageLength = 27 + segmentCount + bodyLength;
    const page = Buffer.from(buffer.subarray(offset, offset + pageLength));
    const expected = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    assert.equal(oggCrc(page), expected);
    offset += pageLength;
  }
  assert.equal(offset, buffer.length);
}

test('media endpoint serves valid Ogg Opus with compliant byte ranges and browser decoding', async t => {
  const fixture = validOggOpus();
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whatspro-media-test-'));
  t.after(async () => fs.rm(cacheDir, { recursive: true, force: true }));
  const dataUri = `data:audio/ogg;base64,${fixture.toString('base64')}`;
  const app = express();
  app.get('/api/chat/media/:instanceId/:messageId', createChatMediaHandler({
    cacheDir,
    readMedia: async () => dataUri
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/chat/media/prestige/audio-1`;

  const full = await fetch(url);
  const fullBody = Buffer.from(await full.arrayBuffer());
  assert.equal(full.status, 200);
  assert.match(full.headers.get('content-type') || '', /^audio\/ogg\b/);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(full.headers.get('content-length')), fixture.length);
  assert.deepEqual(fullBody, fixture);
  assert.equal(fullBody.subarray(0, 4).toString('ascii'), 'OggS');
  assert.notEqual(fullBody.indexOf('OpusHead'), -1);
  assert.notEqual(fullBody.indexOf('OpusTags'), -1);
  assertOggChecksums(fullBody);

  const partial = await fetch(url, { headers: { Range: 'bytes=0-27' } });
  const partialBody = Buffer.from(await partial.arrayBuffer());
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-27/${fixture.length}`);
  assert.equal(partial.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(partial.headers.get('content-length')), 28);
  assert.deepEqual(partialBody, fixture.subarray(0, 28));

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const result = await page.evaluate(async mediaUrl => {
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.src = mediaUrl;
    document.body.append(audio);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), 5000);
      audio.addEventListener('canplay', async () => {
        clearTimeout(timer);
        try {
          await audio.play();
          resolve({ ok: true, duration: audio.duration });
        } catch (error) {
          resolve({ ok: false, reason: error.name });
        }
      }, { once: true });
      audio.addEventListener('error', () => { clearTimeout(timer); resolve({ ok: false, code: audio.error && audio.error.code }); }, { once: true });
      audio.load();
    });
  }, url);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(Number.isFinite(result.duration) && result.duration > 0);
});
