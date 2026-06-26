const { createClient } = require('redis');

const redisClient = createClient({
    url: process.env.REDIS_URL
});

redisClient.on('error', (err) => console.error('❌ Redis қателігі:', err.message));
redisClient.on('connect', () => console.log('✅ Redis сәтті қосылды!'));

async function connectRedis() {
    try {
        if (!process.env.REDIS_URL) {
            throw new Error('REDIS_URL is not configured');
        }
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
    } catch (err) {
        console.error('❌ Redis қосылу мүмкін болмады:', err.message);
        throw err;
    }
}

module.exports = { redisClient, connectRedis };