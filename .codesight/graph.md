# Dependency Graph

## Most Imported Files (change these carefully)

- `config\redis.js` — imported by **10** files
- `services\tenantStore.js` — imported by **9** files
- `services\phoneUtils.js` — imported by **7** files
- `src\server.js` — imported by **6** files
- `services\redisReply.js` — imported by **5** files
- `services\chatStore.js` — imported by **5** files
- `services\chatEvents.js` — imported by **5** files
- `services\chatMedia.js` — imported by **4** files
- `services\incomingWebhook.js` — imported by **3** files
- `services\whatsappManager.js` — imported by **3** files
- `services\operatorLock.js` — imported by **2** files
- `services\sosStore.js` — imported by **2** files
- `services\tenantMemoryStore.js` — imported by **2** files
- `services\tenantReadiness.js` — imported by **2** files
- `services\tenantAdmin.js` — imported by **2** files
- `services\tenantWorkbook.js` — imported by **2** files
- `public\chat-core.js` — imported by **2** files

## Import Map (who imports what)

- `config\redis.js` ← `services\chatEvents.js`, `services\chatStore.js`, `services\incomingWebhook.js`, `services\operatorLock.js`, `services\sosStore.js` +5 more
- `services\tenantStore.js` ← `services\tenantAdmin.js`, `services\tenantMemoryStore.js`, `src\server.js`, `test\routing.test.js`, `test\tenantAdmin.test.js` +4 more
- `services\phoneUtils.js` ← `services\chatEvents.js`, `services\chatStore.js`, `services\incomingWebhook.js`, `services\operatorLock.js`, `services\sosStore.js` +2 more
- `src\server.js` ← `scripts\browser-qa.js`, `test\backendDefects.test.js`, `test\realtimeSync.test.js`, `test\routing.test.js`, `test\tenantReadiness.test.js` +1 more
- `services\redisReply.js` ← `services\chatStore.js`, `services\sosStore.js`, `src\server.js`, `test\sosStore.test.js`, `test\sosStore.test.js`
- `services\chatStore.js` ← `services\incomingWebhook.js`, `services\whatsappManager.js`, `src\server.js`, `test\chatStore.test.js`, `test\pdfReceiptFlow.test.js`
- `services\chatEvents.js` ← `services\incomingWebhook.js`, `services\whatsappManager.js`, `src\server.js`, `test\chatEvents.test.js`, `test\realtimeSync.test.js`
- `services\chatMedia.js` ← `src\server.js`, `test\chatMedia.test.js`, `test\chatStore.test.js`, `test\pdfReceiptFlow.test.js`
- `services\incomingWebhook.js` ← `services\whatsappManager.js`, `test\backendDefects.test.js`, `test\pdfReceiptFlow.test.js`
- `services\whatsappManager.js` ← `src\server.js`, `test\backendDefects.test.js`, `test\pdfReceiptFlow.test.js`
