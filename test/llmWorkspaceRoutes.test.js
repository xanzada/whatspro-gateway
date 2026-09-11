'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', 'public', 'tenants.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'tenants.css'), 'utf8');

test('LLM workspace exposes health, manual check, and strict runtime outcome routes', () => {
  assert.match(server, /app\.get\('\/api\/wa\/llm-workspace\/health', requirePlatformAdmin/);
  assert.match(server, /app\.post\('\/api\/wa\/llm-workspace\/check', requirePlatformAdmin/);
  assert.match(server, /app\.post\('\/api\/wa\/llm-workspace\/outcomes', requirePlatformAdmin/);
  assert.match(server, /validateOutcomePayload\(req\.body\)/);
});

test('panel visibly separates text and media and refreshes sanitized health while visible', () => {
  assert.match(panel, /ak-pools-stack/);
  assert.match(panel, /ak-health-dot/);
  assert.match(panel, /data-action="ak-check"/);
  assert.match(panel, /\/api\/wa\/llm-workspace\/health/);
  assert.match(panel, /document\.hidden/);
  assert.match(css, /\.ak-health-dot\.healthy/);
  assert.match(css, /\.ak-pools-stack/);
});

test('outcome endpoint enforces auth, field allowlist, known ids and sanitized output', async t => {
  const token = 'llm-route-master-token-that-is-long-enough';
  const previousToken = process.env.WHATSPRO_API_TOKEN;
  process.env.WHATSPRO_API_TOKEN = token;
  const llmWorkspace = require('../services/llmWorkspace');
  const originalGetWorkspace = llmWorkspace.getWorkspace;
  llmWorkspace.getWorkspace = async () => ({
    text: [{
      id: 'llm_known_1234567890123456', name: 'Known', type: 'openai',
      baseUrl: 'https://provider.invalid/v1', model: 'model', key: 'never-return-this-key'
    }],
    media: []
  });
  const { app } = require('../src/server');
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { listener.once('listening', resolve); listener.once('error', reject); });
  t.after(async () => {
    llmWorkspace.getWorkspace = originalGetWorkspace;
    if (previousToken === undefined) delete process.env.WHATSPRO_API_TOKEN;
    else process.env.WHATSPRO_API_TOKEN = previousToken;
    await new Promise(resolve => listener.close(resolve));
  });
  const url = `http://127.0.0.1:${listener.address().port}/api/wa/llm-workspace/outcomes`;
  const post = (body, authenticated = true) => fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });

  assert.equal((await post({ entryId: 'llm_known_1234567890123456', pool: 'text', ok: true }, false)).status, 401);
  assert.equal((await post({ entryId: 'llm_known_1234567890123456', pool: 'text', ok: false, key: 'leak' })).status, 400);
  assert.equal((await post({ entryId: 'llm_unknown_12345678901234', pool: 'text', ok: true })).status, 404);
  const accepted = await post({
    entryId: 'llm_known_1234567890123456', pool: 'text', ok: false,
    latencyMs: 12, errorCode: 'provider 402: raw message', observedAt: new Date().toISOString()
  });
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.equal(payload.result.errorCode, 'PAYMENT_REQUIRED');
  assert.equal(JSON.stringify(payload).includes('never-return-this-key'), false);
});
