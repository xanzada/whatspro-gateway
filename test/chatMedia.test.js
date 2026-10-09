'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { createChatMediaHandler, decodeAudioDataUri, decodeImageDataUri, decodeDocumentDataUri } = require('../services/chatMedia');
const { MAX_MEDIA_BYTES } = require('../services/chatStore');

function fakeRes() {
  return {
    headers: {},
    statusCode: 0,
    body: null,
    set(name, value) { if (typeof name === 'string') { this.headers[name] = value; return this; } Object.assign(this.headers, name); return this; },
    status(code) { this.statusCode = code; return this; },
    send(b) { this.body = b; return this; },
    json(o) { this.jsonBody = o; return this; },
    sendFile() { return this; },
  };
}

test('a stored PDF is served inline without a viewer-blocking sandbox header', async () => {
  // A bare `Content-Security-Policy: sandbox` made browsers block their own
  // built-in PDF viewer, so the operator's receipt "would not open".
  const pdfBytes = Buffer.from('%PDF-1.4 fake minimal receipt pdf for the test %%EOF');
  const handler = createChatMediaHandler({
    readMedia: async () => 'data:application/pdf;base64,' + pdfBytes.toString('base64'),
  });
  const res = fakeRes();
  await handler({ params: { instanceId: 'prestige', messageId: 'm1' }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(String(res.headers['Content-Disposition']), /^inline/);
  assert.equal(res.headers['Content-Security-Policy'], undefined);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.length, pdfBytes.length);
});

test('a missing media blob answers 404 MEDIA_NOT_READY with a retry hint', async () => {
  const handler = createChatMediaHandler({ readMedia: async () => '' });
  const res = fakeRes();
  await handler({ params: { instanceId: 'prestige', messageId: 'gone' }, query: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.jsonBody.error, 'MEDIA_NOT_READY');
  assert.equal(res.headers['Retry-After'], '3');
});

test('all decoded media use the common 64MiB resource bound rather than smaller product caps', () => {
  assert.equal(MAX_MEDIA_BYTES,64*1024*1024);
  const audio=Buffer.alloc(26*1024*1024); audio.write('ID3');
  assert.equal(decodeAudioDataUri('data:audio/mpeg;base64,'+audio.toString('base64')).buffer.length,audio.length);
  const image=Buffer.alloc(6*1024*1024); image[0]=0xff;image[1]=0xd8;image[2]=0xff;
  assert.equal(decodeImageDataUri('data:image/jpeg;base64,'+image.toString('base64')).buffer.length,image.length);
  const pdf=Buffer.alloc(17*1024*1024);pdf.write('%PDF-1.4');
  assert.equal(decodeDocumentDataUri('data:application/pdf;base64,'+pdf.toString('base64')).buffer.length,pdf.length);
});

test('audio format and signature validation remain enforced', () => {
  assert.throws(()=>decodeAudioDataUri('data:audio/mpeg;base64,%%%'),/INVALID_AUDIO_BASE64/);
  assert.throws(()=>decodeAudioDataUri('data:audio/ogg;base64,'+Buffer.alloc(96).toString('base64')),/INVALID_OGG_OPUS/);
});

test('the configured common resource bound controls each decoder in a fresh module', () => {
  const script=`
    const assert=require('node:assert/strict');
    const {MAX_MEDIA_BYTES}=require('./services/chatStore');
    const {decodeAudioDataUri,decodeImageDataUri,decodeDocumentDataUri}=require('./services/chatMedia');
    assert.equal(MAX_MEDIA_BYTES,2048);
    for(const [mime,decode,header] of [['audio/mpeg',decodeAudioDataUri,'ID3'],['image/jpeg',decodeImageDataUri,null],['application/pdf',decodeDocumentDataUri,'%PDF-']]){
      const valid=Buffer.alloc(2048);
      if(header)valid.write(header);else{valid[0]=0xff;valid[1]=0xd8;valid[2]=0xff;}
      assert.equal(decode('data:'+mime+';base64,'+valid.toString('base64')).buffer.length,2048);
      const over=Buffer.concat([valid,Buffer.alloc(1)]);
      assert.throws(()=>decode('data:'+mime+';base64,'+over.toString('base64')));
    }
  `;
  const child=spawnSync(process.execPath,['-e',script],{cwd:process.cwd(),env:{...process.env,MAX_MEDIA_BYTES:'2048'},encoding:'utf8'});
  assert.equal(child.status,0,'fresh-module resource assertion failed');
});
