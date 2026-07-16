const { redisClient } = require('../config/redis');
const { normalizePhone } = require('./phoneUtils');

const OPERATOR_ACTIVE_SECONDS = Number(process.env.OPERATOR_ACTIVE_SECONDS || 60);

function operatorActiveKey(instanceId, phone) {
  return `operator_active:${instanceId}:${phone}`;
}

async function markOperatorActive(instanceId, phone, source = 'operator') {
  const safeInstanceId = String(instanceId || '').trim();
  const safePhone = normalizePhone(phone);

  if (!safeInstanceId || !safePhone || !redisClient.isOpen) return false;

  await redisClient.setEx(operatorActiveKey(safeInstanceId, safePhone), OPERATOR_ACTIVE_SECONDS, source);
  return true;
}

module.exports = {
  OPERATOR_ACTIVE_SECONDS,
  markOperatorActive,
  operatorActiveKey
};
