#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

readonly GITHUB_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
readonly WORK_ROOT='/work'
readonly REPO_DIR='/work/repository'
readonly SSH_DIR='/work/.ssh'
readonly SUCCESS_FILE='/work/last-success'

log() {
  printf '%s [backup:%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "${BACKUP_SOURCE_NAME:-unknown}" "$*"
}

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    log "required setting is missing: ${name}"
    return 1
  fi
}

decode_b64() {
  printf '%s' "$1" | base64 -d
}

configure_ssh() {
  mkdir -p "${SSH_DIR}"
  decode_b64 "${BACKUP_SSH_PRIVATE_KEY_B64}" > "${SSH_DIR}/id_ed25519"
  chmod 0600 "${SSH_DIR}/id_ed25519"
  printf '%s\n' "${GITHUB_HOST_KEY}" > "${SSH_DIR}/known_hosts"
  chmod 0600 "${SSH_DIR}/known_hosts"
  export GIT_SSH_COMMAND="ssh -i ${SSH_DIR}/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${SSH_DIR}/known_hosts"
}

prepare_repository() {
  mkdir -p "${REPO_DIR}"
  if [[ ! -d "${REPO_DIR}/.git" ]]; then
    git -C "${REPO_DIR}" init --quiet
    git -C "${REPO_DIR}" remote add origin "${BACKUP_GIT_URL}"
  fi
  git -C "${REPO_DIR}" config user.name 'WhatsPro Backup'
  git -C "${REPO_DIR}" config user.email 'backup@whatspro.local'
}

next_slot() {
  local current='b'
  [[ -f "${WORK_ROOT}/slot" ]] && current="$(tr -cd 'ab' < "${WORK_ROOT}/slot" | head -c 1)"
  if [[ "${current}" == 'a' ]]; then
    printf 'b'
  else
    printf 'a'
  fi
}

write_manifest() {
  local stage="$1"
  local created="$2"
  local redis_hash auth_hash auth_present
  [[ -s "${stage}/redis.rdb" ]] || {
    log 'Redis snapshot is missing or empty'
    return 1
  }
  redis_hash="$(sha256sum "${stage}/redis.rdb")" || return 1
  redis_hash="${redis_hash%% *}"
  auth_hash=''
  auth_present='false'
  if [[ -f "${stage}/whatsapp_auth.tar" ]]; then
    auth_hash="$(sha256sum "${stage}/whatsapp_auth.tar")" || return 1
    auth_hash="${auth_hash%% *}"
    auth_present='true'
  fi
  printf '{"format":1,"source":"%s","createdAt":"%s","redisSha256":"%s","whatsappAuthIncluded":%s,"whatsappAuthSha256":"%s"}\n' \
    "${BACKUP_SOURCE_NAME}" "${created}" "${redis_hash}" "${auth_present}" "${auth_hash}" > "${stage}/manifest.json" || return 1
}

make_snapshot() {
  local stage="$1"
  local recipient="$2"
  local created="$3"
  local -a payload=('manifest.json' 'redis.rdb')

  if ! redis-cli --no-auth-warning -u "${REDIS_URL}" --rdb "${stage}/redis.rdb" >/dev/null; then
    log 'redis-cli failed to create an RDB snapshot'
    return 1
  fi
  [[ -s "${stage}/redis.rdb" ]] || {
    log 'redis-cli returned without a usable RDB snapshot'
    return 1
  }
  if [[ -d /source/whatsapp_auth ]]; then
    # Chromium can recreate these caches. Excluding them keeps the offsite
    # snapshot focused on WhatsApp credentials, cookies and durable browser
    # storage instead of repeatedly pushing hundreds of megabytes of cache.
    tar -C /source --numeric-owner \
      --exclude='*/Cache/*' \
      --exclude='*/Code Cache/*' \
      --exclude='*/GPUCache/*' \
      --exclude='*/GrShaderCache/*' \
      --exclude='*/ShaderCache/*' \
      --exclude='*/DawnCache/*' \
      --exclude='*/GraphiteDawnCache/*' \
      --exclude='*/Media Cache/*' \
      --exclude='*/Service Worker/CacheStorage/*' \
      --exclude='*/Service Worker/ScriptCache/*' \
      --exclude='*/Crashpad/*' \
      --exclude='*/blob_storage/*' \
      --exclude='*/BrowserMetrics-*' \
      --exclude='*/DevToolsActivePort' \
      --exclude='*/SingletonCookie' \
      --exclude='*/SingletonLock' \
      --exclude='*/SingletonSocket' \
      -cf "${stage}/whatsapp_auth.tar" whatsapp_auth || return 1
    [[ -s "${stage}/whatsapp_auth.tar" ]] || {
      log 'WhatsApp authentication archive is empty'
      return 1
    }
    payload+=('whatsapp_auth.tar')
  fi
  write_manifest "${stage}" "${created}" || return 1

  tar -C "${stage}" -cf - "${payload[@]}" \
    | zstd -T0 -8 --quiet \
    | age -r "${recipient}" \
    | split -b 90m -d -a 3 - "${stage}/snapshot.tar.zst.age.part-" || return 1

  compgen -G "${stage}/snapshot.tar.zst.age.part-*" >/dev/null || {
    log 'encrypted snapshot has no output parts'
    return 1
  }

  (
    cd "${stage}"
    sha256sum snapshot.tar.zst.age.part-* > encrypted-parts.sha256
  ) || return 1
}

publish_snapshot() {
  local stage="$1"
  local branch="$2"
  local created="$3"

  git -C "${REPO_DIR}" checkout --orphan snapshot-build >/dev/null 2>&1 || {
    git -C "${REPO_DIR}" checkout --detach >/dev/null 2>&1 || true
    git -C "${REPO_DIR}" branch -D snapshot-build >/dev/null 2>&1 || true
    git -C "${REPO_DIR}" checkout --orphan snapshot-build >/dev/null 2>&1
  }
  git -C "${REPO_DIR}" rm -rf --ignore-unmatch . >/dev/null 2>&1 || true
  git -C "${REPO_DIR}" clean -fdx >/dev/null || return 1

  cp "${stage}/manifest.json" "${stage}/encrypted-parts.sha256" "${stage}"/snapshot.tar.zst.age.part-* "${REPO_DIR}/" || return 1
  git -C "${REPO_DIR}" add -- manifest.json encrypted-parts.sha256 snapshot.tar.zst.age.part-* || return 1
  git -C "${REPO_DIR}" commit --quiet -m "backup(${BACKUP_SOURCE_NAME}): ${created}" || return 1
  git -C "${REPO_DIR}" push --quiet --force origin "HEAD:refs/heads/${branch}" || return 1
  git -C "${REPO_DIR}" checkout --detach >/dev/null 2>&1
  git -C "${REPO_DIR}" branch -D snapshot-build >/dev/null 2>&1 || true
}

backup_once() {
  local slot branch stage recipient created
  slot="$(next_slot)"
  branch="${BACKUP_GIT_BRANCH_PREFIX}-${slot}"
  stage="$(mktemp -d "${WORK_ROOT}/snapshot.XXXXXX")"
  created="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  recipient="$(decode_b64 "${BACKUP_AGE_RECIPIENT_B64}")"

  if ! make_snapshot "${stage}" "${recipient}" "${created}"; then
    [[ "${stage}" == "${WORK_ROOT}"/snapshot.* ]] && rm -rf -- "${stage}"
    return 1
  fi
  if ! publish_snapshot "${stage}" "${branch}" "${created}"; then
    [[ "${stage}" == "${WORK_ROOT}"/snapshot.* ]] && rm -rf -- "${stage}"
    return 1
  fi
  printf '%s' "${slot}" > "${WORK_ROOT}/slot"
  touch "${SUCCESS_FILE}"
  [[ "${stage}" == "${WORK_ROOT}"/snapshot.* ]] && rm -rf -- "${stage}"
  log "encrypted snapshot published to ${branch}"
}

main() {
  if [[ "${BACKUP_ENABLED:-false}" != 'true' ]]; then
    log 'disabled; waiting'
    while :; do sleep 3600; done
  fi

  require_value BACKUP_SOURCE_NAME
  require_value BACKUP_GIT_URL
  require_value BACKUP_GIT_BRANCH_PREFIX
  require_value BACKUP_SSH_PRIVATE_KEY_B64
  require_value BACKUP_AGE_RECIPIENT_B64
  require_value REDIS_URL

  local interval="${BACKUP_INTERVAL_SECONDS:-900}"
  [[ "${interval}" =~ ^[0-9]+$ ]] && (( interval >= 300 )) || {
    log 'BACKUP_INTERVAL_SECONDS must be at least 300'
    exit 1
  }

  configure_ssh
  prepare_repository

  while :; do
    if ! backup_once; then
      log 'snapshot failed; the previous offsite snapshots remain intact'
    fi
    sleep "${interval}"
  done
}

main "$@"
