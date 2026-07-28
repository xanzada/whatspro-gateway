# whatspro-service — AI Context Map

> **Stack:** express | none | unknown | javascript

> 44 routes (44 inferred) | 0 models | 0 components | 0 lib files | 46 env vars | 1 middleware
> **Token savings:** this file is ~2 500 tokens. Without it, AI exploration would cost ~35 700 tokens. **Saves ~33 200 tokens per conversation.**
> **Last scanned:** 2026-07-28 20:19 — re-run after significant changes

---

# Routes

## CRUD Resources

- **`/api/wa/instances`** GET | POST | GET/:id | DELETE/:id → Instance
- **`/api/wa/tenants`** GET | POST | GET/:id | PATCH/:id | DELETE/:id → Tenant
- **`/api/wa/scan-requests`** GET | POST | GET/:id → Scan-request

## Other Routes

- `GET` `/health` [auth, db, cache, queue] `[inferred]`
- `GET` `/chat.html` [auth, db, cache, queue] `[inferred]`
- `GET` `/whatspro` [auth, db, cache, queue] `[inferred]`
- `GET` `/tenants` [auth, db, cache, queue] `[inferred]`
- `GET` `/` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/whatspro/session` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/whatspro/login` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/whatspro/logout` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/tenant-defaults` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/shared-prompt` [auth, db, cache, queue] `[inferred]`
- `PUT` `/api/wa/shared-prompt` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/tenants/:instanceId/settings` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/clone` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/rotate` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/active` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/scan-requests/:requestId/approve` params(requestId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/scan-requests/:requestId/reject` params(requestId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/scan-requests/:requestId/open` params(requestId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/scan-invitations` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/chat/inbox/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/chat/events/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/chat/inbox-legacy/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/chat/history/:instanceId/:phone` params(instanceId, phone) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/chat/media/:instanceId/:messageId` params(instanceId, messageId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/chat/send/:instanceId/:phone` params(instanceId, phone) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/chat/operator-lock/:instanceId/:phone` params(instanceId, phone) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/chat/action/:instanceId/:phone` params(instanceId, phone) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/start` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/status/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/restart/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/logout` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/send` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/presence` [auth, db, cache, queue] `[inferred]`

---

# Config

## Environment Variables

- `CHAT_PUBLIC_API_BASE` **required** — .env.example
- `NOCODB_CONFIG_CACHE_MAX` (has default) — .env.example
- `NOCODB_CONFIG_CACHE_MS` (has default) — .env.example
- `NOCODB_CONFIG_CIRCUIT_MS` (has default) — .env.example
- `NOCODB_CONFIG_MAX_CONCURRENCY` (has default) — .env.example
- `NOCODB_CONFIG_MAX_PENDING` (has default) — .env.example
- `NOCODB_CONFIG_NEGATIVE_CACHE_MS` (has default) — .env.example
- `NOCODB_CONFIG_QUEUE_TIMEOUT_MS` (has default) — .env.example
- `NOCODB_RESTAURANTS_TABLE_ID` **required** — .env.example
- `NOCODB_TABLE_ID` **required** — .env.example
- `NOCODB_TIMEOUT_MS` (has default) — .env.example
- `NOCODB_TOKEN` **required** — .env.example
- `NOCODB_URL` **required** — .env.example
- `NODE_ENV` **required** — src\server.js
- `OPENBOT_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `OPENBOT_WEBHOOK_TOKEN` **required** — .env.example
- `OPENBOT_WEBHOOK_URL` (has default) — .env.example
- `OPERATOR_ACTIVE_SECONDS` (has default) — .env.example
- `PORT` (has default) — .env.example
- `PUPPETEER_EXECUTABLE_PATH` (has default) — .env.example
- `QA_BASE_URL` **required** — scripts\browser-qa.js
- `QA_EMBED_TOKEN` **required** — scripts\browser-qa.js
- `QA_OUTPUT` **required** — scripts\browser-qa.js
- `REDIS_URL` (has default) — .env.example
- `TRUST_PROXY_HOPS` **required** — src\server.js
- `WHATSAPP_AUTH_PATH` (has default) — .env.example
- `WHATSAPP_CHROME_LOCK_RESTART_DELAY_MS` **required** — services\whatsappManager.js
- `WHATSAPP_INITIALIZE_MAX_RETRIES` (has default) — .env.example
- `WHATSAPP_OUTGOING_QUEUE_MAX` **required** — services\whatsappManager.js
- `WHATSAPP_OUTGOING_QUEUE_TTL_MS` **required** — services\whatsappManager.js
- `WHATSAPP_RESOURCE_RESTART_BASE_DELAY_MS` **required** — services\whatsappManager.js
- `WHATSAPP_RESTART_BASE_DELAY_MS` **required** — services\whatsappManager.js
- `WHATSAPP_RESTART_MAX_DELAY_MS` **required** — services\whatsappManager.js
- `WHATSAPP_RESTORE_TIMEOUT_MS` (has default) — .env.example
- `WHATSAPP_STATE_TIMEOUT_MS` (has default) — .env.example
- `WHATSPRO_API_TOKEN` **required** — .env.example
- `WHATSPRO_BOOT_CONCURRENCY` **required** — src\server.js
- `WHATSPRO_BOOT_GAP_MS` **required** — src\server.js
- `WHATSPRO_DEFAULT_WORK_HOURS` **required** — services\tenantAdmin.js
- `WHATSPRO_DEVELOPER_PHONE` **required** — services\tenantAdmin.js
- `WHATSPRO_PASSWORD` (has default) — .env.example
- `WHATSPRO_PUBLIC_URL` **required** — services\tenantAdmin.js
- `WHATSPRO_SEND_WAL_DIR` **required** — src\server.js
- `WHATSPRO_SESSION_SECRET` (has default) — .env.example
- `WHATSPRO_TENANT_DOMAIN_SUFFIX` **required** — services\tenantAdmin.js
- `WHATSPRO_USER` (has default) — .env.example

## Config Files

- `.env.example`
- `Dockerfile`
- `docker-compose.yml`

## Key Dependencies

- express: ^5.2.1
- puppeteer: ^25.2.1
- redis: ^6.0.1

---

# Middleware

## auth
- requireChatMediaAuth — `src\server.js`

---

# Dependency Graph

## Most Imported Files (change these carefully)

- `config\redis.js` — imported by **7** files
- `services\phoneUtils.js` — imported by **7** files
- `src\server.js` — imported by **6** files
- `services\nocodbConfig.js` — imported by **6** files
- `services\redisReply.js` — imported by **5** files
- `services\chatStore.js` — imported by **5** files
- `services\chatEvents.js` — imported by **5** files
- `services\chatMedia.js` — imported by **4** files
- `services\incomingWebhook.js` — imported by **3** files
- `services\whatsappManager.js` — imported by **3** files
- `services\operatorLock.js` — imported by **2** files
- `services\sosStore.js` — imported by **2** files
- `services\tenantReadiness.js` — imported by **2** files
- `services\tenantAdmin.js` — imported by **2** files
- `public\chat-core.js` — imported by **2** files

## Import Map (who imports what)

- `config\redis.js` ← `services\chatEvents.js`, `services\chatStore.js`, `services\incomingWebhook.js`, `services\operatorLock.js`, `services\sosStore.js` +2 more
- `services\phoneUtils.js` ← `services\chatEvents.js`, `services\chatStore.js`, `services\incomingWebhook.js`, `services\operatorLock.js`, `services\sosStore.js` +2 more
- `src\server.js` ← `scripts\browser-qa.js`, `test\backendDefects.test.js`, `test\realtimeSync.test.js`, `test\routing.test.js`, `test\tenantReadiness.test.js` +1 more
- `services\nocodbConfig.js` ← `services\tenantAdmin.js`, `src\server.js`, `src\server.js`, `test\nocodbConfig.test.js`, `test\tenantReadiness.test.js` +1 more
- `services\redisReply.js` ← `services\chatStore.js`, `services\sosStore.js`, `src\server.js`, `test\sosStore.test.js`, `test\sosStore.test.js`
- `services\chatStore.js` ← `services\incomingWebhook.js`, `services\whatsappManager.js`, `src\server.js`, `test\chatStore.test.js`, `test\pdfReceiptFlow.test.js`
- `services\chatEvents.js` ← `services\incomingWebhook.js`, `services\whatsappManager.js`, `src\server.js`, `test\chatEvents.test.js`, `test\realtimeSync.test.js`
- `services\chatMedia.js` ← `src\server.js`, `test\chatMedia.test.js`, `test\chatStore.test.js`, `test\pdfReceiptFlow.test.js`
- `services\incomingWebhook.js` ← `services\whatsappManager.js`, `test\backendDefects.test.js`, `test\pdfReceiptFlow.test.js`
- `services\whatsappManager.js` ← `src\server.js`, `test\backendDefects.test.js`, `test\pdfReceiptFlow.test.js`

---

_Generated by [codesight](https://github.com/Houseofmvps/codesight) — see your codebase clearly_