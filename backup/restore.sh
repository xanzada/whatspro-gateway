#!/usr/bin/env bash
set -Eeuo pipefail

if (( $# < 3 )); then
  echo "Usage: $0 <repository-url> <snapshot-branch> <age-private-key> [output-directory]" >&2
  exit 64
fi

repo_url="$1"
branch="$2"
identity_file="$3"
output_dir="${4:-./restored-${branch}}"
work_dir="$(mktemp -d)"

trap 'rm -rf -- "${work_dir}"' EXIT
umask 077

git clone --quiet --depth 1 --branch "${branch}" "${repo_url}" "${work_dir}/vault"
(
  cd "${work_dir}/vault"
  sha256sum -c encrypted-parts.sha256
  cat snapshot.tar.zst.age.part-* \
    | age -d -i "${identity_file}" \
    | zstd -d --quiet \
    | tar -xf - -C "${work_dir}"
)

redis_hash="$(sha256sum "${work_dir}/redis.rdb" | cut -d' ' -f1)"
grep -Fq "\"redisSha256\":\"${redis_hash}\"" "${work_dir}/manifest.json"
if [[ -f "${work_dir}/whatsapp_auth.tar" ]]; then
  auth_hash="$(sha256sum "${work_dir}/whatsapp_auth.tar" | cut -d' ' -f1)"
  grep -Fq "\"whatsappAuthSha256\":\"${auth_hash}\"" "${work_dir}/manifest.json"
fi

mkdir -p "${output_dir}"
mv "${work_dir}/manifest.json" "${work_dir}/redis.rdb" "${output_dir}/"
if [[ -f "${work_dir}/whatsapp_auth.tar" ]]; then
  mv "${work_dir}/whatsapp_auth.tar" "${output_dir}/"
fi

echo "Snapshot verified and extracted to ${output_dir}"
