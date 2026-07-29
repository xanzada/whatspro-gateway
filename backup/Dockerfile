FROM alpine:3.21

RUN apk add --no-cache \
    age \
    bash \
    ca-certificates \
    coreutils \
    git \
    openssh-client \
    redis \
    tar \
    zstd

COPY backup/backup.sh /usr/local/bin/backup
COPY backup/healthcheck.sh /usr/local/bin/backup-healthcheck

RUN chmod 0755 /usr/local/bin/backup /usr/local/bin/backup-healthcheck \
    && mkdir -p /source /work

# WhatsApp's Chromium profile is root-owned in the application volume. This
# sidecar needs root only to read that volume, which is mounted read-only.
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/backup"]
