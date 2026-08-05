# Config

## Environment Variables

- `CHAT_PUBLIC_API_BASE` **required** — .env.example
- `LOG_QR_TO_TERMINAL` **required** — services\whatsappManager.js
- `NODE_ENV` **required** — services\whatsappManager.js
- `NODE_TEST_CONTEXT` **required** — services\tenantStore.js
- `OPENBOT_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `OPENBOT_WEBHOOK_TOKEN` **required** — .env.example
- `OPENBOT_WEBHOOK_URL` (has default) — .env.example
- `OPERATOR_ACTIVE_SECONDS` (has default) — .env.example
- `PORT` (has default) — .env.example
- `PUPPETEER_EXECUTABLE_PATH` (has default) — .env.example
- `QA_BASE_URL` **required** — scripts\browser-qa.js
- `QA_EMBED_TOKEN` **required** — scripts\browser-qa.js
- `QA_OUTPUT` **required** — scripts\browser-qa.js
- `REDIS_CONNECT_TIMEOUT_MS` (has default) — .env.example
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
- `WHATSPRO_INBOUND_WAL_DIR` **required** — .env.example
- `WHATSPRO_INBOUND_WAL_INTERVAL_MS` (has default) — .env.example
- `WHATSPRO_INBOUND_WAL_MAX` (has default) — .env.example
- `WHATSPRO_INBOUND_WAL_MAX_AGE_MS` (has default) — .env.example
- `WHATSPRO_PASSWORD` (has default) — .env.example
- `WHATSPRO_PUBLIC_URL` **required** — services\tenantAdmin.js
- `WHATSPRO_SEND_WAL_DIR` **required** — src\server.js
- `WHATSPRO_SESSION_SECRET` (has default) — .env.example
- `WHATSPRO_TENANT_DOMAIN_SUFFIX` **required** — services\tenantAdmin.js
- `WHATSPRO_TENANT_SNAPSHOT_PATH` **required** — .env.example
- `WHATSPRO_USER` (has default) — .env.example

## Config Files

- `.env.example`
- `Dockerfile`
- `docker-compose.yml`

## Key Dependencies

- express: ^5.2.1
- puppeteer: ^25.2.1
- redis: ^6.0.1
