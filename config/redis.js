const { createClient } = require('redis');

const redisUrl = String(process.env.REDIS_URL || '').trim();

const redisClient = redisUrl ? createClient({ url: redisUrl }) : createClient();

redisClient.on('error', error => {
  console.error('[REDIS] client error:', error.message);
});

async function connectRedis() {
  if (redisClient.isOpen) return redisClient;

  try {
    await redisClient.connect();
    console.log('[REDIS] connected');
  } catch (error) {
    console.warn('[REDIS] unavailable:', error.message);
  }

  return redisClient;
}

module.exports = { connectRedis, redisClient };
