const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const tenantWorkbook = require('../services/tenantWorkbook');

function tenant(overrides = {}) {
  return {
    instance_id: 'demo-point',
    brand: 'Demo Point',
    whatsapp_phone: '+77000000000',
    admin_phone: '+77000000000',
    domain: 'https://demo.example.com',
    address: 'Almaty',
    work_hours: '09:00 - 23:00',
    prompt_mode: 'custom',
    system_prompt: 'Helpful assistant',
    active: true,
    bot_enabled: false,
    whatspro_api_token: 'wp_secret',
    webhook_secret: 'hook_secret',
    kanban_secret: 'kanban_secret',
    crm_secret_token: 'crm_secret',
    whatspro_base_url: 'https://whatspro.example.com',
    whatspro_send_url: 'https://whatspro.example.com/api/send',
    whatspro_presence_url: 'https://whatspro.example.com/api/presence',
    dev_phone: '+77476884956',
    created_at: '2026-07-29T00:00:00.000Z',
    updated_at: '2026-07-29T00:00:00.000Z',
    future_field: 'preserved',
    ...overrides
  };
}

test('tenant workbook round-trips business data without platform secrets', async () => {
  const file = await tenantWorkbook.exportWorkbook([tenant()], 'all');
  assert.ok(file.length > 1000);
  const generated = new ExcelJS.Workbook();
  await generated.xlsx.load(file);
  const visibleValues = JSON.stringify(generated.getWorksheet('Entities').getSheetValues());
  assert.doesNotMatch(visibleValues, /wp_secret|hook_secret|kanban_secret|crm_secret|record_json/);
  const restored = await tenantWorkbook.importWorkbook(file);
  assert.equal(restored.scope, 'all');
  assert.equal(restored.rows.length, 1);
  assert.equal(restored.rows[0].instance_id, 'demo-point');
  assert.equal(restored.rows[0].bot_enabled, false);
  assert.equal(restored.rows[0].brand, 'Demo Point');
  assert.equal(restored.rows[0].system_prompt, 'Helpful assistant');
  assert.equal(restored.rows[0].whatspro_api_token, undefined);
  assert.equal(restored.rows[0].future_field, undefined);
});

test('tenant workbook rejects duplicate instance ids', async () => {
  const file = await tenantWorkbook.exportWorkbook([
    tenant(),
    tenant({ brand: 'Duplicate' })
  ], 'all');
  await assert.rejects(() => tenantWorkbook.importWorkbook(file), /DUPLICATE_INSTANCE_ID/);
});

test('tenant workbook rejects formulas in tenant data', async () => {
  const file = await tenantWorkbook.exportWorkbook([tenant()], 'single');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  workbook.getWorksheet('Entities').getCell('B6').value = { formula: 'HYPERLINK("https://example.com")', result: 'Demo' };
  const malicious = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(() => tenantWorkbook.importWorkbook(malicious), /FORMULA_NOT_ALLOWED/);
});

test('generated workbook has readable sheets and keeps metadata hidden', async () => {
  const file = await tenantWorkbook.exportWorkbook([tenant()], 'single');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  assert.equal(workbook.getWorksheet('README').views[0].showGridLines, false);
  assert.equal(workbook.getWorksheet('Entities').views[0].state, 'frozen');
  assert.equal(workbook.getWorksheet('_BackupMeta').state, 'veryHidden');
  const headers = workbook.getWorksheet('Entities').getRow(5).values.slice(1);
  assert.deepEqual(headers, tenantWorkbook.COLUMNS.map(([key]) => key));
  assert.ok(!headers.includes('whatspro_api_token'));
  assert.ok(!headers.includes('record_json'));
});
