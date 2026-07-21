const crypto = require('crypto');
const { EventEmitter } = require('events');
const { redisClient } = require('../config/redis');
const { normalizePhone } = require('./phoneUtils');

const localEvents = new EventEmitter();
localEvents.setMaxListeners(0);
const processId = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
const channelStates = new Map();
let subscriber = null;
let subscriberPromise = null;

function chatEventChannel(instanceId) {
  return `chatwoot:events:${instanceId}`;
}

function normalizeEvent(event = {}) {
  const instanceId = String(event.instanceId || '').trim();
  if (!instanceId) throw new Error('INSTANCE_REQUIRED');
  return {
    ...event,
    instanceId,
    phone: event.phone ? normalizePhone(event.phone) : undefined,
    eventId: event.eventId || crypto.randomUUID(),
    emittedAt: Number(event.emittedAt || Date.now()),
    origin: processId
  };
}

async function getSubscriber() {
  if (!redisClient.isOpen || typeof redisClient.duplicate !== 'function') return null;
  if (subscriber?.isOpen) return subscriber;
  if (subscriberPromise) return subscriberPromise;
  subscriberPromise = (async () => {
    const client = redisClient.duplicate();
    client.on('error', error => console.error('[CHAT EVENTS] subscriber error:', error.message));
    client.on('end', () => {
      if (subscriber === client) subscriber = null;
      subscriberPromise = null;
      for (const [channel, state] of channelStates) {
        state.subscribed = false;
        ensureChannelSubscription(channel).catch(() => {});
      }
    });
    await client.connect();
    subscriber = client;
    return client;
  })().catch(error => {
    subscriberPromise = null;
    console.warn('[CHAT EVENTS] subscriber unavailable:', error.message);
    return null;
  });
  return subscriberPromise;
}

async function ensureChannelSubscription(channel) {
  const state = channelStates.get(channel);
  if (!state || state.subscribed || state.connecting) return;
  state.connecting = true;
  try {
    const client = await getSubscriber();
    if (!client) throw new Error('REDIS_SUBSCRIBER_UNAVAILABLE');
    await client.subscribe(channel, raw => {
      try {
        const event = JSON.parse(raw);
        if (event?.origin !== processId) localEvents.emit(channel, event);
      } catch { /* Ignore malformed external events. */ }
    });
    state.subscribed = true;
  } catch (error) {
    if (channelStates.has(channel) && !state.retryTimer) {
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        ensureChannelSubscription(channel).catch(() => {});
      }, 5000);
      state.retryTimer.unref?.();
    }
  } finally {
    state.connecting = false;
  }
}

async function publishChatEvent(event) {
  const normalized = normalizeEvent(event);
  const channel = chatEventChannel(normalized.instanceId);
  localEvents.emit(channel, normalized);
  if (redisClient.isOpen) await redisClient.publish(channel, JSON.stringify(normalized)).catch(() => 0);
  return normalized;
}

async function subscribeChatEvents(instanceId, listener) {
  const safeInstanceId = String(instanceId || '').trim();
  if (!safeInstanceId || typeof listener !== 'function') throw new Error('SUBSCRIPTION_INVALID');
  const channel = chatEventChannel(safeInstanceId);
  localEvents.on(channel, listener);
  const state = channelStates.get(channel) || { refs: 0, subscribed: false, connecting: false, retryTimer: null };
  state.refs += 1;
  channelStates.set(channel, state);
  await ensureChannelSubscription(channel);

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    localEvents.off(channel, listener);
    const active = channelStates.get(channel);
    if (!active) return;
    active.refs = Math.max(0, active.refs - 1);
    if (!active.refs) {
      channelStates.delete(channel);
      if (active.retryTimer) clearTimeout(active.retryTimer);
      if (active.subscribed && subscriber?.isOpen) subscriber.unsubscribe(channel).catch(() => {});
    }
  };
}

module.exports = { chatEventChannel, publishChatEvent, subscribeChatEvents };
