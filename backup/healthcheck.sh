#!/usr/bin/env sh
set -eu

if [ "${BACKUP_ENABLED:-false}" != "true" ]; then
  exit 0
fi

interval="${BACKUP_INTERVAL_SECONDS:-900}"
max_age=$((interval * 3))
now="$(date +%s)"
last="$(stat -c %Y /work/last-success 2>/dev/null || printf '0')"
[ $((now - last)) -le "${max_age}" ]
