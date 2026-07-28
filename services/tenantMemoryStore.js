'use strict';

const crypto = require('crypto');
const { redisClient } = require('../config/redis');
const { findRow, normalizeInstance } = require('./tenantStore');

const MAX_MEMORIES = 100;

function memoryKey(instanceId) {
  return `whatspro:tenant-memory:v1:${instanceId}`;
}

function requireStore(instanceId) {
  const instance = normalizeInstance(instanceId);
  if (!instance) {
    const error = new Error('BAD_INSTANCE_ID');
    error.statusCode = 400;
    throw error;
  }
  if (!redisClient.isOpen) {
    const error = new Error('PLATFORM_STORE_UNAVAILABLE');
    error.statusCode = 503;
    throw error;
  }
  return instance;
}

async function requireTenant(instanceId) {
  const instance = requireStore(instanceId);
  if (!await findRow(instance)) {
    const error = new Error('TENANT_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  return instance;
}

async function listMemories(instanceId) {
  const instance = await requireTenant(instanceId);
  const values = await redisClient.lRange(memoryKey(instance), 0, MAX_MEMORIES - 1);
  return values.map(value => {
    try { return JSON.parse(value); } catch { return null; }
  }).filter(Boolean);
}

async function addMemory(instanceId, value) {
  const instance = await requireTenant(instanceId);
  const record = {
    id: crypto.randomUUID(),
    instance_id: instance,
    question: String(value?.question || '').trim().slice(0, 500),
    ideal_answer: String(value?.ideal_answer || '').trim().slice(0, 4000),
    category: String(value?.category || 'general').trim().slice(0, 80),
    created_at: new Date().toISOString()
  };
  if (!record.question || !record.ideal_answer) {
    const error = new Error('MEMORY_FIELDS_INVALID');
    error.statusCode = 400;
    throw error;
  }
  await redisClient.lPush(memoryKey(instance), JSON.stringify(record));
  await redisClient.lTrim(memoryKey(instance), 0, MAX_MEMORIES - 1);
  return record;
}

module.exports = { MAX_MEMORIES, addMemory, listMemories, memoryKey };
