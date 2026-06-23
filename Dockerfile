# Stage 1: base image với Chrome + FFmpeg
FROM node:20-slim

# Cài FFmpeg và các thư viện cần thiết cho Puppeteer/Chrome
RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Báo cho Puppeteer dùng Chrome hệ thống, không tự tải
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy và cài dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Tạo thư mục cần thiết
RUN mkdir -p public/outputs tmp

EXPOSE 3000

CMD ["node", "src/server.js"]
