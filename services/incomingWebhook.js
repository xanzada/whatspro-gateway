const axios = require('axios');

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

async function forwardIncomingWhatsAppMessage(payload) {
  const url = process.env.INBOUND_WEBHOOK_URL;
  if (!url) return false;

  await axios.post(url, payload, {
    timeout: Number(process.env.INBOUND_WEBHOOK_TIMEOUT_MS || 8000),
    headers: stripUndefined({
      authorization: process.env.INBOUND_WEBHOOK_TOKEN ? `Bearer ${process.env.INBOUND_WEBHOOK_TOKEN}` : undefined,
      'x-api-key': process.env.INBOUND_WEBHOOK_TOKEN || undefined,
      'content-type': 'application/json'
    })
  });

  return true;
}

module.exports = { forwardIncomingWhatsAppMessage };
