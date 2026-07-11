import { rm } from "node:fs/promises";
import PQueue from "p-queue";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { acquireLock, cacheGetJson, cacheSetJson, consumeCooldown, releaseLock } from "../../cache/redis.js";
import { errorCode, errorMessage } from "../../utils/errors.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { BotContext } from "../../types/context.js";
import { buildMediaCaption } from "./caption.js";
import { prepareMediaFiles } from "./convert.js";
import { sendCachedMedia, sendPreparedMedia, sendTextPost } from "./sender.js";
import type { CachedMediaPayload, DownloadRequest } from "./types.js";
import { mediaCacheKey } from "./urls.js";
import { downloadMedia, probeMedia } from "./ytdlp.js";

const queue = new PQueue({ concurrency: env.DOWNLOAD_CONCURRENCY });

async function logFailure(ctx: BotContext, code: string, request: DownloadRequest, error: unknown) {
  logger.error({ code, error, request }, "Falha no download");
  if (!env.LOG_CHANNEL_ID) return;
  await ctx.api.sendMessage(env.LOG_CHANNEL_ID,
    `<b>DOWNLOAD ${code}</b>\nURL: <code>${escapeHtml(truncate(request.url, 1500))}</code>\nErro: <code>${escapeHtml(truncate(errorMessage(error), 2000))}</code>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  ).catch(() => undefined);
}

export async function processDownload(ctx: BotContext, request: DownloadRequest): Promise<boolean> {
  const cooldown = await consumeCooldown(`download:${request.requesterId}`, env.DOWNLOAD_COOLDOWN_SECONDS).catch(() => 0);
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
      return true;
    } catch (error) {
      logger.warn({ error, key }, "Cache de file_id inválido; baixando novamente");
    }
  }

  const token = await acquireLock(`media:${key}`, env.DOWNLOAD_TIMEOUT_SECONDS + 60).catch(() => crypto.randomUUID());
  if (!token) {
    if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadInProgress"), { parse_mode: "HTML" });
    return false;
  }

  const position = queue.size + queue.pending;
  const progress = env.MEDIA_PROGRESS_MESSAGES
    ? await ctx.reply(position > 0 ? ctx.t("downloadQueued") : ctx.t("downloadStarted"), {
        parse_mode: "HTML",
        reply_parameters: request.replyToMessageId ? { message_id: request.replyToMessageId } : undefined,
      }).catch(() => undefined)
    : undefined;

  try {
    return await queue.add(async () => {
      let directory: string | undefined;
      try {
        let probedMetadata;
        try {
          probedMetadata = await probeMedia(request.url);
        } catch (error) {
          logger.info({ url: request.url, error }, "Prévia do yt-dlp indisponível; o download tentará os extratores de fallback");
        }
        const limit = request.automatic ? env.MAX_AUTO_DURATION_SECONDS : env.MAX_FORCE_DURATION_SECONDS;
        if (probedMetadata?.duration && probedMetadata.duration > limit) {
          if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadTooLong"), { parse_mode: "HTML" });
          return false;
        }
        const downloaded = await downloadMedia(request.url, request.mode);
        directory = downloaded.directory;
        const metadata = { ...probedMetadata, ...downloaded.metadata, webpageUrl: downloaded.metadata.webpageUrl ?? probedMetadata?.webpageUrl ?? request.url };
        if (metadata.duration && metadata.duration > limit) {
          if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadTooLong"), { parse_mode: "HTML" });
          return false;
        }
        const caption = request.captionEnabled ? buildMediaCaption(metadata, request.url) : "";
        if (!downloaded.files.length && metadata.captionHtml) {
          await sendTextPost(ctx, caption, request.replyToMessageId, request.url);
          if (request.deleteSource && request.sourceMessageId && ctx.chat) {
            await ctx.api.deleteMessage(ctx.chat.id, request.sourceMessageId).catch(() => undefined);
          }
          return true;
        }
        const prepared = await prepareMediaFiles(downloaded.files);
        if (!prepared.length) {
          if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadNoMedia"), { parse_mode: "HTML" });
          return false;
        }
        const items = await sendPreparedMedia(ctx, prepared, caption, request.replyToMessageId, request.url);
        if (items.length) {
          await cacheSetJson(`media:${key}`, { items, metadata, cachedAt: new Date().toISOString() } satisfies CachedMediaPayload, env.MEDIA_CACHE_TTL_SECONDS).catch(() => undefined);
        }
        if (request.deleteSource && request.sourceMessageId && ctx.chat) {
          await ctx.api.deleteMessage(ctx.chat.id, request.sourceMessageId).catch(() => undefined);
        }
        return true;
      } catch (error) {
        const code = errorCode("DL");
        await logFailure(ctx, code, request, error);
        if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadFailed", { code }), { parse_mode: "HTML" }).catch(() => undefined);
        return false;
      } finally {
        if (directory && env.DELETE_TEMP_FILES) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    }) ?? false;
  } finally {
    if (progress) await ctx.api.deleteMessage(progress.chat.id, progress.message_id).catch(() => undefined);
    await releaseLock(`media:${key}`, token).catch(() => undefined);
  }
}
