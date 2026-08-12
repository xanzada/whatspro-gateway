FROM node:20-bullseye-slim

# Debian's `chromium` package installs /usr/bin/chromium. It has never installed
# /usr/bin/chromium-browser, which PUPPETEER_EXECUTABLE_PATH pointed at for as
# long as this file existed: whatsappManager.js probes the filesystem and passes
# an explicit executablePath, so the Chromium rollback transport still worked and
# the broken variable never showed up. Anything launching puppeteer without its
# own path -- scripts/browser-qa.js, scripts/tenants-browser-qa.js -- got a
# missing binary instead.
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    WHATSAPP_AUTH_PATH=/app/whatsapp_auth

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/whatsapp_auth

EXPOSE 3000
CMD ["node", "src/server.js"]
