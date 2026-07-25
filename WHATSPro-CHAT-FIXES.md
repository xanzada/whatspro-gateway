# WhatsPro Chat retention and photo support

## Preserved behavior

- Existing operator-chat layout, tabs, colors, message roles, archive/restore behavior, polling, audio playback and API routes remain intact.
- Standard conversations use a rolling 24-hour retention window.
- Archived conversations use a rolling 72-hour retention window.
- A new incoming customer message reopens an archived chat and returns it to the 24-hour window.

## Reliability fixes

- Redis local fallback now uses AOF with `appendfsync everysec` and a health check.
- `REDIS_URL` can point WhatsPro and OpenBot to the same shared Redis; local Redis remains the safe default.
- State, archive marker, expiry index, history, receipts and media TTLs are transitioned together.
- Expiry cleanup verifies authoritative Redis keys and repairs stale expiry metadata instead of hiding a live chat.
- Inbox cleanup no longer removes a valid conversation merely because the recent sample contains no customer text.
- Inbox capacity was raised from 500 to 1000 active conversations without changing the interface.

## Photo support

- Incoming JPEG, PNG, GIF and WebP images are accepted.
- Captionless photos remain visible in the inbox.
- Image payloads are validated by MIME type, base64 integrity, size and file signature.
- Images are limited to 5 MB and stored separately from history with the same 24/72-hour TTL.
- Photos render inside the existing message-bubble design and open full-size in a new tab.

## Deployment note

For OpenBot operator cases and WhatsPro Chat to share state, configure the same `REDIS_URL` for both services. If no external URL is configured, the included local Redis runs with durable AOF persistence.
