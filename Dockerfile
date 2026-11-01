FROM node:22-bookworm-slim AS yt-dlp

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version \
    && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    YT_DLP_JS_RUNTIME=node \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    STORAGE_DIR=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && node --version \
    && ffmpeg -version \
    && ffmpeg -hide_banner -h encoder=libx264 >/dev/null \
    && ffmpeg -hide_banner -h encoder=libmp3lame >/dev/null \
    && ffmpeg -hide_banner -h muxer=matroska >/dev/null \
    && ffprobe -version \
    && rm -rf /var/lib/apt/lists/*

COPY --from=yt-dlp /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node src ./src
RUN mkdir -p /data /app/storage \
    && chown node:node /data /app/storage

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
