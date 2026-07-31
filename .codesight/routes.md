# Routes

## CRUD Resources

- **`/api/wa/instances`** GET | POST | GET/:id | DELETE/:id → Instance
- **`/api/wa/tenants`** GET | POST | GET/:id | PATCH/:id | DELETE/:id → Tenant
- **`/api/wa/scan-requests`** GET | POST | GET/:id → Scan-request

## Other Routes

- `GET` `/health` [auth, db, cache, queue] `[inferred]`
- `GET` `/favicon.ico` [auth, db, cache, queue] `[inferred]`
- `GET` `/chat.html` [auth, db, cache, queue] `[inferred]`
- `GET` `/whatspro` [auth, db, cache, queue] `[inferred]`
- `GET` `/tenants` [auth, db, cache, queue] `[inferred]`
- `GET` `/connect` [auth, db, cache, queue] `[inferred]`
- `GET` `/` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/backups/tenants.xlsx` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/backups/tenants/import` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/tenant-defaults` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/platform-storage` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/runtime-configs` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/runtime-configs/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/runtime-configs/:instanceId/memories` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/runtime-configs/:instanceId/memories` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/shared-prompt` [auth, db, cache, queue] `[inferred]`
- `PUT` `/api/wa/shared-prompt` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/tenants/:instanceId/settings` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/clone` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/rotate` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/active` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/bot-enabled` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/tenants/:instanceId/connect-link` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/connect/:token/status` params(token) [auth, db, cache, queue] `[inferred]`
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
- `POST` `/api/wa/statuses` [auth, db, cache, queue] `[inferred]`
- `GET` `/api/wa/status/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/restart/:instanceId` params(instanceId) [auth, db, cache, queue] `[inferred]`
- `POST` `/api/wa/logout` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/send` [auth, db, cache, queue] `[inferred]`
- `POST` `/api/presence` [auth, db, cache, queue] `[inferred]`
