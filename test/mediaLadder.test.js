'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('fs/promises');

// C33 (whatspro): the media-persist retry ladder disarmed itself on the first tick.
// scheduleMediaPersist fires before the WAL writes the message, so at t=1s
// hasAuthoritativeMessage is legitimately still false - and that was treated as a PERMANENT
// failure, disarming the whole 1s/3s/7s/15s/30s ladder on its own first step. A voice note or
// Kaspi receipt then 404'd with MEDIA_NOT_READY.

const read = (relative) => readFile(new URL(relative, `file://${__filename}`), 'utf8');

test('the media ladder treats an early miss as a wait, not a verdict', async () => {
  const source = await read('../services/whatsappManager.js');
  const fn = source.slice(source.indexOf('function scheduleMediaPersist'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  assert.match(body, /const isLastTick = delayMs === delays\[delays\.length - 1\]/);
  assert.match(body, /if \(isLastTick\) permanentMediaFailures\.add\(failureKey\)/);

  // The permanent marker must NOT fire before the last tick.
  const earlyBranch = body.slice(body.indexOf('hasAuthoritativeMessage'), body.indexOf('isLastTick'));
  assert.doesNotMatch(earlyBranch, /permanentMediaFailures\.add/);
});

test('the last tick still gives up, so a truly dead media cannot loop forever', async () => {
  const source = await read('../services/whatsappManager.js');
  const fn = source.slice(source.indexOf('function scheduleMediaPersist'));
  assert.match(fn, /delays = \[1000, 3000, 7000, 15000, 30000\]/);
});
