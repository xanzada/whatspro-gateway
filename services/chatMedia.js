const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('fluent-ffmpeg');
const bundledFfmpegPath = require('ffmpeg-static');

function resolveFfmpegPath(env = process.env, bundledPath = bundledFfmpegPath) {
  return String(env.FFMPEG_PATH || bundledPath || 'ffmpeg').trim();
}

const ffmpegPath = resolveFfmpegPath();
ffmpeg.setFfmpegPath(ffmpegPath);

const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'whatspro-audio-cache');
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const EXTENSIONS = new Map([
  ['audio/ogg', '.ogg'], ['audio/opus', '.ogg'], ['audio/webm', '.webm'],
  ['audio/mpeg', '.mp3'], ['audio/mp4', '.m4a'], ['audio/wav', '.wav'], ['audio/x-wav', '.wav']
]);
const transcodeJobs = new Map();

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

function decodeImageDataUri(value) {
  const match = String(value || '').trim().match(/^data:(image\/[a-z0-9][a-z0-9.+_-]*);base64,([\s\S]+)$/i);
  if (!match) throw mediaError('INVALID_IMAGE_DATA_URI', 422);
  const mimeType = match[1].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) throw mediaError('UNSUPPORTED_IMAGE_TYPE', 415);
  const base64 = match[2].replace(/\s+/g, '');
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw mediaError('INVALID_IMAGE_BASE64', 422);
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== base64) throw mediaError(buffer.length > MAX_IMAGE_BYTES ? 'IMAGE_TOO_LARGE' : 'INVALID_IMAGE_BASE64', 422);
  const valid = (mimeType === 'image/jpeg' && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (mimeType === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) ||
    (mimeType === 'image/gif' && ['GIF87a','GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) ||
    (mimeType === 'image/webp' && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!valid) throw mediaError('IMAGE_SIGNATURE_INVALID', 422);
  return { buffer, mimeType };
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

async function isUsableMp4(filePath) {
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.subarray(4, 8).toString('ascii') === 'ftyp';
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runFfmpeg(inputPath, outputPath) {
  if (!ffmpegPath) return Promise.reject(mediaError('TRANSCODER_UNAVAILABLE', 503));
  return new Promise((resolve, reject) => {
    const command = ffmpeg(inputPath)
      .noVideo()
      .audioCodec('aac')
      .audioBitrate('64k')
      .format('mp4')
      .outputOptions(['-movflags', '+faststart'])
      .on('error', error => { clearTimeout(timeout); reject(error); })
      .on('end', () => { clearTimeout(timeout); resolve(); });
    const timeout = setTimeout(() => command.kill('SIGKILL'), 60000);
    timeout.unref();
    command.save(outputPath);
  });
}

async function cacheMp4Fallback(cacheDir, sourcePath, media) {
  if (media.mimeType === 'audio/mp4') return sourcePath;
  const digest = crypto.createHash('sha256').update(media.buffer).digest('hex');
  const outputPath = path.join(cacheDir, `${digest}.m4a`);
  if (await isUsableMp4(outputPath)) return outputPath;
  await fs.unlink(outputPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (transcodeJobs.has(outputPath)) return transcodeJobs.get(outputPath);
  const job = (async () => {
    const temporaryPath = path.join(cacheDir, `${digest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.m4a`);
    try {
      await runFfmpeg(sourcePath, temporaryPath);
      if (!await isUsableMp4(temporaryPath)) throw mediaError('TRANSCODE_INVALID_OUTPUT', 500);
      try {
        await fs.rename(temporaryPath, outputPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const cleanup = setTimeout(() => fs.unlink(outputPath).catch(() => {}), CACHE_TTL_MS);
      cleanup.unref();
      return outputPath;
    } finally {
      await fs.unlink(temporaryPath).catch(() => {});
    }
  })();
  transcodeJobs.set(outputPath, job);
  try {
    return await job;
  } finally {
    transcodeJobs.delete(outputPath);
  }
}

function createChatMediaHandler({ readMedia, recoverMedia, cacheDir = DEFAULT_CACHE_DIR } = {}) {
  if (typeof readMedia !== 'function') throw new TypeError('readMedia is required');
  return async function chatMediaHandler(req, res) {
    try {
      let mediaData = await readMedia(req.params.instanceId, req.params.messageId);
      if (!mediaData && typeof recoverMedia === 'function') {
        try {
          mediaData = await recoverMedia(req.params.instanceId, req.params.messageId, req);
        } catch (error) {
          console.warn('[CHAT MEDIA RECOVERY]', error?.message || error);
        }
      }
      if (!mediaData) {
        res.set('Retry-After', '3');
        return res.status(404).json({ error: 'MEDIA_NOT_READY' });
      }
      if (/^data:image\//i.test(mediaData)) {
        if (req.query?.fmt) throw mediaError('UNSUPPORTED_OUTPUT_FORMAT', 400);
        const image = decodeImageDataUri(mediaData);
        res.set({
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': 'inline',
          'Content-Length': String(image.buffer.length),
          'Content-Type': image.mimeType,
          'X-Content-Type-Options': 'nosniff'
        });
        return res.status(200).send(image.buffer);
      }
      const media = decodeAudioDataUri(mediaData);
      const requestedFormat = String(req.query?.fmt || '').toLowerCase();
      if (requestedFormat && requestedFormat !== 'mp4') throw mediaError('UNSUPPORTED_OUTPUT_FORMAT', 400);
      const sourcePath = await cacheAudioFile(cacheDir, media);
      const filePath = requestedFormat === 'mp4' ? await cacheMp4Fallback(cacheDir, sourcePath, media) : sourcePath;
      const responseType = requestedFormat === 'mp4' ? 'audio/mp4' : media.mimeType;
      res.set({
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=3600',
        'Content-Disposition': 'inline',
        'Content-Type': responseType,
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

module.exports = { createChatMediaHandler, decodeAudioDataUri, decodeImageDataUri, resolveFfmpegPath };
