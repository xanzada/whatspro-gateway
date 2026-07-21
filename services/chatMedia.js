const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'whatspro-audio-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const EXTENSIONS = new Map([
  ['audio/ogg', '.ogg'], ['audio/opus', '.ogg'], ['audio/webm', '.webm'],
  ['audio/mpeg', '.mp3'], ['audio/mp4', '.m4a'], ['audio/wav', '.wav'], ['audio/x-wav', '.wav']
]);

function mediaError(code, status) {
  const error = new Error(code);
  error.status = status;
  return error;
}

function decodeAudioDataUri(value) {
  const match = String(value || '').trim().match(/^data:(audio\/[a-z0-9][a-z0-9.+_-]*)(?:;\s*codecs=[a-z0-9._+-]+)?;base64,([\s\S]+)$/i);
  if (!match) throw mediaError('INVALID_AUDIO_DATA_URI', 422);
  const mimeType = match[1].toLowerCase();
  const extension = EXTENSIONS.get(mimeType);
  if (!extension) throw mediaError('UNSUPPORTED_AUDIO_TYPE', 415);
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64 || base64.length % 4 !== 0 || base64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw mediaError('INVALID_AUDIO_BASE64', 422);
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES || buffer.toString('base64') !== base64) {
    throw mediaError('INVALID_AUDIO_BASE64', 422);
  }
  if ((mimeType === 'audio/ogg' || mimeType === 'audio/opus') && (buffer.subarray(0, 4).toString('ascii') !== 'OggS' || buffer.indexOf('OpusHead') < 0)) {
    throw mediaError('INVALID_OGG_OPUS', 422);
  }
  return { buffer, extension, mimeType: mimeType === 'audio/opus' ? 'audio/ogg' : mimeType };
}

async function cacheAudioFile(cacheDir, media) {
  await fs.mkdir(cacheDir, { recursive: true });
  const digest = crypto.createHash('sha256').update(media.buffer).digest('hex');
  const filePath = path.join(cacheDir, `${digest}${media.extension}`);
  try {
    const stat = await fs.stat(filePath);
    if (stat.isFile() && stat.size === media.buffer.length) return filePath;
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporaryPath = path.join(cacheDir, `${digest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(temporaryPath, media.buffer, { flag: 'wx', mode: 0o600 });
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
  const cleanup = setTimeout(() => fs.unlink(filePath).catch(() => {}), CACHE_TTL_MS);
  cleanup.unref();
  return filePath;
}

function createChatMediaHandler({ readMedia, cacheDir = DEFAULT_CACHE_DIR } = {}) {
  if (typeof readMedia !== 'function') throw new TypeError('readMedia is required');
  return async function chatMediaHandler(req, res) {
    try {
      const mediaData = await readMedia(req.params.instanceId, req.params.messageId);
      if (!mediaData) {
        res.set('Retry-After', '3');
        return res.status(404).json({ error: 'MEDIA_NOT_READY' });
      }
      const media = decodeAudioDataUri(mediaData);
      const filePath = await cacheAudioFile(cacheDir, media);
      res.set({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline',
        'Content-Type': media.mimeType,
        'X-Content-Type-Options': 'nosniff'
      });
      return res.sendFile(filePath, { acceptRanges: true, cacheControl: false, lastModified: true });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error('[CHAT MEDIA]', error?.stack || error?.message || error);
      return res.status(500).json({ error: 'MEDIA_READ_FAILED' });
    }
  };
}

module.exports = { createChatMediaHandler, decodeAudioDataUri };
