const axios = require('axios');

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function getInboundWebhookUrl() {
  const raw = String(process.env.INBOUND_WEBHOOK_URL || '').trim();
  if (!raw) return '';

  const unquoted = raw.replace(/^['"]|['"]$/g, '').trim();
  return unquoted.split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean)[0] || '';
}

function getInboundWebhookToken() {
  return String(process.env.INBOUND_WEBHOOK_TOKEN || '').trim().replace(/^['"]|['"]$/g, '').trim();
}

async function forwardIncomingWhatsAppMessage(payload) {
  const url = getInboundWebhookUrl();
  if (!url) {
    console.warn('[INBOUND WEBHOOK] skipped: INBOUND_WEBHOOK_URL is not configured');
    return false;
  }

  const started = Date.now();
  const token = getInboundWebhookToken();

  try {
    const response = await axios.post(url, payload, {
      timeout: Number(process.env.INBOUND_WEBHOOK_TIMEOUT_MS || 8000),
      headers: stripUndefined({
        authorization: token ? `Bearer ${token}` : undefined,
        'x-api-key': token || undefined,
        'content-type': 'application/json'
      })
    });

    console.log(`[INBOUND WEBHOOK] delivered status=${response.status} elapsed=${Date.now() - started}ms instance=${payload.instanceId || payload.instance || '-'} messageId=${payload.messageId || '-'}`);
  } catch (error) {
    console.error(`[INBOUND WEBHOOK] failed elapsed=${Date.now() - started}ms status=${error.response?.status || '-'} url=${url} error=${error.message}`);
    throw error;
  }

  return true;
}

module.exports = { forwardIncomingWhatsAppMessage, getInboundWebhookUrl, getInboundWebhookToken };
