FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmjs.org/ \
    && npm config set audit false \
    && npm config set fund false \
    && npm config set fetch-retries 3 \
    && npm config set fetch-timeout 120000 \
    && npm ci --no-audit --no-fund --loglevel=info
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# O yt-dlp recomenda Deno para os desafios JavaScript atuais do YouTube.
# Esta imagem contém apenas o binário, sem adicionar outra aplicação ao projeto.
FROM denoland/deno:bin-2.9.2 AS deno-bin

FROM node:24-bookworm-slim AS runtime
ARG YTDLP_VERSION=2026.7.4
ARG GALLERYDL_VERSION=1.32.5
ENV NODE_ENV=production \
    PATH=/opt/yt-dlp/bin:$PATH \
    HOST=0.0.0.0 \
    PORT=3000 \
    YTDLP_BINARY=/opt/yt-dlp/bin/yt-dlp \
    GALLERYDL_BINARY=/opt/yt-dlp/bin/gallery-dl \
    FFMPEG_BINARY=ffmpeg \
    FFPROBE_BINARY=ffprobe
COPY --from=deno-bin /deno /usr/local/bin/deno
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv tini \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" "gallery-dl==${GALLERYDL_VERSION}" \
    && deno --version \
    && /opt/yt-dlp/bin/yt-dlp --version \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/index.js"]
