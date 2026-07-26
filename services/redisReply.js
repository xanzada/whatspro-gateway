'use strict';

// A WITHSCORES reply is not one shape. Over RESP2 it is a flat
// [member, score, member, score] list; node-redis hands back [member, score]
// tuples instead, and some versions use { value, score } objects.
//
// Reading tuples as a flat list is silent rather than loud: the member still
// stringifies into something a phone regex can salvage, while the score lands on
// undefined and becomes 0. Every SOS then looked expired and was deleted by the
// first inbox poll, which is exactly how the SOS column stayed empty in
// production while the tests — whose fake Redis returned the flat shape — passed.
function parseScoredMembers(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];

  const first = rows[0];
  if (Array.isArray(first)) {
    return rows.map(row => ({ member: String(row?.[0] ?? ''), score: Number(row?.[1]) || 0 }));
  }
  if (first && typeof first === 'object' && 'value' in first) {
    return rows.map(row => ({ member: String(row?.value ?? ''), score: Number(row?.score) || 0 }));
  }

  const entries = [];
  for (let i = 0; i < rows.length; i += 2) {
    entries.push({ member: String(rows[i] ?? ''), score: Number(rows[i + 1]) || 0 });
  }
  return entries;
}

// scanIterator yields a batch of keys per SCAN round, not one key at a time.
// Treating a batch as a single key stringifies it into "a,b,c", which then fails
// every validity check downstream — so with one tenant it works by accident and
// with two the loop quietly stops doing anything.
async function* scanKeys(redis, pattern, count = 100) {
  for await (const batch of redis.scanIterator({ MATCH: pattern, COUNT: count })) {
    if (Array.isArray(batch)) {
      for (const key of batch) yield String(key);
    } else {
      yield String(batch);
    }
  }
}

module.exports = { parseScoredMembers, scanKeys };
