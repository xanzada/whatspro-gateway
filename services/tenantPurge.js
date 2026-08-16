'use strict';

// Deleting a restaurant used to delete a row. Everything else the tenant had
// accumulated stayed: its cached menu and runtime status, its chat history, its
// operator cases, its second-brain memories, its idempotency locks. Most of those
// carry a TTL and drain within a day, but the ones that do not - the chat inbox
// index, the viewed markers, the tenant memory list - are keyed by an instance id
// that will never be looked up again, so they sit in Redis for the life of the
// deployment. On a 40 GB box that is the kind of rubbish that is invisible until
// it is the reason a deploy fails.
//
// The QR pairing is deliberately the opposite case: it must survive restarts,
// deploys and reconnects, because losing it costs the operator a physical scan of
// a phone. It must not survive its tenant. Once the restaurant is gone the
// credentials are a live WhatsApp login for an account nobody is watching.
//
// Both apps on this host share one Redis, so one purge covers the gateway's own
// keys and the bot's tenant-scoped caches. That is why the match is by
// convention, not by a list of prefixes: every tenant-scoped key in either app is
// `<family>:<instanceId>` or `<family>:<instanceId>:<rest>` (and a few carry a
// schema segment first, as in `menu_context:v2:<instanceId>:<lang>`), so two
// globs cover all of them and nothing has to be kept in sync with either app's
// internals as they grow.
const { scanKeys } = require('./redisReply');

// Registries are keyed by *name*, not by instance, and hold every tenant's row.
// A glob cannot reach them - `whatspro:tenants:v1` has no instance segment - but
// they are named here so that a future key like `whatspro:instances:<id>` cannot
// be swept up by accident, and so this list reads as the answer to "what must
// survive a delete".
const PROTECTED_KEYS = new Set([
  'whatspro:tenants:v1',
  'whatspro:instances',
  'whatspro:alemi-instance-owner:v1',
  'whatspro:shared-prompt',
  'whatspro:scan-requests',
]);

const DELETE_BATCH = 200;

function instancePatterns(instanceId) {
  return [`*:${instanceId}`, `*:${instanceId}:*`];
}

// The family is everything before the instance id: `history:restaurant-a:7776...`
// reports as `history`, `menu_context:v2:restaurant-a:kk` as `menu_context:v2`. Used
// for the audit line, so an operator can see what was removed without the log
// carrying customer phone numbers, order ids or note text in the key tails.
function keyFamily(key, instanceId) {
  const marker = `:${instanceId}`;
  const at = key.indexOf(marker);
  return at > 0 ? key.slice(0, at) : key;
}

async function collectTenantKeys(redis, instanceId) {
  const found = new Set();
  for (const pattern of instancePatterns(instanceId)) {
    for await (const key of scanKeys(redis, pattern, 500)) {
      if (!PROTECTED_KEYS.has(key)) found.add(key);
    }
  }
  return [...found];
}

async function purgeTenantRedisKeys(redis, instanceId, options = {}) {
  const instance = String(instanceId || '').trim();
  const summary = { instance, deleted: 0, families: {}, keys: 0 };
  if (!instance || !redis?.isOpen) return summary;

  const keys = await collectTenantKeys(redis, instance);
  summary.keys = keys.length;
  for (const key of keys) {
    const family = keyFamily(key, instance);
    summary.families[family] = (summary.families[family] || 0) + 1;
  }

  if (options.dryRun) return summary;

  for (let at = 0; at < keys.length; at += DELETE_BATCH) {
    const batch = keys.slice(at, at + DELETE_BATCH);
    summary.deleted += Number(await redis.del(batch)) || 0;
  }
  return summary;
}

module.exports = { purgeTenantRedisKeys, collectTenantKeys, keyFamily, instancePatterns, PROTECTED_KEYS };
