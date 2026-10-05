'use strict';

const { redisClient } = require('../config/redis');
const { isValidChatPhone, normalizePhone } = require('./phoneUtils');
const { parseScoredMembers } = require('./redisReply');

// Kept in step with Openbot's operatorCase.service.ts: the writer sets these keys with
// this TTL, this reader prunes the index by the same clock. One hour dropped a night
// complaint out of the SOS column before the morning shift ever saw it (owner report,
// 2026-08-27).
const SOS_TTL_SECONDS = 24 * 60 * 60;
const keys = {
  index: instanceId => `chatwoot:sos:${instanceId}`,
  marker: (instanceId, phone) => `chatwoot:sos:${instanceId}:${phone}`,
  unread: (instanceId, phone) => `chatwoot:sos-unread:${instanceId}:${phone}`
};

function parseJson(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}
function validPhone(value) { return isValidChatPhone(value); }


const operatorSosFenceLua = [
  "local sosProtected = false",
  "local sosRaw = redis.call('GET', sosMarkerKey) or ''",
  "local sosActive = redis.call('GET', sosActiveKey) or ''",
  "local sosMarkerOk, sosMarker = pcall(cjson.decode, sosRaw)",
  "if not sosMarkerOk or type(sosMarker) ~= 'table' then sosMarker = {} end",
  "local sosCaseId = sosMarker.caseId or sosActive",
  "if type(sosCaseId) ~= 'string' or #sosCaseId > 96 or string.match(sosCaseId, '^[%w_-]+$') == nil then sosCaseId = '' end",
  "if sosActive ~= '' and sosCaseId ~= '' and sosActive ~= sosCaseId then sosProtected = true end",
  "local sosCanonical = sosCaseId ~= '' and (redis.call('GET', sosCasePrefix .. sosCaseId) or '') or ''",
  "if sosHasSnapshot and (sosRaw ~= sosExpectedMarker or sosCanonical ~= sosExpectedCanonical or sosActive ~= sosExpectedActive) then sosProtected = true end",
  "if not sosHasSnapshot and sosRaw ~= '' then",
  "  local started = tonumber(sosMarker.startedAt or sosMarker.createdAt)",
  "  if not started or started >= sosCutoff then sosProtected = true end",
  "end",
  "if sosCanonical ~= '' then",
  "  local ok, item = pcall(cjson.decode, sosCanonical)",
  "  if not ok or type(item) ~= 'table' or item.id ~= sosCaseId or item.instanceId ~= sosInstance",
  "    or type(item.phone) ~= 'string' or string.gsub(item.phone, '%D', '') ~= sosPhone then sosProtected = true",
  "  else",
  "    local updated = tonumber(item.updatedAt or item.createdAt)",
  "    if not updated or (sosHasSnapshot and updated > sosCutoff) or (not sosHasSnapshot and updated >= sosCutoff) then sosProtected = true end",
  "  end",
  "end"
];

function createSosStore(redis, options = {}) {
  const now = options.now || Date.now;
  async function command(args, fallback) {
    try { return await redis.sendCommand(args); } catch (error) {
      if (arguments.length > 1) return fallback;
      throw error;
    }
  }

  async function list(instanceId, limit = 1000) {
    const timestamp = now();
    await command(['ZREMRANGEBYSCORE', keys.index(instanceId), '-inf', String(timestamp)], 0);
    const rows = await command(['ZRANGEBYSCORE', keys.index(instanceId), String(timestamp + 1), '+inf', 'WITHSCORES', 'LIMIT', '0', String(limit)], []);
    const entries = [];
    for (const row of parseScoredMembers(rows)) {
      const phone = normalizePhone(row.member);
      const expiresAt = row.score;
      if (!validPhone(phone)) continue;
      const [raw, unread] = await Promise.all([
        command(['GET', keys.marker(instanceId, phone)], ''),
        command(['EXISTS', keys.unread(instanceId, phone)], 0)
      ]);
      if (!raw || expiresAt <= timestamp) {
        await command(['ZREM', keys.index(instanceId), phone], 0);
        continue;
      }
      const marker = parseJson(raw);
      entries.push({
        phone,
        sos: true,
        sosUnread: Number(unread) === 1,
        sosCreatedAt: Number(marker.startedAt || marker.createdAt || 0),
        sosExpiresAt: expiresAt,
        sosKind: String(marker.kind || ''),
        sosSummary: String(marker.summary || ''),
        sosCaseId: String(marker.caseId || ''),
        sosSignalId: String(marker.signalId || '')
      });
    }
    return entries;
  }

  async function snapshot(instanceId, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!validPhone(phone)) return null;
    return command(['GET', keys.marker(instanceId, phone)]);
  }


  async function effectSnapshot(instanceId, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!validPhone(phone)) throw new Error('INVALID_CHAT_PHONE');
    const marker = String(await snapshot(instanceId, phone) || '');
    const active = String(await command(['GET', 'operator_case_active:' + instanceId + ':' + phone]) || '');
    const linked = String(parseJson(marker).caseId || active);
    const caseId = /^[A-Za-z0-9_-]{1,96}$/.test(linked) ? linked : '';
    const canonical = caseId ? String(await command(['GET', 'operator_case:' + instanceId + ':' + caseId]) || '') : '';
    // Reads can straddle an escalation; the exact raw/version fence below then
    // conservatively preserves it. No unverified snapshot may resolve a case.
    return { marker, canonical, active };
  }

  // The marker snapshot is captured before the chat action. Compare it inside the
  // same Redis operation that updates the linked canonical operator_case.
  async function change(instanceId, rawPhone, mode, expectedMarker, notAfter = 0) {
    const phone = normalizePhone(rawPhone);
    if (!validPhone(phone)) return false;
    const fencedSnapshot = expectedMarker && typeof expectedMarker === 'object' ? expectedMarker : null;
    const raw = fencedSnapshot ? fencedSnapshot.marker : expectedMarker === undefined ? await snapshot(instanceId, phone) : expectedMarker;
    const marker = parseJson(raw);
    const candidate = String(marker.caseId || '');
    const caseId = /^[A-Za-z0-9_-]{1,96}$/.test(candidate) ? candidate : '';
    const script = [
      "-- operator_case ownership and SOS snapshot are checked before every mutation",
      "local current = redis.call('GET', KEYS[1])",
      "if (current or '') ~= ARGV[1] then return 0 end",

      "if tonumber(ARGV[7]) > 0 then",
      "  local sosMarkerKey = KEYS[1]; local sosActiveKey = KEYS[5]",
      "  local sosCasePrefix = 'operator_case:' .. ARGV[3] .. ':'",
      "  local sosInstance = ARGV[3]; local sosPhone = ARGV[2]; local sosCutoff = tonumber(ARGV[7])",
      "  local sosHasSnapshot = ARGV[8] == '1'; local sosExpectedMarker = ARGV[1]",
      "  local sosExpectedCanonical = ARGV[9]; local sosExpectedActive = ARGV[10]",
      ...operatorSosFenceLua,
      "  if sosProtected then return 0 end",
      "end",
      "local indexType = redis.call('TYPE', KEYS[3]).ok",
      "if indexType ~= 'none' and indexType ~= 'zset' then return redis.error_reply('SOS_INDEX_WRONGTYPE') end",
      "local canonical = nil",
      "local active = nil",
      "if current and ARGV[4] ~= '' then",
      "  local rawCase = redis.call('GET', KEYS[4])",
      "  if rawCase then",
      "    local decoded, item = pcall(cjson.decode, rawCase)",
      "    if decoded and type(item) == 'table' and item.id == ARGV[4] and item.instanceId == ARGV[3]",
      "      and type(item.phone) == 'string' and string.gsub(item.phone, '%D', '') == ARGV[2] then",
      "      local markerOk, marker = pcall(cjson.decode, current)",
      "      local started = markerOk and type(marker) == 'table' and tonumber(marker.startedAt or marker.createdAt) or nil",
      // OpenBot stores the canonical update before publishing its new SOS marker.
      // Leave an in-progress escalation intact in that inter-transaction window.
      "      local hasRevision = markerOk and type(marker) == 'table' and (marker.caseRevision ~= nil or item.revision ~= nil)",
      "      if hasRevision and (type(marker.caseRevision) ~= 'string' or marker.caseRevision == '' or marker.caseRevision ~= item.revision) then return 0 end",
      "      if not hasRevision and started and tonumber(item.updatedAt) and tonumber(item.updatedAt) > started then return 0 end",
      "      canonical = item",
      "      if ARGV[6] == 'resolve' then active = redis.call('GET', KEYS[5]) end",
      "    end",
      "  end",
      "end",
      "if canonical then",
      "  canonical.unread = false",
      "  if ARGV[6] == 'resolve' then",
      "    canonical.status = 'resolved'; canonical.highlight = ''",
      "    canonical.resolvedAt = tonumber(ARGV[5]); canonical.updatedAt = tonumber(ARGV[5])",
      "  end",
      "  redis.call('SET', KEYS[4], cjson.encode(canonical), 'KEEPTTL')",
      "  if ARGV[6] == 'resolve' and active == ARGV[4] then redis.call('DEL', KEYS[5]) end",
      "end",
      "redis.call('DEL', KEYS[2])",
      "if ARGV[6] == 'resolve' or not current then",
      "  redis.call('DEL', KEYS[1]); redis.call('ZREM', KEYS[3], ARGV[2])",
      "end",
      "if current then return 1 end return 0"
    ].join('\n');
    const result = await command(['EVAL', script, '5', keys.marker(instanceId, phone),
      keys.unread(instanceId, phone), keys.index(instanceId),
      'operator_case:' + instanceId + ':' + (caseId || '__unlinked__'),
      'operator_case_active:' + instanceId + ':' + phone,
      String(raw || ''), phone, instanceId, caseId, String(now()), mode, String(notAfter || 0),
      fencedSnapshot ? '1' : '0', fencedSnapshot?.canonical || '', fencedSnapshot?.active || '']);
    return Number(result) === 1;
  }

  async function acknowledge(instanceId, rawPhone, expectedMarker) {
    return change(instanceId, rawPhone, 'acknowledge', expectedMarker);
  }

  async function clear(instanceId, rawPhone, expectedMarker, notAfter) {
    return change(instanceId, rawPhone, 'resolve', expectedMarker, notAfter);
  }

  return { list, snapshot, effectSnapshot, acknowledge, clear, keys };
}

const sosStore = createSosStore(redisClient);
module.exports = { SOS_TTL_SECONDS, createSosStore, sosStore, sosKeys: keys, operatorSosFenceLua };
