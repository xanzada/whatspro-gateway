FROM node:20-bullseye-slim

ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
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
