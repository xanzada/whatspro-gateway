'use strict';

const axios = require('axios');
const tenantStore = require('./tenantStore');

async function migrateNocoDbTenantsOnce() {
  const summary = await tenantStore.getStorageSummary();
  if (summary.tenants > 0) return { imported: 0, skipped: true, existing: summary.tenants };

  const base = String(process.env.NOCODB_URL || '').replace(/\/+$/, '');
  const table = String(process.env.NOCODB_RESTAURANTS_TABLE_ID || process.env.NOCODB_TABLE_ID || '').trim();
  const token = String(process.env.NOCODB_TOKEN || '').trim();
  if (!base || !table || !token) {
    console.warn('[TENANT MIGRATION] platform store is empty and legacy NocoDB settings are unavailable');
    return { imported: 0, skipped: true, existing: 0 };
  }

  const response = await axios.get(`${base}/api/v2/tables/${table}/records`, {
    headers: { 'xc-token': token },
    params: { limit: 1000 },
    timeout: Number(process.env.NOCODB_TIMEOUT_MS || 8000)
  });
  const rows = Array.isArray(response.data?.list) ? response.data.list : [];
  const result = await tenantStore.importRowsIfEmpty(rows);
  console.log(`[TENANT MIGRATION] imported=${result.imported} existing=${result.existing}`);
  return result;
}

module.exports = { migrateNocoDbTenantsOnce };
