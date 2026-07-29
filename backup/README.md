# Encrypted offsite backups

The backup sidecar snapshots Redis and, for WhatsPro, the persistent WhatsApp
authentication volume. Snapshots are compressed, encrypted with an off-server
age recipient, split below GitHub's per-file limit, and force-pushed to two
alternating branches:

- `snapshot-whatspro-a`
- `snapshot-whatspro-b`

The alternating branches keep two independently restorable points without
growing normal Git history forever. No tenant secret or WhatsApp session is
committed in plaintext.

Required production settings:

- `BACKUP_ENABLED=true`
- `BACKUP_GIT_URL`
- `BACKUP_SSH_PRIVATE_KEY_B64`
- `BACKUP_AGE_RECIPIENT_B64`
- `BACKUP_INTERVAL_SECONDS` (minimum 300, default 900)

To decrypt a snapshot, install `age`, `git`, and `zstd`, then run:

```sh
./backup/restore.sh \
  git@github.com:OWNER/whatspro-backup-vault.git \
  snapshot-whatspro-a \
  /secure/path/whatspro-age-identity
```

The restore tool verifies both encrypted chunks and the decrypted Redis/auth
checksums. It only extracts files; replacing live volumes remains an explicit
operator action.

The WhatsApp archive excludes Chromium caches that are recreated automatically.
Credentials, cookies, local/session storage and the Redis tenant database remain
inside the encrypted snapshot.
