import { rm } from "node:fs/promises";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { cacheGetJson, cacheSetJson, consumeCooldown } from "../../cache/redis.js";
import { errorCode, errorMessage } from "../../utils/errors.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { BotContext } from "../../types/context.js";
import { buildMediaCaption } from "./caption.js";
import { prepareMediaFiles } from "./convert.js";
import { materializeRemoteItems } from "./direct.js";
import { sendCachedMedia, sendPreparedMedia, sendRemoteMedia, sendTextPost } from "./sender.js";
import type { CachedMediaPayload, DownloadRequest } from "./types.js";
import { mediaCacheKey } from "./urls.js";
import { downloadMedia } from "./ytdlp.js";

async function logFailure(ctx: BotContext, code: string, request: DownloadRequest, error: unknown) {
  logger.error({ code, error, request }, "Falha no download");
  if (!env.LOG_CHANNEL_ID) return;
  await ctx.api.sendMessage(env.LOG_CHANNEL_ID,
    `<b>DOWNLOAD ${code}</b>\nURL: <code>${escapeHtml(truncate(request.url, 1500))}</code>\nErro: <code>${escapeHtml(truncate(errorMessage(error), 2000))}</code>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  ).catch(() => undefined);
}

async function sendActivity(ctx: BotContext, request: DownloadRequest) {
  // Mesmo indicador do Smudge (sendMediaAndHandleCaption -> chatActionUploadDoc):
  // "upload_document" é o padrão genérico pra links (foto, vídeo ou álbum
  // misto). "upload_video" no Smudge só aparece no fluxo específico do botão
  // inline do YouTube, não no download automático por link.
  const action = request.mode === "audio" ? "upload_voice" : "upload_document";
  await ctx.api.sendChatAction(request.chatId, action).catch(() => undefined);
}

/**
 * Fluxo simples, inspirado no SmudgeLord:
 * cache -> extrator direto -> envio em streaming -> fallback yt-dlp/FFmpeg.
 * Não existe fila global nem lock de mídia no Redis, portanto um download
 * lento não bloqueia todos os links seguintes.
 */
export async function processDownload(ctx: BotContext, request: DownloadRequest): Promise<boolean> {
  const startedAt = Date.now();
  const cooldown = env.DOWNLOAD_COOLDOWN_SECONDS > 0
    ? await consumeCooldown(`download:${request.requesterId}`, env.DOWNLOAD_COOLDOWN_SECONDS).catch(() => 0)
    : 0;
  if (cooldown > 0) {
    if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadCooldown", { seconds: cooldown }), { parse_mode: "HTML" });
    return false;
  }

  const key = mediaCacheKey(request.url, request.mode);
  const cached = await cacheGetJson<CachedMediaPayload>(`media:${key}`);
  if (cached?.items.length) {
    const caption = request.captionEnabled ? buildMediaCaption(cached.metadata, request.url) : "";
    try {
      await sendCachedMedia(ctx, cached, caption, request.replyToMessageId, request.url);
      logger.info({ url: request.url, durationMs: Date.now() - startedAt, cache: true }, "Mídia enviada");
      return true;
    } catch (error) {
      logger.warn({ error, key }, "Cache de file_id inválido; extraindo novamente");
    }
  }

  await sendActivity(ctx, request);
  logger.info({ url: request.url, mode: request.mode, automatic: request.automatic }, "Processando mídia");

  let directory: string | undefined;
  try {
    const downloaded = await downloadMedia(request.url, request.mode);
    directory = downloaded.directory;
    const metadata = {
      ...downloaded.metadata,
      webpageUrl: downloaded.metadata.webpageUrl ?? request.url,
    };
    const limit = request.automatic ? env.MAX_AUTO_DURATION_SECONDS : env.MAX_FORCE_DURATION_SECONDS;
    if (metadata.duration && metadata.duration > limit) {
      if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadTooLong"), { parse_mode: "HTML" });
      return false;
    }

    const caption = request.captionEnabled ? buildMediaCaption(metadata, request.url) : "";
    let items = [] as CachedMediaPayload["items"];

    if (downloaded.remoteItems?.length) {
      try {
        items = await sendRemoteMedia(ctx, downloaded.remoteItems, caption, request.replyToMessageId, request.url);
      } catch (streamError) {
        logger.warn({ error: streamError, url: request.url }, "Streaming direto falhou; usando fallback local");
        const local = await materializeRemoteItems(downloaded.remoteItems, request.url);
        directory = local.directory;
        const prepared = await prepareMediaFiles(local.files);
        if (!prepared.length) throw streamError;
        items = await sendPreparedMedia(ctx, prepared, caption, request.replyToMessageId, request.url);
      }
    } else if (downloaded.files.length) {
      const prepared = await prepareMediaFiles(downloaded.files);
      if (!prepared.length) {
        if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadNoMedia"), { parse_mode: "HTML" });
        return false;
      }
      items = await sendPreparedMedia(ctx, prepared, caption, request.replyToMessageId, request.url);
    } else if (metadata.captionHtml) {
      await sendTextPost(ctx, caption, request.replyToMessageId, request.url);
    } else {
      if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadNoMedia"), { parse_mode: "HTML" });
      return false;
    }

    if (items.length) {
      await cacheSetJson(`media:${key}`, {
        items,
        metadata,
        cachedAt: new Date().toISOString(),
      } satisfies CachedMediaPayload, env.MEDIA_CACHE_TTL_SECONDS).catch(() => undefined);
    }

    if (request.deleteSource && request.sourceMessageId && ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, request.sourceMessageId).catch(() => undefined);
    }

    logger.info({
      url: request.url,
      durationMs: Date.now() - startedAt,
      mediaCount: downloaded.remoteItems?.length ?? downloaded.files.length,
      extractor: metadata.extractor,
    }, "Mídia enviada");
    return true;
  } catch (error) {
    const code = errorCode("DL");
    await logFailure(ctx, code, request, error);
    if (request.errorMessagesEnabled) {
      await ctx.reply(ctx.t("downloadFailed", { code }), { parse_mode: "HTML" }).catch(() => undefined);
    }
    return false;
  } finally {
    if (directory && env.DELETE_TEMP_FILES) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}