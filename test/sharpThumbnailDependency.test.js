
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const sharp = require('sharp');
const { BaileysClient } = require('../services/baileysClient');
function atLeast(version, major, minor, patch) {
  const parts = String(version).split('.').map(Number);
  return parts[0] > major || (parts[0] === major && (parts[1] > minor || (parts[1] === minor && parts[2] >= patch)));
}
test('actual Baileys AVIF thumbnail uses patched native sharp/libheif and preserves benign media support', async () => {
  const source = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 20, g: 30, b: 40 } } }).avif().toBuffer();
  const content = BaileysClient.prototype._buildSendContent.call({}, {
    mimetype: 'image/avif', data: source.toString('base64'), filename: 'synthetic.avif'
  });
  assert.ok(Buffer.isBuffer(content.image));
  const mediaUtils = await import('@whiskeysockets/baileys/lib/Utils/messages-media.js');
  const thumb = await mediaUtils.generateThumbnail(content.image, 'image', {});
  assert.ok(thumb.thumbnail); assert.deepEqual(thumb.originalImageDimensions, { width: 2, height: 2 });
  const decodedThumb = await sharp(Buffer.from(thumb.thumbnail, 'base64')).metadata();
  assert.equal(decodedThumb.format, 'jpeg'); assert.ok(decodedThumb.width > 0 && decodedThumb.height > 0);
  assert.ok(atLeast(sharp.versions.sharp, 0, 35, 4), 'actual installed sharp must include GHSA-rgj7-g3m4-5g8c patch');
  assert.ok(atLeast(sharp.versions.heif, 1, 23, 2), 'actual native libheif must include its upstream fixes');
});
