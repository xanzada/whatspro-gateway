'use strict';

const ExcelJS = require('exceljs');

const FORMAT_NAME = 'WhatsProTenantBackup';
const FORMAT_VERSION = 2;
const MAX_ROWS = 5000;
const MAX_CELL_CHARS = 50000;

const COLUMNS = [
  ['instance_id', 'Instance ID', 26],
  ['brand', 'Нысан / Точка', 28],
  ['whatsapp_phone', 'WhatsApp', 20],
  ['admin_phone', 'Админ телефоны', 20],
  ['domain', 'Домен', 34],
  ['address', 'Мекенжай / Адрес', 34],
  ['work_hours', 'Жұмыс уақыты', 18],
  ['prompt_mode', 'Prompt режимі', 16],
  ['system_prompt', 'AI prompt', 48],
  ['active', 'Белсенді', 12],
  ['bot_enabled', 'Бот қосулы', 12]
];

const BOOLEAN_FIELDS = new Set(['active', 'bot_enabled']);
const REQUIRED_FIELDS = ['instance_id', 'brand'];

function safeFilename(value) {
  return String(value || 'all')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'all';
}

function scalar(value, field) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.formula !== undefined || value.sharedFormula !== undefined) {
      const error = new Error(`FORMULA_NOT_ALLOWED:${field}`);
      error.statusCode = 400;
      throw error;
    }
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('');
    if (value.text !== undefined) return String(value.text);
    const error = new Error(`UNSUPPORTED_CELL:${field}`);
    error.statusCode = 400;
    throw error;
  }
  const text = String(value);
  if (text.length > MAX_CELL_CHARS) {
    const error = new Error(`CELL_TOO_LARGE:${field}`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function parseBoolean(value, field) {
  if (typeof value === 'boolean') return value;
  const normalized = scalar(value, field).trim().toLowerCase();
  if (['true', '1', 'yes', 'иә', 'да'].includes(normalized)) return true;
  if (['false', '0', 'no', 'жоқ', 'нет', ''].includes(normalized)) return false;
  const error = new Error(`INVALID_BOOLEAN:${field}`);
  error.statusCode = 400;
  throw error;
}

function styleWorkbook(workbook, rows, scope) {
  workbook.creator = 'WhatsPro';
  workbook.created = new Date();
  workbook.modified = new Date();

  const readme = workbook.addWorksheet('README', { views: [{ showGridLines: false }] });
  readme.mergeCells('A1:F1');
  readme.getCell('A1').value = 'WhatsPro — резервтік көшірме / резервная копия';
  readme.getCell('A1').font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  readme.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  readme.getCell('A1').alignment = { vertical: 'middle' };
  readme.getRow(1).height = 34;
  readme.getCell('A3').value = 'ҚАУІПСІЗ ҚАЛПЫНА КЕЛТІРУ / БЕЗОПАСНОЕ ВОССТАНОВЛЕНИЕ';
  readme.getCell('A3').font = { bold: true, color: { argb: 'FF0F766E' } };
  readme.mergeCells('A4:F6');
  readme.getCell('A4').value = 'Файлда тек нысандардың жұмыс ақпараты бар. API-токендер мен ішкі кілттер экспортталмайды. Импорт кезінде жаңа нысандардың кілттері автоматты жасалады, ал бар нысандардың кілттері өзгермейді.\nФайл содержит только рабочие данные точек. API-токены и внутренние ключи не экспортируются. При импорте ключи новых точек создаются автоматически, а ключи существующих точек сохраняются.';
  readme.getCell('A4').alignment = { wrapText: true, vertical: 'top' };
  readme.getCell('A8').value = 'Экспорт көлемі / Объём';
  readme.getCell('B8').value = scope === 'all' ? 'Барлығы / Все' : 'Жеке / Одна точка';
  readme.getCell('A9').value = 'Нысандар / Точки';
  readme.getCell('B9').value = rows.length;
  readme.getCell('A10').value = 'Экспорт уақыты / Время';
  readme.getCell('B10').value = new Date();
  readme.getCell('B10').numFmt = 'yyyy-mm-dd hh:mm:ss';
  readme.getColumn('A').width = 30;
  readme.getColumn('B').width = 34;
  for (const column of ['C', 'D', 'E', 'F']) readme.getColumn(column).width = 12;

  const sheet = workbook.addWorksheet('Entities', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }],
    properties: { defaultRowHeight: 20 }
  });
  sheet.mergeCells(1, 1, 1, COLUMNS.length);
  sheet.getCell(1, 1).value = 'WhatsPro — Нысандар / Точки';
  sheet.getCell(1, 1).font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
  sheet.getCell(1, 1).alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 34;
  sheet.mergeCells(2, 1, 2, COLUMNS.length);
  sheet.getCell(2, 1).value = 'Өңдеп, қайта импорттауға болады. Instance ID қайталанбауы керек. / Можно редактировать и импортировать обратно. Instance ID должен быть уникальным.';
  sheet.getCell(2, 1).font = { color: { argb: 'FF475569' }, italic: true };
  sheet.getCell(2, 1).alignment = { wrapText: true };
  sheet.getRow(2).height = 30;

  const headerRow = sheet.getRow(5);
  COLUMNS.forEach(([key, label, width], index) => {
    const column = sheet.getColumn(index + 1);
    column.key = key;
    column.width = width;
    const cell = headerRow.getCell(index + 1);
    cell.value = key;
    cell.note = label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF164E63' } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  headerRow.height = 28;
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5 + rows.length, column: COLUMNS.length } };

  rows.forEach(record => {
    const row = {};
    for (const [key] of COLUMNS) {
      if (BOOLEAN_FIELDS.has(key)) row[key] = record[key] !== false;
      else row[key] = record[key] ?? '';
    }
    const excelRow = sheet.addRow(row);
    excelRow.height = 34;
    excelRow.alignment = { vertical: 'middle', wrapText: false };
    excelRow.getCell('address').alignment = { vertical: 'middle', wrapText: true };
    excelRow.getCell('system_prompt').alignment = { vertical: 'middle', wrapText: true };
  });
  for (const key of ['instance_id', 'whatsapp_phone', 'admin_phone', 'domain', 'work_hours']) {
    sheet.getColumn(key).numFmt = '@';
  }

  const meta = workbook.addWorksheet('_BackupMeta', { state: 'veryHidden' });
  meta.addRows([
    ['format', FORMAT_NAME],
    ['version', FORMAT_VERSION],
    ['scope', scope],
    ['exported_at', new Date().toISOString()],
    ['count', rows.length]
  ]);
}

async function exportWorkbook(rows, scope = 'all') {
  const workbook = new ExcelJS.Workbook();
  styleWorkbook(workbook, rows, scope);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function workbookError(code) {
  const error = new Error(code);
  error.statusCode = 400;
  return error;
}

async function importWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const meta = workbook.getWorksheet('_BackupMeta');
  const sheet = workbook.getWorksheet('Entities');
  if (!meta || !sheet) throw workbookError('INVALID_BACKUP_WORKBOOK');
  const metadata = new Map();
  meta.eachRow(row => metadata.set(String(row.getCell(1).value || ''), String(row.getCell(2).value || '')));
  if (metadata.get('format') !== FORMAT_NAME || Number(metadata.get('version')) !== FORMAT_VERSION) {
    throw workbookError('UNSUPPORTED_BACKUP_VERSION');
  }
  if (sheet.rowCount - 5 > MAX_ROWS) throw workbookError('TOO_MANY_TENANTS');

  const headers = new Map();
  sheet.getRow(5).eachCell((cell, column) => headers.set(scalar(cell.value, 'header').trim(), column));
  for (const [key] of COLUMNS) if (!headers.has(key)) throw workbookError(`MISSING_COLUMN:${key}`);

  const rows = [];
  const ids = new Set();
  for (let rowNumber = 6; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const source = sheet.getRow(rowNumber);
    const instanceRaw = scalar(source.getCell(headers.get('instance_id')).value, 'instance_id').trim();
    if (!instanceRaw) continue;
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(instanceRaw)) throw workbookError(`BAD_INSTANCE_ID:${rowNumber}`);
    if (ids.has(instanceRaw)) throw workbookError(`DUPLICATE_INSTANCE_ID:${instanceRaw}`);
    ids.add(instanceRaw);

    const record = {};
    for (const [key] of COLUMNS) {
      const value = source.getCell(headers.get(key)).value;
      record[key] = BOOLEAN_FIELDS.has(key) ? parseBoolean(value, key) : scalar(value, key).trim();
    }
    record.instance_id = instanceRaw;
    for (const field of REQUIRED_FIELDS) {
      if (!String(record[field] || '').trim()) throw workbookError(`REQUIRED_FIELD:${field}:${rowNumber}`);
    }
    rows.push(record);
  }
  if (!rows.length) throw workbookError('EMPTY_BACKUP');
  return { rows, scope: metadata.get('scope') || 'all' };
}

module.exports = {
  COLUMNS,
  FORMAT_NAME,
  FORMAT_VERSION,
  exportWorkbook,
  importWorkbook,
  safeFilename,
  __test: { scalar, parseBoolean }
};
