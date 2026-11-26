# ─────────────────────────────────────────────────────────────────────────────
# whatsgoapi — serviço auxiliar só para enviar figurinhas com áudio (/audio)
#
# Projeto: https://github.com/moothz/whatsgoapi (a API REST extraída do bot
# ravena-ai, feita sobre a biblioteca whatsmeow).
#
# Este Dockerfile é autossuficiente: baixa o código em commits FIXOS, então
# pode ser colado direto no Easypanel (App -> Source -> Dockerfile) sem
# precisar de repositório nem de submódulos.
#
# Para atualizar no futuro, troque os dois commits abaixo de propósito —
# nunca use "main": o código que roda aqui tem acesso total ao número.
# ─────────────────────────────────────────────────────────────────────────────

FROM golang:1.26-alpine AS builder

RUN apk add --no-cache git gcc musl-dev

# whatsgoapi em 24/11/2026: "Merge pull request #1 from moothz/feat/audio-stickers"
ARG WHATSGOAPI_COMMIT=ae57d419b8515bbc27de426d965b6f76a3898c3b
# whatsmeow (fork do mesmo autor) com o suporte a AudioStickerMessage
ARG WHATSMEOW_COMMIT=6f43a0ebae7690d5b43117cd25ea6ba664fc9d02

WORKDIR /build

RUN git init -q . \
    && git fetch -q --depth 1 https://github.com/moothz/whatsgoapi "${WHATSGOAPI_COMMIT}" \
    && git checkout -q FETCH_HEAD \
    && rm -rf whatsmeow-lib && mkdir whatsmeow-lib && cd whatsmeow-lib \
    && git init -q . \
    && git fetch -q --depth 1 https://github.com/moothz/whatsmeow "${WHATSMEOW_COMMIT}" \
    && git checkout -q FETCH_HEAD

RUN go mod download
RUN go build -o /whatsgo cmd/whatsgo/main.go

# ─────────────────────────────────────────────────────────────────────────────
FROM alpine:3.20

# ffmpeg: a API converte o áudio da figurinha para Opus.
RUN apk add --no-cache ca-certificates tzdata curl ffmpeg

WORKDIR /app
COPY --from=builder /whatsgo /app/whatsgo
RUN mkdir -p /app/files /app/dbdata /app/logs

# Este serviço só ENVIA figurinhas: não guarda mensagens nem mídias.
ENV SERVER_PORT=8080 \
    DATABASE_SAVE_MESSAGES=false \
    MINIO_ENABLED=false \
    WEBHOOK_FILES=false \
    CHECK_USER_EXISTS=false \
    CONNECT_ON_STARTUP=true \
    LOG_LEVEL=INFO

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS -o /dev/null -H "apikey: ${GLOBAL_API_KEY}" "http://127.0.0.1:${SERVER_PORT}/instance/all" || exit 1

CMD ["/app/whatsgo"]
