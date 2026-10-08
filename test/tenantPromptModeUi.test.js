"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tenantAdmin = require('../services/tenantAdmin');
const tenantStore = require('../services/tenantStore');

// Execute the actual wizard/render/capture/request functions. Only the DOM and
// transport are fake; no app startup, browser profile, credentials or HTTP.
function createUi(rows = []) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'tenants.js'), 'utf8');
  const start = source.indexOf('  function wizardSteps(');
  const end = source.indexOf('  function openAlemiSecret(', start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const modal = { inputs: [], html: '', onclick: null };
  const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const encode = text => String(text ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function render(html) {
    modal.html = html;
    modal.inputs = [...html.matchAll(/<input\b([^>]*)>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)].map(match => {
      const attrs = match[1] || match[2];
      const read = name => decode((attrs.match(new RegExp('\\b' + name + '="([^"]*)"')) || [])[1] || '');
      return { name: read('name'), type: read('type'), id: read('id'),
        value: match[1] ? read('value') : decode(match[3]), checked: /\bchecked\b/.test(attrs),
        focus() {}, closest() { return { classList: { add() {} } }; } };
    });
  }
  const settings = new Map(rows.map(row => [row.instanceId, row]));
  const context = {
    modalRoot: modal, settings, report: { tenants: rows.map(row => ({ ...row, virtual: false })) },
    defaults: { workHours: '09:00 - 23:00', domainSuffix: '' },
    $: selector => modal.inputs.find(input => selector === '[name="' + input.name + '"]'),
    $$: (selector, root) => { assert.equal(selector, 'input, textarea'); assert.equal(root, modal); return modal.inputs; },
    modalHeader: () => '', replaceModal: render, t: key => key, escapeHtml: encode, attr: encode,
    secretActions: () => '', slugify: value => String(value).toLowerCase().replace(/\s+/g, '-'),
    toast() {}, closeModal() {}, loadData: async () => {},
    secretErrorMessage: error => error.message,
    api(method, url, payload) {
      requests.push({ method, url, payload: payload && JSON.parse(JSON.stringify(payload)) });
      if (method === 'GET' && url.endsWith('/alemi-secret')) return Promise.resolve({ secret: '' });
      if (method === 'GET' && url === '/api/wa/instances') return Promise.resolve(rows);
      return Promise.resolve({ instanceId: payload && payload.instanceId });
    },
    normalizeInstances: data => data
  };
  vm.runInNewContext(source.slice(start, end), context, { timeout: 1000, filename: 'actual-tenants-wizard.js' });
  return {
    ...context, requests, modal,
    set(name, value) { const input = modal.inputs.find(item => item.name === name); assert.ok(input, name); input.value = value; },
    click(direction = 'next') {
      const button = { disabled: false };
      modal.onclick({ target: { closest: selector => selector === '[data-wizard-' + direction + ']' ? button : null } });
    },
    mutation() { return requests.find(request => request.method === 'PATCH' || request.method === 'POST'); }
  };
}
const drain = () => new Promise(resolve => setImmediate(resolve));
function row(instanceId, promptMode, systemPrompt) {
  return { instanceId, brand: 'Synthetic ' + instanceId, promptMode, systemPrompt,
    address: '', domain: '', whatsappPhone: '', workHours: '09:00 - 23:00',
    alemiInstance: instanceId, alemiApiUrl: 'https://synthetic.example.invalid', alemiSecretSet: true, secrets: { alemiSecret: true } };
}
async function edit(ui, id, prompt) {
  ui.openEdit(id);
  await drain();
  ui.set('address', 'Updated unrelated address');
  ui.click(); ui.click();
  if (prompt !== undefined) ui.set('systemPrompt', prompt);
  ui.click(); ui.click();
  await drain();
  return ui.mutation().payload;
}

test('shared resolved text stays shared after an unrelated edit and remains eligible for future shared updates', async t => {
  const ui = createUi([row('alpha', 'shared', 'Shared version one')]);
  const payload = await edit(ui, 'alpha');
  assert.equal(payload.promptMode, 'shared');
  assert.equal(payload.systemPrompt, 'Shared version one');
  assert.equal(payload.address, 'Updated unrelated address');
  const records = new Map([['alpha', { instance_id: 'alpha', brand: 'Synthetic alpha', prompt_mode: 'shared', system_prompt: 'Shared version one' }]]);
  const original = { findRow: tenantStore.findRow, listTenantRecords: tenantStore.listTenantRecords, updateRow: tenantStore.updateRow };
  tenantStore.findRow = async id => records.get(id);
  tenantStore.listTenantRecords = async () => [...records.values()];
  tenantStore.updateRow = async (id, patch) => records.set(id, { ...records.get(id), ...patch });
  t.after(() => Object.assign(tenantStore, original));
  await tenantAdmin.updateTenant('alpha', payload, { sharedPrompt: 'Shared version two' });
  assert.equal(records.get('alpha').prompt_mode, 'shared');
  assert.equal(records.get('alpha').system_prompt, 'Shared version two', 'shared save uses current server default, not stale textarea text');
  const applied = await tenantAdmin.applySharedPrompt('Shared version three');
  assert.equal(applied.applied, 1);
  assert.equal(records.get('alpha').system_prompt, 'Shared version three');
});

test('editing shared text makes this restaurant custom', async () => {
  const payload = await edit(createUi([row('alpha', 'shared', 'Shared text')]), 'alpha', 'Own restaurant instructions');
  assert.equal(payload.promptMode, 'custom');
  assert.equal(payload.systemPrompt, 'Own restaurant instructions');
});

test('an unchanged custom prompt remains custom even when equal to the shared text', async () => {
  assert.equal((await edit(createUi([row('alpha', 'custom', 'Shared text')]), 'alpha')).promptMode, 'custom');
});

test('an unchanged empty custom prompt preserves the explicit legacy mode', async () => {
  assert.equal((await edit(createUi([row('alpha', 'custom', '')]), 'alpha')).promptMode, 'custom');
});

test('clearing custom text selects the documented shared default', async () => {
  const payload = await edit(createUi([row('alpha', 'custom', 'Own text')]), 'alpha', '  \n  ');
  assert.equal(payload.promptMode, 'shared');
  assert.equal(tenantAdmin.__test.resolvePrompt({ prompt_mode: payload.promptMode }, payload, 'Current shared'), 'Current shared');
});

test('normal browser CRLF normalization and outer whitespace do not convert shared to custom', async () => {
  const payload = await edit(createUi([row('alpha', 'shared', '  First\r\nSecond  ')]), 'alpha', 'First\nSecond');
  assert.equal(payload.promptMode, 'shared');
});

test('changing then restoring shared text across back navigation preserves shared mode', async () => {
  const ui = createUi([row('alpha', 'shared', 'Original shared')]);
  ui.openWizard(row('alpha', 'shared', 'Original shared'));
  ui.click(); ui.click();
  ui.set('systemPrompt', 'Temporary edit'); ui.click(); ui.click('back');
  ui.set('systemPrompt', 'Original shared'); ui.click(); ui.click(); await drain();
  assert.equal(ui.mutation().payload.promptMode, 'shared');
});

test('editing an existing wizard does not leak its prompt mode into another restaurant', async () => {
  const ui = createUi([row('alpha', 'custom', 'Alpha only'), row('beta', 'shared', 'Shared beta')]);
  await edit(ui, 'alpha', 'Alpha replacement');
  ui.requests.length = 0;
  const payload = await edit(ui, 'beta');
  assert.equal(payload.promptMode, 'shared');
  assert.equal(payload.systemPrompt, 'Shared beta');
  assert.equal(ui.mutation().url, '/api/wa/tenants/beta');
});

for (const [prompt, expected] of [['', 'shared'], ['New individual text', 'custom']]) {
  test('a new restaurant uses ' + expected + ' mode for its own entered text', async () => {
    const ui = createUi();
    ui.openWizard(); ui.set('brand', 'New Synthetic'); ui.click(); ui.click();
    ui.set('systemPrompt', prompt); ui.set('alemiSecret', 'synthetic-test-only');
    ui.click(); ui.set('startNow', '');
    ui.modal.inputs.find(input => input.name === 'startNow').checked = false;
    ui.click(); await drain();
    assert.equal(ui.mutation().payload.promptMode, expected);
    assert.equal(ui.mutation().url, '/api/wa/tenants');
    assert.equal(ui.requests.some(request => request.url === '/api/wa/start'), false);
  });
}

for (const mode of ['shared', 'custom']) {
  test('duplicating ' + mode + ' restaurant text preserves its explicit mode', async () => {
    const ui = createUi([row('alpha', mode, 'Visible source prompt')]);
    ui.openDuplicate('alpha'); ui.click(); ui.click();
    ui.set('alemiSecret', 'synthetic-clone-only'); ui.click();
    ui.modal.inputs.find(input => input.name === 'startNow').checked = false;
    ui.click(); await drain();
    assert.equal(ui.mutation().payload.promptMode, mode);
    assert.equal(ui.mutation().url, '/api/wa/tenants/alpha/clone');
  });
}

test('the actual prompt textarea exposes the same 20000 UTF-16 length limit as server normalization', () => {
  const ui = createUi(); ui.openWizard(row('alpha', 'shared', 'Shared'));
  ui.click(); ui.click();
  assert.match(ui.modal.html, /<textarea\b[^>]*id="wizard-prompt"[^>]*maxlength="20000"/);
  assert.equal(tenantAdmin.__test.resolvePrompt({ prompt_mode: 'custom' }, { systemPrompt: 'x'.repeat(20001) }, '').length, 20000);
});
