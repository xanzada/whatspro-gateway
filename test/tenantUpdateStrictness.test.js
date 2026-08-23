'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// C23, found 2026-08-23: PATCH /api/wa/tenants/kabab-1 with {"alemi_instance":"kebab1"}
// answered {"success":true,"updated":true} and changed nothing. The update whitelist is
// camelCase (OPERATOR_FIELDS -> alemiInstance), so the snake_case body fell through
// mergeExisting untouched - a green tick over silent data loss, which is how the
// kabab1/kebab1 typo survived for days.

const tenantAdmin = require('../services/tenantAdmin.js');
const { rejectedFieldNames } = tenantAdmin.__test;

test('recognisable snake_case spellings are caught, with the right name suggested', () => {
  assert.deepEqual(rejectedFieldNames({ alemi_instance: 'kebab1' }), [
    { sent: 'alemi_instance', expected: 'alemiInstance' },
  ]);
  // Several at once, every one of them named. Order follows the alias table, not the
  // request body, so compare as a set.
  assert.deepEqual(
    rejectedFieldNames({ whatsapp_phone: '+7', bot_enabled: true, work_hours: '10-22' })
      .map((e) => e.expected)
      .sort(),
    ['botEnabled', 'whatsappPhone', 'workHours']
  );
});

test('the whitelisted camelCase fields themselves are never flagged', () => {
  const body = {
    brand: 'Kebab',
    domain: 'kebab1.alemi.kz',
    alemiInstance: 'kebab1',
    alemiApiUrl: 'https://hub.alemi.kz',
    active: true,
    botEnabled: false,
  };
  assert.deepEqual(rejectedFieldNames(body), []);
});

test('unrelated metadata keys stay ignored, so existing callers keep working', () => {
  assert.deepEqual(rejectedFieldNames({ source: 'hub-link', requestId: 42, note: 'x' }), []);
  assert.deepEqual(rejectedFieldNames({}), []);
});

test('both create and update reject misnamed fields before touching the row', async () => {
  const source = await readFile(new URL('../services/tenantAdmin.js', `file://${__filename}`), 'utf8');
  // The guard must run at the top of both write paths.
  const createBody = source.slice(source.indexOf('async function createTenant'));
  createBody.slice(0, createBody.indexOf('\n}')).includes('rejectedFieldNames(input)');
  assert.ok(
    /async function createTenant[^]*?rejectedFieldNames\(input\)[^]*?unknownFieldError/.test(source),
    'createTenant must reject misnamed input'
  );
  const updateBody = source.slice(source.indexOf('async function updateTenant'));
  assert.ok(
    updateBody.slice(0, updateBody.indexOf('\n}\n\nasync function reconcile')).includes('rejectedFieldNames(input)'),
    'updateTenant must reject misnamed input'
  );
});

test('the rejection is a 400 naming the correct spelling', async () => {
  const source = await readFile(new URL('../services/tenantAdmin.js', `file://${__filename}`), 'utf8');
  assert.match(source, /TENANT_FIELD_NAME_INVALID/);
  assert.match(source, /statusCode = 400;/);
  assert.match(source, /rename to \$\{entry\.expected\}/);
});
