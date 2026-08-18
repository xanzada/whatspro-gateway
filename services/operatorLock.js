const { redisClient } = require('../config/redis');
const { normalizePhone } = require('./phoneUtils');

const OPERATOR_ACTIVE_SECONDS = Number(process.env.OPERATOR_ACTIVE_SECONDS || 40);

function operatorActiveKey(instanceId, phone) {
  return `operator_active:${instanceId}:${phone}`;
}

function operatorActiveCommand(instanceId, phone, source) {
  return ['SET', operatorActiveKey(instanceId, phone), source, 'EX', String(OPERATOR_ACTIVE_SECONDS)];
}

async function markOperatorActive(instanceId, phone, source = 'operator') {
  const safeInstanceId = String(instanceId || '').trim();
  const safePhone = normalizePhone(phone);

  if (!safeInstanceId || !safePhone || !redisClient.isOpen) return false;

  // SET with EX is intentionally issued on every human message. Redis replaces
  // the old expiry, so an operator who continues typing gets a fresh 40-second
  // handoff window instead of racing the first message's timer.
  await redisClient.sendCommand(operatorActiveCommand(safeInstanceId, safePhone, source));
  return true;
}

module.exports = {
  OPERATOR_ACTIVE_SECONDS,
  markOperatorActive,
  operatorActiveKey,
  __test: { operatorActiveCommand }
};
