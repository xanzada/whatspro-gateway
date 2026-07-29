const { createClient } = require('redis');

const redisUrl = String(process.env.REDIS_URL || '').trim();
const connectTimeoutMs = Math.max(500, Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 2500));

const redisClient = redisUrl
  ? createClient({
      url: redisUrl,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: retries => Math.min(250 * (2 ** Math.min(retries, 5)), 5000)
      }
    })
  : createClient({
      disableOfflineQueue: true,
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: retries => Math.min(250 * (2 ** Math.min(retries, 5)), 5000)
      }
    });

let connectPromise = null;
let connectedLogged = false;

redisClient.on('error', error => {
  console.error('[REDIS] client error:', error.message);
});

async function connectRedis() {
  if (redisClient.isReady) return redisClient;

  if (!connectPromise && !redisClient.isOpen) {
    connectPromise = redisClient.connect()
      .then(() => {
        if (!connectedLogged) console.log('[REDIS] connected');
        connectedLogged = true;
      })
      .catch(error => {
        console.warn('[REDIS] unavailable:', error.message);
      })
      .finally(() => {
        connectPromise = null;
      });
  }

  if (connectPromise) {
    let timer;
    await Promise.race([
      connectPromise,
      new Promise(resolve => {
        timer = setTimeout(resolve, connectTimeoutMs);
        timer.unref?.();
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  return redisClient;
}

module.exports = { connectRedis, redisClient, getRedisState: () => ({
  open: redisClient.isOpen,
  ready: redisClient.isReady,
  target: (() => {
    try { return new URL(redisUrl || 'redis://localhost:6379').host; } catch { return 'invalid'; }
  })()
}) };
