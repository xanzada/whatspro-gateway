'use strict';

const { redisClient } = require('../config/redis');
const { normalizePhone } = require('./phoneUtils');
const { parseScoredMembers } = require('./redisReply');

const SOS_TTL_SECONDS = 60 * 60;
const keys = {
  index: instanceId => `chatwoot:sos:${instanceId}`,
  marker: (instanceId, phone) => `chatwoot:sos:${instanceId}:${phone}`,
  unread: (instanceId, phone) => `chatwoot:sos-unread:${instanceId}:${phone}`
};

function parseJson(value) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; }
}
function validPhone(value) { return /^\d{10,15}$/.test(String(value || '')); }

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
        sosUrgency: ['low', 'normal', 'high'].includes(String(marker.urgency || '').toLowerCase())
          ? String(marker.urgency).toLowerCase()
          : 'normal',
        sosCaseId: String(marker.caseId || ''),
        sosSignalId: String(marker.signalId || '')
      });
    }
    return entries;
  }

  async function acknowledge(instanceId, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!validPhone(phone)) return false;
    const script = "if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('DEL', KEYS[2]); return 1 end; redis.call('ZREM', KEYS[3], ARGV[1]); redis.call('DEL', KEYS[2]); return 0";
    const result = await command(['EVAL', script, '3', keys.marker(instanceId, phone), keys.unread(instanceId, phone), keys.index(instanceId), phone], 0);
    return Number(result) === 1;
  }

  async function clear(instanceId, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!validPhone(phone)) return false;
    await Promise.all([
      command(['DEL', keys.marker(instanceId, phone), keys.unread(instanceId, phone)], 0),
      command(['ZREM', keys.index(instanceId), phone], 0)
    ]);
    return true;
  }

  return { list, acknowledge, clear, keys };
}

const sosStore = createSosStore(redisClient);
module.exports = { SOS_TTL_SECONDS, createSosStore, sosStore, sosKeys: keys };
