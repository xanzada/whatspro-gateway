# WhatsPro Service

Standalone WhatsApp Web API Gateway.

## Transport

Messages and calls both ride a single `@whiskeysockets/baileys` socket
(`services/baileysClient.js`), so **one QR scan per tenant** registers everything —
there is no separate call-watcher QR. The client reimplements the `whatsapp-web.js`
`Client` surface, which keeps `services/whatsappManager.js` transport-agnostic.

`WHATSPRO_TRANSPORT` (default `baileys`) and `WHATSPRO_WWEBJS_INSTANCES` switch a tenant
back to the old `whatsapp-web.js`/Chromium path — a restart, no rebuild. That is why
puppeteer and Chromium are still present in the image.

For connecting a website/platform to the bot, see the contract in the companion repo:
[Openbot-fastfood → docs/integration/site-integration.md](https://github.com/xanzada/Openbot-fastfood/blob/main/docs/integration/site-integration.md)

## Deploy

1. Push this folder as a separate GitHub repo.
2. Easypanel app type: Dockerfile.
3. Add env from `.env.example`.
4. Add persistent volume:
   - `/app/whatsapp_auth`

Production requires `WHATSPRO_SESSION_SECRET` and `WHATSPRO_API_TOKEN` of at
least 32 characters plus a non-default `WHATSPRO_PASSWORD` of at least 12
characters. Set `TRUST_PROXY_HOPS` only when the service is behind that exact
number of trusted reverse proxies.

The operator chat pages require an authenticated WhatsPro session. Chats use
an exclusive `new` / `all` / `operator` / `archive` state, synchronize through
authenticated server-sent events, expire after 24 hours, and are retained for
72 hours while archived. Operator replies reset the AI handoff lock to 60
seconds.

## HTTP contract

Send message/media:

```http
POST /api/send
Authorization: Bearer ${WHATSPRO_API_TOKEN}
Content-Type: application/json
```

```json
{
  "instanceId": "prestige",
  "phone": "7776884956",
  "text": "Сәлем"
}
```

Media:

```json
{
  "instanceId": "prestige",
  "phone": "7776884956",
  "text": "Чек",
  "media": {
    "base64": "data:image/jpeg;base64,...",
    "fileName": "receipt.jpg",
    "caption": "Чек"
  }
}
```

## Existing `whatsappManager.js` adaptation

Core logic stays unchanged. Only replace the internal `handleWebhook(mockReq, mockRes)` call inside `client.on('message')` with:

```js
const { forwardIncomingWhatsAppMessage } = require('./incomingWebhook');

await forwardIncomingWhatsAppMessage({
  event: 'messages.upsert',
  source: 'whatspro',
  instance: instanceId,
  instanceId,
  sender: realSender,
  normalizedPhone: cleanNumber,
  senderPhone: cleanNumber,
  messageId: msg.id.id,
  fromMe: msg.fromMe,
  type: msg.type,
  hasMedia: msg.hasMedia,
  body: msg.body || '',
  pushName: msg._data?.notifyName || contactInfo.pushName || contactInfo.name || 'Client',
  contact: contactInfo,
  data: {
    normalizedPhone: cleanNumber,
    senderPhone: cleanNumber,
    key: { remoteJid: realSender, fromMe: msg.fromMe, id: msg.id.id },
    message: messagePayload,
    pushName: msg._data?.notifyName || contactInfo.pushName || contactInfo.name || 'Client',
    contact: contactInfo
  }
});
```

This repo already contains a copied `services/whatsappManager.js`; only the transport bridge should be different from the monolith.
