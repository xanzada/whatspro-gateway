const crypto = require('crypto');
const { operatorSosFenceLua } = require('./sosStore');
const { redisClient } = require('../config/redis');
const { isValidChatPhone, normalizePhone } = require('./phoneUtils');
const { parseScoredMembers, parseFieldMap } = require('./redisReply');

const STANDARD_TTL_SECONDS = 24 * 60 * 60;
const ARCHIVE_TTL_SECONDS = 72 * 60 * 60;
const OPERATOR_TTL_SECONDS = 3 * 60 * 60;
const ttlForState = state => state === 'archive' ? ARCHIVE_TTL_SECONDS : state === 'operator' ? OPERATOR_TTL_SECONDS : STANDARD_TTL_SECONDS;
const LID_MAP_TTL_SECONDS = 30 * 24 * 60 * 60;
// Common decoded-media resource bound; provider/platform limits remain independent.
const configuredMediaBytes = Number(process.env.MAX_MEDIA_BYTES || process.env.WHATSPRO_MAX_MEDIA_BYTES);
const MAX_MEDIA_BYTES = Number.isSafeInteger(configuredMediaBytes) && configuredMediaBytes >= 1024
  && configuredMediaBytes <= Math.floor((Number.MAX_SAFE_INTEGER - 262_144) / 6)
  ? configuredMediaBytes : 64 * 1024 * 1024;
const MAX_MEDIA_BASE64_LENGTH = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;
const CHAT_STATES = new Set(['new', 'all', 'operator', 'archive']);

const keys = {
  history: (instanceId, phone) => `chatwoot:history:${instanceId}:${phone}`,
  legacyHistory: (instanceId, phone) => `history:${instanceId}:${phone}`,
  inbox: instanceId => `chatwoot:inbox:${instanceId}`,
  archive: instanceId => `chatwoot:archive:${instanceId}`,
  archiveMarker: (instanceId, phone) => `chatwoot:archive:${instanceId}:${phone}`,
  state: (instanceId, phone) => `chatwoot:state:${instanceId}:${phone}`,
  viewed: instanceId => `chatwoot:viewed:${instanceId}`,
  media: (instanceId, messageId) => `chatwoot:media:${instanceId}:${messageId}`,
  mediaIds: (instanceId, phone) => `chatwoot:media-ids:${instanceId}:${phone}`,
  messageIds: (instanceId, phone) => `chatwoot:message-ids:${instanceId}:${phone}`,
  deleted: (instanceId, phone) => `chatwoot:deleted:${instanceId}:${phone}`,
  receipts: (instanceId, phone) => `chatwoot:receipts:${instanceId}:${phone}`,
  retention: (instanceId, phone) => `chatwoot:retention:${instanceId}:${phone}`,
  expiry: instanceId => `chatwoot:expiry:${instanceId}`,
  operator: (instanceId, phone) => `operator_active:${instanceId}:${phone}`,
  mute: (instanceId, phone) => `mute:${instanceId}:${phone}`,
  lidMap: (instanceId, lid) => `chatwoot:lid-map:${instanceId}:${lid}`
};

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function isPhone(phone) {
  return isValidChatPhone(phone);
}

function encodeMedia(data, mimeType = 'audio/ogg') {
  const raw = String(data || '').trim();
  const comma = raw.indexOf(',');
  const base64 = (/^data:[^;,]+;base64,/i.test(raw) ? raw.slice(comma + 1) : raw).replace(/\s+/g, '');
  if (!base64 || base64.length > MAX_MEDIA_BASE64_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('INVALID_OR_OVERSIZED_MEDIA');
  }
  return `data:${String(mimeType || 'audio/ogg').split(';')[0]};base64,${base64}`;
}

function cleanEntry(entry, now) {
  const copy = { ...entry };
  delete copy.mediaData;
  delete copy.base64;
  const role = String(copy.role || '').toLowerCase();
  const outgoing = copy.direction === 'outgoing' || copy.fromMe === true || ['assistant', 'model', 'bot', 'operator'].includes(role);
  let createdAt = Number(copy.createdAt || copy.timestamp || now());
  if (createdAt > 0 && createdAt < 1e12) createdAt *= 1000;
  return {
    ...copy,
    direction: outgoing ? 'outgoing' : 'incoming',
    fromMe: outgoing,
    text: copy.text || copy.body || '',
    body: copy.body || copy.text || '',
    createdAt
  };
}

function parseLegacyInboxRow(raw, now) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const object = parseJson(value);
  if (object && typeof object === 'object') {
    const phone = normalizePhone(object.phone || object.senderPhone || object.from || '');
    return isPhone(phone) ? { phone, updatedAt: Number(object.createdAt || object.updatedAt || object.timestamp || object.time || 0) } : null;
  }
  const [phonePart, scorePart] = value.split(/[,|]/);
  const phone = normalizePhone(phonePart);
  return isPhone(phone) ? { phone, updatedAt: Number(scorePart) || 0 } : null;
}

// A presentation deadline comes from stored activity/transition time, never a read or
// the remaining lifetime of durable OpenBot model history. null means unproved.
function retentionDeadline(state, stamp, activity, archiveAt, expiry, at) {
  if ([state, stamp, activity, archiveAt, expiry].some(value => value === undefined)) return null;
  if (state && !CHAT_STATES.has(state)) return null;
  // Expired index proof outlives short state keys. It may only be superseded by a
  // genuine newer activity/transition, not bare model history recovered on a poll.
  if (!state && !stamp && !archiveAt && expiry !== null && expiry !== '') {
    const ended = Number(expiry);
    if (Number.isSafeInteger(ended) && ended > 0 && ended <= at) return ended;
    if (activity === null || activity === '') return null;
  }
  const current = CHAT_STATES.has(state) ? state : archiveAt ? 'archive' : 'all';
  let raw;
  if (stamp) {
    const match = /^(new|all|operator|archive):([0-9]+)$/.exec(String(stamp));
    if (!match || match[1] !== current) return null;
    raw = match[2];
  } else raw = current === 'archive' ? archiveAt : activity;
  if (raw === null || raw === '') return state || stamp || archiveAt || expiry ? null : 0;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^[0-9]+$/.test(raw))) return null;
  let origin = Number(raw);
  if (!Number.isSafeInteger(origin) || origin <= 0) return null;
  if (!Number.isSafeInteger(origin) || origin > at) return null;
  const deadline = origin + ttlForState(current) * 1000;
  return Number.isSafeInteger(deadline) ? deadline : null;
}

function createChatStore(redis, options = {}) {
  const now = options.now || Date.now;

  async function command(args, fallback) {
    try { return await redis.sendCommand(args); } catch (error) {
      if (arguments.length > 1) return fallback;
      throw error;
    }
  }

  async function getState(instanceId, phone) {
    const state = await command(['GET', keys.state(instanceId, phone)], '');
    if (CHAT_STATES.has(state)) return state;
    const archiveMarker = await command(['GET', keys.archiveMarker(instanceId, phone)], '');
    return archiveMarker ? 'archive' : 'all';
  }


  async function getRetentionSnapshot(instanceId, phone) {
    const script = "-- readOnlyRetentionSnapshot\nreturn {redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or '', redis.call('ZSCORE', KEYS[3], ARGV[1]) or '', redis.call('GET', KEYS[4]) or '', redis.call('ZSCORE', KEYS[5], ARGV[1]) or ''}";
    const values = await command(['EVAL', script, '5', keys.state(instanceId, phone), keys.retention(instanceId, phone),
      keys.inbox(instanceId), keys.archiveMarker(instanceId, phone), keys.expiry(instanceId), phone], null);
    if (!Array.isArray(values) || values.length !== 5 || values.some(value => typeof value !== 'string')) return { state: null, deadline: null };
    const [state, stamp, activity, archivedAt, expiry] = values;
    return { state: CHAT_STATES.has(state) ? state : archivedAt ? 'archive' : 'all',
      deadline: retentionDeadline(state, stamp, activity, archivedAt, expiry, now()) };
  }

  // Visible operator retention is separate from durable delivery/case obligations.
  // All identity/state/activity reads and changes occur in one Redis transaction.
  async function enforceOperatorRetention(instanceId, phone) {
    const script = [
      "-- operatorRetentionPolicy",
      "if redis.call('GET', KEYS[2]) ~= 'operator' or redis.call('EXISTS', KEYS[7]) == 1 then return 0 end",
      "local cutoff = tonumber(ARGV[2]); local origin = nil",
      "local stamp = redis.call('GET', KEYS[1]) or ''",
      "if stamp ~= '' then origin = tonumber(string.match(stamp, '^operator:(%d+)$')); if not origin then return 0 end",
      "else",
      "  local score = tonumber(redis.call('ZSCORE', KEYS[3], ARGV[1])); local activity = tonumber(redis.call('ZSCORE', KEYS[4], ARGV[1]))",
      "  if not score or not activity or score % 1 ~= 0 or activity % 1 ~= 0 or score > 9007199254740991 or activity > 9007199254740991 then return 0 end",
      "  origin = math.max(score - tonumber(ARGV[3]) * 1000, activity)",
      "end",
      "if not origin or origin <= 0 or origin % 1 ~= 0 or origin > cutoff or origin > 9007199254740991 then return 0 end",
      "local expiresAt = origin + tonumber(ARGV[4]) * 1000",
      "if expiresAt > cutoff then",
      "  local remaining = math.max(1, math.ceil((expiresAt - cutoff) / 1000))",
      "  for _, key in ipairs({KEYS[2], KEYS[5], KEYS[8], KEYS[9], KEYS[10]}) do if redis.call('EXISTS', key) == 1 then local ttl = redis.call('TTL', key); if ttl < 0 or ttl > remaining then redis.call('EXPIRE', key, remaining) end end end",
      "  local media = redis.pcall('SMEMBERS', KEYS[8]); if type(media) == 'table' and not media.err then for _, id in ipairs(media) do local key = ARGV[5] .. id; local ttl = redis.call('TTL', key); if ttl < 0 or ttl > remaining then redis.call('EXPIRE', key, remaining) end end end",
      "  redis.call('SET', KEYS[1], 'operator:' .. string.format('%.0f', origin), 'EX', remaining)",
      "  redis.call('ZADD', KEYS[3], expiresAt, ARGV[1]); return 2",
      "end",
      "local media = redis.pcall('SMEMBERS', KEYS[8]); if type(media) == 'table' and not media.err then for _, id in ipairs(media) do redis.call('DEL', ARGV[5] .. id) end end",
      "redis.call('DEL', KEYS[1], KEYS[2], KEYS[5], KEYS[7], KEYS[8], KEYS[9], KEYS[10])",
      "redis.call('ZADD', KEYS[3], expiresAt, ARGV[1]); redis.call('ZREM', KEYS[4], ARGV[1]); redis.call('ZREM', KEYS[11], ARGV[1]); redis.call('SREM', KEYS[12], ARGV[1]); return 1"
    ].join('\n');
    return command(['EVAL', script, '12', keys.retention(instanceId, phone), keys.state(instanceId, phone),
      keys.expiry(instanceId), keys.inbox(instanceId), keys.history(instanceId, phone), keys.legacyHistory(instanceId, phone),
      keys.archiveMarker(instanceId, phone), keys.mediaIds(instanceId, phone), keys.messageIds(instanceId, phone),
      keys.receipts(instanceId, phone), keys.viewed(instanceId), keys.archive(instanceId),
      phone, String(now()), String(STANDARD_TTL_SECONDS), String(OPERATOR_TTL_SECONDS), 'chatwoot:media:' + instanceId + ':'], 0);
  }

  async function ttlFor(instanceId, phone) {
    return ttlForState(await getState(instanceId, phone));
  }

  async function setState(instanceId, phone, state) {
    if (!CHAT_STATES.has(state)) throw new Error('INVALID_CHAT_STATE');
    const ttl = ttlForState(state);
    // Same reason as applyTtl: this only needs the media ids, not the transcript.
    const history = await getHistory(instanceId, phone, TTL_MEDIA_SCAN_LIMIT);
    const ids = await mediaIds(instanceId, phone, history);
    const ttlKeys = [
      keys.history(instanceId, phone), keys.legacyHistory(instanceId, phone), keys.mediaIds(instanceId, phone),
      keys.messageIds(instanceId, phone), keys.receipts(instanceId, phone), ...ids.map(id => keys.media(instanceId, id))
    ];
    const script = [
      "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])",
      "redis.call('SET', ARGV[6], ARGV[2] .. ':' .. ARGV[4], 'EX', ARGV[3])",
      "if ARGV[2] == 'archive' then redis.call('SADD', KEYS[2], ARGV[1]); redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[3]) else redis.call('SREM', KEYS[2], ARGV[1]); redis.call('DEL', KEYS[3]) end",
      "redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])",
      "for i = 5, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then redis.call('EXPIRE', KEYS[i], ARGV[3]) end end",
      'return 1'
    ].join('\n');
    await command(['EVAL', script, String(4 + ttlKeys.length), keys.state(instanceId, phone), keys.archive(instanceId),
      keys.archiveMarker(instanceId, phone), keys.expiry(instanceId), ...ttlKeys,
      phone, state, String(ttl), String(now()), String(now() + ttl * 1000), keys.retention(instanceId, phone)]);
    return state;
  }

  async function mediaIds(instanceId, phone, history = []) {
    const stored = await command(['SMEMBERS', keys.mediaIds(instanceId, phone)], []);
    const fromHistory = history.filter(item => item?.hasMedia && item?.id).map(item => String(item.id));
    return [...new Set([...stored, ...fromHistory])];
  }

  // The history is read here only to discover which media ids belong to this chat,
  // and mediaIds already unions the stored SMEMBERS set with whatever the rows
  // mention. Reading 2000 rows (twice, canonical + legacy) plus a full re-parse on
  // EVERY inserted message was the dominant cost of storing a message; the recent
  // window carries the media a live chat actually has, and anything older is already
  // in chatwoot:media-ids (found 2026-08-22).
  const TTL_MEDIA_SCAN_LIMIT = Number(process.env.WHATSPRO_TTL_MEDIA_SCAN_LIMIT || 200);

  async function applyTtl(instanceId, phone, ttl, expectedState = '') {
    const history = await getHistory(instanceId, phone, TTL_MEDIA_SCAN_LIMIT);
    const ids = await mediaIds(instanceId, phone, history);
    const chatKeys = [
      keys.history(instanceId, phone), keys.legacyHistory(instanceId, phone), keys.state(instanceId, phone),
      keys.archiveMarker(instanceId, phone), keys.mediaIds(instanceId, phone), keys.messageIds(instanceId, phone), keys.receipts(instanceId, phone)
    ];
    const expiryKeys = [...new Set([...chatKeys, ...ids.map(id => keys.media(instanceId, id))])];
    const ttlScript = [
      "if ARGV[1] ~= '' and redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
      "redis.call('SET', ARGV[5], (redis.call('GET', KEYS[1]) or 'all') .. ':' .. ARGV[6], 'EX', ARGV[4])",
      "redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])",
      "for i = 3, #KEYS do redis.call('EXPIRE', KEYS[i], ARGV[4]) end",
      'return 1'
    ].join('\n');
    const result = await command(['EVAL', ttlScript, String(2 + expiryKeys.length), keys.state(instanceId, phone), keys.expiry(instanceId),
      ...expiryKeys, expectedState, String(now() + ttl * 1000), phone, String(ttl), keys.retention(instanceId, phone), String(now())], 0);
    return Number(result) === 1;
  }

  async function storeMedia(instanceId, phone, messageId, data, mimeType = 'audio/ogg', ttl) {
    if (!messageId || !data) return false;
    const encoded = encodeMedia(data, mimeType);
    const effectiveTtl = ttl || await ttlFor(instanceId, phone);
    await Promise.all([
      command(['SET', keys.media(instanceId, messageId), encoded, 'EX', String(effectiveTtl)]),
      command(['SADD', keys.mediaIds(instanceId, phone), String(messageId)])
    ]);
    await command(['EXPIRE', keys.mediaIds(instanceId, phone), String(effectiveTtl)], 0);
    return true;
  }

  async function readMedia(instanceId, messageId) {
    return command(['GET', keys.media(instanceId, messageId)], null);
  }

  async function appendMessage(instanceId, rawPhone, entry, options = {}) {
    const phone = normalizePhone(rawPhone);
    if (!isPhone(phone)) throw new Error('INVALID_CHAT_PHONE');
    const createdAt = Number(entry.createdAt || entry.timestamp || now());
    const normalized = cleanEntry({ ...entry, instanceId, phone, createdAt }, now);
    if (entry.mediaData && normalized.id) {
      await storeMedia(instanceId, phone, normalized.id, entry.mediaData, entry.mediaType);
    }
    await ensureInboxSortedSet(instanceId);
    await Promise.all([
      command(['RPUSH', keys.history(instanceId, phone), JSON.stringify(normalized)]),
      normalized.id ? command(['SADD', keys.messageIds(instanceId, phone), String(normalized.id)]) : Promise.resolve(0),
      command(['ZADD', keys.inbox(instanceId), String(normalized.createdAt), phone])
    ]);
    if (options.state) await setState(instanceId, phone, options.state);
    const ttl = await ttlFor(instanceId, phone);
    await applyTtl(instanceId, phone, ttl);
    return normalized;
  }

  async function appendMessageOnce(instanceId, rawPhone, entry, options = {}) {
    const phone = normalizePhone(rawPhone);
    if (!isPhone(phone) || !entry?.id) throw new Error('INVALID_CHAT_MESSAGE');
    const createdAt = Number(entry.createdAt || entry.timestamp || now());
    const normalized = cleanEntry({ ...entry, instanceId, phone, createdAt }, now);
    const encodedMedia = entry.mediaData ? encodeMedia(entry.mediaData, entry.mediaType) : '';
    await ensureInboxSortedSet(instanceId);
    const state = CHAT_STATES.has(options.state) ? options.state : await getState(instanceId, phone);
    const ttl = ttlForState(state);
    const hasSosSnapshot = options.sosSnapshot && typeof options.sosSnapshot === 'object';
    const script = [
      "local deletedAt = tonumber(redis.call('GET', KEYS[3]) or '0')",
      'if deletedAt >= tonumber(ARGV[3]) then return -1 end',

      "local protectSos = false",
      "if ARGV[13] == '1' then",
      "  local sosMarkerKey = KEYS[11]; local sosActiveKey = KEYS[12]",
      "  local sosCasePrefix = 'operator_case:' .. ARGV[16] .. ':'",
      "  local sosInstance = ARGV[16]; local sosPhone = ARGV[4]; local sosCutoff = tonumber(ARGV[3])",
      "  local sosHasSnapshot = ARGV[14] == '1'; local sosExpectedMarker = ARGV[15]",
      "  local sosExpectedCanonical = ARGV[17]; local sosExpectedActive = ARGV[18]",
      ...operatorSosFenceLua,
      "  protectSos = sosProtected",
      "end",
      'local targetState = ARGV[5]',
      'local ttl = ARGV[6]',
      'local expiresAt = ARGV[7]',
      "if ARGV[10] == '1' and (redis.call('GET', KEYS[5]) == 'archive' or redis.call('EXISTS', KEYS[7]) == 1) then targetState = 'archive'; ttl = ARGV[11]; expiresAt = ARGV[12] end",
      // A stale accepted reply may append history while preserving a newer SOS.
      // Bound new keys/media by existing retention without extending the live chat.
      "if protectSos then",
      "  local remaining = tonumber(ttl)",
      "  for _, key in ipairs({KEYS[1], KEYS[2], KEYS[5], KEYS[7], KEYS[10]}) do local currentTtl = redis.call('TTL', key); if currentTtl >= 0 then remaining = math.min(remaining, math.max(1, currentTtl)) end end",
      "  ttl = remaining",
      "end",
      "local inserted = redis.call('SADD', KEYS[2], ARGV[1])",
      "if inserted == 1 then redis.call('RPUSH', KEYS[1], ARGV[2]); if ARGV[9] ~= '' then redis.call('SET', KEYS[9], ARGV[9], 'EX', ttl); redis.call('SADD', KEYS[10], ARGV[1]); redis.call('EXPIRE', KEYS[10], ttl) end end",
      "if protectSos then",
      "  for _, key in ipairs({KEYS[1], KEYS[2]}) do if redis.call('TTL', key) < 0 then redis.call('EXPIRE', key, ttl) end end",
      "  return { inserted, redis.call('GET', KEYS[5]) or 'all', 1 }",
      "end",
      "if inserted == 0 and ARGV[8] == '1' then return { 0, redis.call('GET', KEYS[5]) or targetState } end",
      "redis.call('ZADD', KEYS[4], ARGV[3], ARGV[4])",
      "redis.call('SET', KEYS[5], targetState, 'EX', ttl)",
      "redis.call('SET', 'chatwoot:retention:' .. ARGV[16] .. ':' .. ARGV[4], targetState .. ':' .. string.format('%.0f', tonumber(expiresAt) - tonumber(ttl) * 1000), 'EX', ttl)",
      "redis.call('ZADD', KEYS[6], expiresAt, ARGV[4])",
      "redis.call('EXPIRE', KEYS[1], ttl)",
      "redis.call('EXPIRE', KEYS[2], ttl)",
      "if targetState == 'archive' then redis.call('SADD', KEYS[8], ARGV[4]); redis.call('SET', KEYS[7], ARGV[3], 'EX', ttl) else redis.call('DEL', KEYS[7]); redis.call('SREM', KEYS[8], ARGV[4]) end",
      'return { inserted, targetState }'
    ].join('\n');
    const rawResult = await command(['EVAL', script, options.protectNewerSos ? '12' : '10', keys.history(instanceId, phone), keys.messageIds(instanceId, phone),
      keys.deleted(instanceId, phone), keys.inbox(instanceId), keys.state(instanceId, phone), keys.expiry(instanceId),
      keys.archiveMarker(instanceId, phone), keys.archive(instanceId), keys.media(instanceId, normalized.id), keys.mediaIds(instanceId, phone),
      ...(options.protectNewerSos ? ['chatwoot:sos:' + instanceId + ':' + phone, 'operator_case_active:' + instanceId + ':' + phone] : []),
      String(normalized.id), JSON.stringify(normalized), String(normalized.createdAt), phone, state, String(ttl),
      String(now() + ttl * 1000), options.preserveStateOnDuplicate ? '1' : '0', encodedMedia,
      options.preserveArchive ? '1' : '0', String(ARCHIVE_TTL_SECONDS), String(now() + ARCHIVE_TTL_SECONDS * 1000),
      options.protectNewerSos ? '1' : '0', hasSosSnapshot ? '1' : '0', options.sosSnapshot?.marker || '', instanceId,
      options.sosSnapshot?.canonical || '', options.sosSnapshot?.active || '']);
    const result = Number(Array.isArray(rawResult) ? rawResult[0] : rawResult);
    const appliedState = Array.isArray(rawResult) ? String(rawResult[1] || state) : state;
    if (result < 0) return { ...normalized, inserted: false, stale: true };
    if (result === 1 && normalized.hasMedia && !encodedMedia) {
      const operation = crypto.createHash('sha256').update(instanceId + ':' + phone + ':' + normalized.id).digest('hex').slice(0, 16);
      console.warn('[CHAT STORE] operation=' + operation + ' code=MEDIA_DATA_MISSING media data is missing');
    }
    const sosProtected = Array.isArray(rawResult) && Number(rawResult[2]) === 1;
    if (result === 1 && !sosProtected) {
      const appliedTtl = ttlForState(appliedState);
      await applyTtl(instanceId, phone, appliedTtl, appliedState);
    }
    return { ...normalized, state: appliedState, inserted: result === 1, stale: false, ...(sosProtected ? { sosProtected: true } : {}) };
  }

  async function getHistory(instanceId, rawPhone, limit = 1000) {
    const phone = normalizePhone(rawPhone);
    await enforceOperatorRetention(instanceId, phone);
    const [rows, legacyRows, receiptReply] = await Promise.all([
      command(['LRANGE', keys.history(instanceId, phone), String(-limit), '-1'], []),
      command(['LRANGE', keys.legacyHistory(instanceId, phone), String(-limit), '-1'], []),
      command(['HGETALL', keys.receipts(instanceId, phone)], [])
    ]);
    const receipts = new Map();
    for (const [messageId, stored] of parseFieldMap(receiptReply)) {
      receipts.set(messageId, stored.includes(':') ? stored.slice(stored.indexOf(':') + 1) : stored);
    }
    // chatwoot:history is the canonical operator-chat timeline. OpenBot keeps a
    // second, internal history for model context; merging both creates the exact
    // duplicate pattern users see (individual WhatsApp chunks plus one combined
    // assistant reply). Legacy history is therefore recovery-only.
    const canonical = rows.map(parseJson).filter(Boolean);
    const legacy = legacyRows.map(parseJson).filter(Boolean);
    const selected = canonical.length ? canonical : legacy;
    return selected.map(item => {
      const normalized = cleanEntry(item, now);
      const deliveryStatus = normalized.id ? receipts.get(String(normalized.id)) : '';
      return deliveryStatus ? { ...normalized, deliveryStatus } : normalized;
    }).sort((a, b) => a.createdAt - b.createdAt)
      // Was `all.findIndex(other => other.id === item.id) === index`, i.e. a full
      // scan per element: O(n^2) over up to 2000 rows on the EVENT LOOP, and
      // applyTtl/setState call this with limit 2000 on every inserted message, so
      // each stored message cost millions of string comparisons and visibly slowed
      // both ingestion and every panel request (found 2026-08-22). A Set keeps the
      // same semantics - first occurrence wins, id-less rows are always kept - in
      // one pass.
      .filter((() => {
        const seen = new Set();
        return item => {
          if (!item.id) return true;
          const id = String(item.id);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        };
      })())
      .slice(-limit);
  }

  async function updateMessageReceipt(instanceId, rawPhone, messageId, deliveryStatus) {
    const phone = normalizePhone(rawPhone);
    if (!isPhone(phone) || !messageId) return false;
    const allowed = new Set(['pending', 'sent', 'delivered', 'read', 'played', 'failed']);
    const status = allowed.has(String(deliveryStatus).toLowerCase()) ? String(deliveryStatus).toLowerCase() : 'sent';
    const ranks = { pending: 0, sent: 1, delivered: 2, read: 3, played: 4, failed: -1 };
    const receiptScript = [
      "local ttl = math.max(redis.call('TTL', KEYS[1]), redis.call('TTL', KEYS[2]), redis.call('TTL', KEYS[3]))",
      "if ttl <= 0 then return 0 end",
      "local current = redis.call('HGET', KEYS[4], ARGV[1])",
      "local legacyRanks = { pending = 0, sent = 1, delivered = 2, read = 3, played = 4, failed = -1 }",
      "local currentRank = current and tonumber(current:match('^(-?%d+):') or legacyRanks[current] or -1) or -1",
      // A negative ack (failed) is not a step backwards in the ladder, it is the
      // outcome, so it is exempt from the monotonic guard.
      "if current and tonumber(ARGV[3]) >= 0 and tonumber(ARGV[3]) < currentRank then return 1 end",
      "redis.call('HSET', KEYS[4], ARGV[1], ARGV[3] .. ':' .. ARGV[2])",
      "redis.call('EXPIRE', KEYS[4], ttl)",
      'return 1'
    ].join('\n');
    const result = await command(['EVAL', receiptScript, '4', keys.history(instanceId, phone), keys.legacyHistory(instanceId, phone),
      keys.state(instanceId, phone), keys.receipts(instanceId, phone), String(messageId), status, String(ranks[status])], null);
    if (result !== null) return Number(result) === 1;

    const remaining = Math.max(
      Number(await command(['TTL', keys.history(instanceId, phone)], -2)),
      Number(await command(['TTL', keys.legacyHistory(instanceId, phone)], -2)),
      Number(await command(['TTL', keys.state(instanceId, phone)], -2))
    );
    if (remaining <= 0) return false;
    const current = String(await command(['HGET', keys.receipts(instanceId, phone), String(messageId)], ''));
    const currentRank = current.includes(':') ? Number(current.split(':')[0]) : ranks[current];
    if (current && Number.isFinite(currentRank) && ranks[status] >= 0 && currentRank > ranks[status]) return true;
    await command(['HSET', keys.receipts(instanceId, phone), String(messageId), `${ranks[status]}:${status}`]);
    await command(['EXPIRE', keys.receipts(instanceId, phone), String(remaining)], 0);
    return true;
  }

  async function ensureInboxSortedSet(instanceId) {
    const key = keys.inbox(instanceId);
    const lockKey = `${key}:migration-lock`;
    const token = crypto.randomBytes(12).toString('hex');
    const acquired = await command(['SET', lockKey, token, 'NX', 'EX', '15'], null);
    if (acquired !== 'OK') {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const type = await command(['TYPE', key], 'none');
        if (type !== 'list') return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('INBOX_MIGRATION_BUSY');
    }
    const backupKey = `${key}:legacy-migration`;
    async function atomicConvertList(sourceKey, targetKey) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await command(['TYPE', sourceKey], 'none') !== 'list') return 0;
        const rows = await command(['LRANGE', sourceKey, '0', '-1'], []);
        const deduped = new Map();
        rows.map(row => parseLegacyInboxRow(row, now)).filter(Boolean).forEach(item => {
          deduped.set(item.phone, Math.max(deduped.get(item.phone) || 0, item.updatedAt));
        });
        const pairs = [...deduped].flatMap(([phone, score]) => [String(score), phone]);
        const script = [
          "if redis.call('TYPE', KEYS[1]).ok ~= 'list' then return 0 end",
          "if redis.call('LLEN', KEYS[1]) ~= tonumber(ARGV[1]) then return -1 end",
          "if KEYS[1] ~= KEYS[2] and redis.call('TYPE', KEYS[2]).ok ~= 'none' and redis.call('TYPE', KEYS[2]).ok ~= 'zset' then return -2 end",
          "if KEYS[1] == KEYS[2] then redis.call('DEL', KEYS[1]) end",
          "for i = 2, #ARGV, 2 do redis.call('ZADD', KEYS[2], ARGV[i], ARGV[i + 1]) end",
          "if KEYS[1] ~= KEYS[2] then redis.call('DEL', KEYS[1]) end",
          'return 1'
        ].join('\n');
        const result = await command(['EVAL', script, '2', sourceKey, targetKey, String(rows.length), ...pairs], null);
        if (result === null) return null;
        if (Number(result) >= 0) return Number(result);
      }
      throw new Error('INBOX_MIGRATION_CHANGED_REPEATEDLY');
    }
    async function mergeBackup() {
      const legacy = await command(['LRANGE', backupKey, '0', '-1'], []);
      const deduped = new Map();
      legacy.map(row => parseLegacyInboxRow(row, now)).filter(Boolean).forEach(item => {
        deduped.set(item.phone, Math.max(deduped.get(item.phone) || 0, item.updatedAt));
      });
      const pairs = [...deduped].flatMap(([phone, score]) => [String(score), phone]);
      if (pairs.length) await command(['ZADD', key, ...pairs]);
      if (await command(['TYPE', backupKey], 'none') === 'list') await command(['DEL', backupKey], 0);
    }
    try {
      const mainConverted = await atomicConvertList(key, key);
      if (mainConverted !== null) {
        await atomicConvertList(backupKey, key);
        return;
      }
      if (await command(['TYPE', backupKey], 'none') === 'list') await mergeBackup();
      if (await command(['TYPE', key], 'none') === 'list') {
        await command(['RENAME', key, backupKey]);
        await mergeBackup();
      }
    } finally {
      const releaseScript = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      const released = await command(['EVAL', releaseScript, '1', lockKey, token], null);
      if (released === null && await command(['GET', lockKey], '') === token) await command(['DEL', lockKey], 0);
    }
  }

  async function readInbox(instanceId, limit = 100) {
    const key = keys.inbox(instanceId);
    await ensureInboxSortedSet(instanceId);
    await pruneExpired(instanceId);
    const rows = await command(['ZREVRANGE', key, '0', '9999', 'WITHSCORES'], []);
    const result = [];
    for (const row of parseScoredMembers(rows)) {
      const phone = normalizePhone(row.member);
      if (!isPhone(phone)) continue;
      const [historyType, legacyType, stateType] = await Promise.all([
        command(['TYPE', keys.history(instanceId, phone)], 'none'),
        command(['TYPE', keys.legacyHistory(instanceId, phone)], 'none'),
        command(['TYPE', keys.state(instanceId, phone)], 'none')
      ]);
      if (historyType === 'none' && legacyType === 'none' && stateType === 'none') {
        await Promise.all([
          command(['ZREM', key, phone], 0),
          command(['ZREM', keys.viewed(instanceId), phone], 0),
          command(['SREM', keys.archive(instanceId), phone], 0)
        ]);
        continue;
      }
      if (Number(await enforceOperatorRetention(instanceId, phone)) === 1) continue;
      const { deadline } = await getRetentionSnapshot(instanceId, phone);
      if (!deadline || deadline <= now()) continue;
      result.push({ phone, updatedAt: row.score });
      if (result.length >= limit) break;
    }
    if (result.length < limit && parseScoredMembers(rows).length >= 10000) throw new Error('CHAT_VISIBLE_SCAN_INCOMPLETE');
    return result;
  }

  async function pruneExpired(instanceId) {
    const cutoff = now();
    // Old operator expiry scores used 24h. The atomic policy rechecks current state.
    const operatorCandidates = await command(['ZRANGEBYSCORE', keys.expiry(instanceId), '0', String(cutoff + (STANDARD_TTL_SECONDS - OPERATOR_TTL_SECONDS) * 1000), 'LIMIT', '0', '1000'], []);
    await Promise.all(operatorCandidates.filter(isPhone).map(phone => enforceOperatorRetention(instanceId, phone)));
    const expiredPhones = await command(['ZRANGEBYSCORE', keys.expiry(instanceId), '0', String(cutoff), 'LIMIT', '0', '1000'], []);
    const pruneScript = [
      "-- presentationRetentionPolicy",
      "local score = redis.call('ZSCORE', KEYS[1], ARGV[1])",
      'if not score or tonumber(score) > tonumber(ARGV[2]) then return 0 end',
      "local rawState = redis.call('GET', KEYS[7]); local state = rawState; local marker = redis.call('GET', KEYS[8])",
      "if state and state ~= 'new' and state ~= 'all' and state ~= 'operator' and state ~= 'archive' then return 0 end; if not state then state = marker and 'archive' or 'all' end",
      "local stamp = redis.call('GET', KEYS[9]); local origin = nil",
      "if not rawState and not marker and redis.call('EXISTS', KEYS[10]) == 0 and redis.call('TYPE', KEYS[5]).ok == 'none' and redis.call('TYPE', KEYS[6]).ok == 'none' then redis.call('ZREM', KEYS[1], ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('ZREM', KEYS[3], ARGV[1]); redis.call('SREM', KEYS[4], ARGV[1]); return 1 end",
      "if not rawState and not stamp and not marker then return 0 end",
      "if stamp then local kind, value = string.match(stamp, '^(%a+):(%d+)$'); if kind ~= state then return 0 end; origin = tonumber(value)",
      "elseif state == 'archive' then if marker and string.match(marker, '^%d+$') then origin = tonumber(marker) end else origin = tonumber(redis.call('ZSCORE', KEYS[2], ARGV[1])) end",
      "if not origin or origin <= 0 or origin % 1 ~= 0 or origin > 9007199254740991 then return 0 end",
      "if origin > tonumber(ARGV[2]) then return 0 end",
      "local ttl = tonumber(ARGV[3]); if state == 'archive' then ttl = tonumber(ARGV[4]) elseif state == 'operator' then ttl = tonumber(ARGV[5]) end",
      "local deadline = origin + ttl * 1000; if deadline > 9007199254740991 then return 0 end",
      "if deadline > tonumber(ARGV[2]) then",
      "  redis.call('ZADD', KEYS[1], deadline, ARGV[1]); local time = redis.call('TIME'); local nativeNow = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)",
      "  for _, key in ipairs({KEYS[7], KEYS[8], KEYS[9]}) do if redis.call('EXISTS', key) == 1 then local left = redis.call('PTTL', key); if left < 0 or nativeNow + left > deadline then redis.call('PEXPIREAT', key, deadline) end end end; return 2",
      "end",
      "if redis.call('EXISTS', KEYS[10]) == 1 then return 0 end",
      "redis.call('ZADD', KEYS[1], deadline, ARGV[1]); redis.call('ZREM', KEYS[2], ARGV[1]); redis.call('ZREM', KEYS[3], ARGV[1]); redis.call('SREM', KEYS[4], ARGV[1])",
      "redis.call('DEL', KEYS[7], KEYS[8]); return 1"
    ].join('\n');
    await Promise.all(expiredPhones.filter(isPhone).map(async phone => {
      const result = await command(['EVAL', pruneScript, '10', keys.expiry(instanceId), keys.inbox(instanceId),
        keys.viewed(instanceId), keys.archive(instanceId), keys.history(instanceId, phone), keys.legacyHistory(instanceId, phone),
        keys.state(instanceId, phone), keys.archiveMarker(instanceId, phone), keys.retention(instanceId, phone),
        'chatwoot:sos:' + instanceId + ':' + phone, phone, String(cutoff),
        String(STANDARD_TTL_SECONDS), String(ARCHIVE_TTL_SECONDS), String(OPERATOR_TTL_SECONDS)], null);
      // A failed atomic transaction proves neither absence nor expiry identity.
      // Keep the negative proof and metadata; a later successful read may clean it.
      return;
    }));
    return expiredPhones.length;
  }

  async function applyAction(instanceId, rawPhone, action) {
    const phone = normalizePhone(rawPhone);
    if (!isPhone(phone)) throw new Error('INVALID_CHAT_PHONE');
    const normalizedAction = action === 'close' ? 'archive' : action;
    if (normalizedAction === 'view') {
      const currentState = await getState(instanceId, phone);
      await Promise.all([
        currentState === 'new' ? command(['EVAL', [
          '-- viewWithoutRetentionRefresh',
          "if redis.call('GET', KEYS[1]) ~= 'new' then return 0 end",
          "redis.call('SET', KEYS[1], 'all', 'KEEPTTL')",
          "local stamp = redis.call('GET', KEYS[2]); if stamp and string.match(stamp, '^new:%d+$') then redis.call('SET', KEYS[2], 'all:' .. string.sub(stamp, 5), 'KEEPTTL') end",
          'return 1'
        ].join('\n'), '2', keys.state(instanceId, phone), keys.retention(instanceId, phone)], 0) : Promise.resolve(currentState),
        command(['ZADD', keys.viewed(instanceId), String(now()), phone])
      ]);
    } else if (normalizedAction === 'archive') {
      await setState(instanceId, phone, 'archive');
    } else if (normalizedAction === 'restore') {
      await setState(instanceId, phone, 'all');
    } else if (normalizedAction === 'delete') {
      const history = await getHistory(instanceId, phone, 5000);
      const ids = await mediaIds(instanceId, phone, history);
      const deleteScript = [
        "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])",
        "local storedMediaIds = redis.call('SMEMBERS', KEYS[6])",
        "for _, mediaId in ipairs(storedMediaIds) do redis.call('DEL', ARGV[4] .. mediaId) end",
        "for i = 2, 10 do redis.call('DEL', KEYS[i]) end",
        "redis.call('ZREM', KEYS[11], ARGV[1])",
        "redis.call('ZREM', KEYS[12], ARGV[1])",
        "redis.call('ZREM', KEYS[13], ARGV[1])",
        "redis.call('SREM', KEYS[14], ARGV[1])",
        'return 1'
      ].join('\n');
      await command(['EVAL', deleteScript, '14', keys.deleted(instanceId, phone), keys.history(instanceId, phone),
        keys.legacyHistory(instanceId, phone), keys.state(instanceId, phone), keys.archiveMarker(instanceId, phone),
        keys.mediaIds(instanceId, phone), keys.messageIds(instanceId, phone), keys.receipts(instanceId, phone),
        keys.operator(instanceId, phone), keys.mute(instanceId, phone), keys.inbox(instanceId), keys.viewed(instanceId),
        keys.expiry(instanceId), keys.archive(instanceId), phone, String(now()), String(ARCHIVE_TTL_SECONDS), `chatwoot:media:${instanceId}:`]);
      await Promise.all(ids.map(id => command(['DEL', keys.media(instanceId, id)], 0)));
    } else {
      throw new Error('INVALID_CHAT_ACTION');
    }
    return normalizedAction;
  }

  // WhatsApp privacy LIDs are stable per account: once a linked-device stanza
  // resolves to the real phone, remembering the mapping lets every read/write
  // path file the chat under the real phone even when the live lookup times
  // out. A chat keyed by the raw LID is a ghost whose history never loads in
  // the panel (live bug, 2026-08-21).
  async function rememberLidPhone(instanceId, lid, phone) {
    const lidNorm = String(lid || '').trim().toLowerCase();
    const phoneNorm = normalizePhone(phone);
    if (!/^\d+@lid$/.test(lidNorm) || !phoneNorm || /@lid$/.test(phoneNorm)) return false;
    await command(['SET', keys.lidMap(instanceId, lidNorm), phoneNorm, 'EX', String(LID_MAP_TTL_SECONDS)], false);
    return true;
  }

  async function resolveLidPhone(instanceId, rawPhone) {
    const direct = normalizePhone(rawPhone);
    if (direct && !direct.endsWith('@lid')) return direct;
    const lid = direct && direct.endsWith('@lid')
      ? direct
      : `${String(rawPhone || '').replace(/\D/g, '')}@lid`;
    if (!/^\d+@lid$/.test(lid)) return direct;
    const mapped = await command(['GET', keys.lidMap(instanceId, lid)], '');
    return mapped || direct;
  }

  return { appendMessage, appendMessageOnce, saveEntry: appendMessage, updateMessageReceipt, storeMedia, readMedia, getMedia: readMedia, getHistory, getState, getRetentionSnapshot, readInbox, pruneExpired, applyAction, applyTtl, rememberLidPhone, resolveLidPhone, keys };
}

const chatStore = createChatStore(redisClient);

module.exports = {
  STANDARD_TTL_SECONDS,
  OPERATOR_TTL_SECONDS,
  ARCHIVE_TTL_SECONDS,
  LID_MAP_TTL_SECONDS,
  MAX_MEDIA_BYTES,
  CHAT_STATES,
  createChatStore,
  chatStore,
  appendMessage: chatStore.appendMessage,
  appendMessageOnce: chatStore.appendMessageOnce,
  rememberLidPhone: chatStore.rememberLidPhone,
  resolveLidPhone: chatStore.resolveLidPhone,
  updateMessageReceipt: chatStore.updateMessageReceipt,
  storeMedia: chatStore.storeMedia,
  readMedia: chatStore.readMedia,
  keys
};
