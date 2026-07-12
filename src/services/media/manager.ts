import { rm } from "node:fs/promises";
import { cacheGetJson, cacheSetJson, consumeCooldown } from "../../cache/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { BotContext } from "../../types/context.js";
import { errorCode, errorMessage } from "../../utils/errors.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import { buildMediaCaption } from "./caption.js";
import { prepareMediaFiles } from "./convert.js";
import { materializeRemoteItems } from "./direct.js";
import { sendCachedMedia, sendPreparedMedia, sendRemoteMedia, sendTextPost } from "./sender.js";
import type { CachedMediaItem, CachedMediaPayload, DownloadRequest, PreparedMediaItem, RemoteMediaItem } from "./types.js";
import { mediaCacheKey } from "./urls.js";
import { downloadMedia } from "./ytdlp.js";
import { isInstagramPostUrl, isInstagramReelUrl } from "./instagram.js";

async function logFailure(ctx: BotContext, code: string, request: DownloadRequest, error: unknown) {
  logger.error({ code, error, request }, "Falha no download");
  if (!env.LOG_CHANNEL_ID) return;
  await ctx.api.sendMessage(
    env.LOG_CHANNEL_ID,
    `<b>DOWNLOAD ${code}</b>\nURL: <code>${escapeHtml(truncate(request.url, 1500))}</code>\nErro: <code>${escapeHtml(truncate(errorMessage(error), 2000))}</code>`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  ).catch(() => undefined);
}

function activityFor(items: PreparedMediaItem[]) {
  if (items.some((item) => item.kind === "video")) return "upload_video" as const;
  if (items.some((item) => item.kind === "photo")) return "upload_photo" as const;
  if (items.some((item) => item.kind === "audio")) return "upload_voice" as const;
  return "upload_document" as const;
}

/**
 * Verifica se todos os itens remotos podem ir direto ao Telegram sem passar
 * pelo FFmpeg. Vídeos de Twitter/X, por exemplo, já são MP4/H.264 prontos —
 * baixar e recodificar é desperdício. Fotos remotas também seguem direto.
 * Esse é o mesmo caminho rápido do SmudgeLord: CDN -> arquivo -> Telegram.
 */
function remoteItemsAreTelegramReady(items: RemoteMediaItem[]): boolean {
  if (!items.length) return false;
  return items.every((item) => {
    if (item.kind === "photo") return true;
    // Vídeo: precisa ser MP4 na URL (Twitter, a maioria dos CDNs) para pular o ffmpeg.
    const url = (item.url ?? "").toLowerCase();
    return /\.mp4(?:$|[?#])/.test(url);
  });
}

/**
 * Fluxo equivalente ao SmudgeLord:
 * cache -> extrator específico -> baixa cada arquivo com o tipo correto ->
 * envia como foto, vídeo, áudio ou documento. Fotos seguem como JPEG e todo
 * vídeo passa pelo perfil MP4/H.264 de 30 fps antes do envio.
 */
export async function processDownload(ctx: BotContext, request: DownloadRequest): Promise<boolean> {
  const startedAt = Date.now();
  const directories = new Set<string>();
  const cooldown = env.DOWNLOAD_COOLDOWN_SECONDS > 0
    ? await consumeCooldown(`download:${request.requesterId}`, env.DOWNLOAD_COOLDOWN_SECONDS).catch(() => 0)
    : 0;
  if (cooldown > 0) {
    if (request.errorMessagesEnabled) {
      await ctx.reply(ctx.t("downloadCooldown", { seconds: cooldown }), { parse_mode: "HTML" });
    }
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

  await ctx.api.sendChatAction(request.chatId, "typing").catch(() => undefined);
  logger.info({ url: request.url, mode: request.mode, automatic: request.automatic }, "Processando mídia");

  try {
    const downloaded = await downloadMedia(request.url, request.mode);
    if (downloaded.directory) directories.add(downloaded.directory);
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

    // CAMINHO RÁPIDO (estilo SmudgeLord): quando o extrator já entrega URLs de
    // MP4/foto prontos (Twitter/X e a maioria dos CDNs), enviamos direto ao
    // Telegram sem baixar em disco e sem passar pelo FFmpeg. Isso elimina as
    // duas etapas mais lentas do fluxo antigo.
    if (
      env.REMOTE_FAST_PATH
      && downloaded.remoteItems?.length
      && !downloaded.files.length
      && remoteItemsAreTelegramReady(downloaded.remoteItems)
    ) {
      const instagramExpectsVideoFast = isInstagramPostUrl(request.url) && (
        isInstagramReelUrl(request.url)
        || Boolean(metadata.duration && metadata.duration > 0)
      );
      // Segurança: nunca usar o atalho para vídeos do Instagram, cujo fluxo
      // precisa da verificação de MP4 real feita mais abaixo.
      if (!instagramExpectsVideoFast) {
        try {
          const activity = downloaded.remoteItems.some((item) => item.kind === "video")
            ? "upload_video" as const
            : "upload_photo" as const;
          await ctx.api.sendChatAction(request.chatId, activity).catch(() => undefined);
          const fastItems: CachedMediaItem[] = await sendRemoteMedia(
            ctx,
            downloaded.remoteItems,
            caption,
            request.replyToMessageId,
            request.url,
          );
          if (fastItems.length) {
            await cacheSetJson(`media:${key}`, {
              items: fastItems,
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
            mediaCount: downloaded.remoteItems.length,
            extractor: metadata.extractor,
            fastPath: true,
          }, "Mídia enviada");
          return true;
        } catch (error) {
          // Se o envio direto falhar (CDN recusa referer, etc.), caímos no
          // fluxo tradicional de baixar + preparar logo abaixo.
          logger.warn({ error, url: request.url }, "Caminho rápido remoto falhou; usando download tradicional");
        }
      }
    }

    let prepared: PreparedMediaItem[] = [];

    if (downloaded.remoteItems?.length) {
      // O SmudgeLord baixa as mídias antes de enviá-las. Isso preserva o tipo
      // real e evita travamentos do Telegram ao buscar CDNs com referer.
      const local = await materializeRemoteItems(downloaded.remoteItems, request.url);
      directories.add(local.directory);
      prepared = await prepareMediaFiles(local.files);
    } else if (downloaded.files.length) {
      prepared = await prepareMediaFiles(downloaded.files);
    }

    // Última barreira antes do Telegram: Reel ou post identificado como vídeo
    // jamais pode ser enviado como foto, mesmo que algum fallback tenha
    // retornado apenas a thumbnail.
    const instagramExpectsVideo = isInstagramPostUrl(request.url) && (
      isInstagramReelUrl(request.url)
      || Boolean(metadata.duration && metadata.duration > 0)
    );
    if (instagramExpectsVideo && !prepared.some((item) => item.kind === "video")) {
      throw new Error("Instagram identificou publicação em vídeo, mas nenhum MP4 foi obtido; thumbnail não será enviada como foto");
    }

    let items: CachedMediaPayload["items"] = [];
    if (prepared.length) {
      await ctx.api.sendChatAction(request.chatId, activityFor(prepared)).catch(() => undefined);
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
      mediaCount: prepared.length,
      mediaKinds: prepared.map((item) => item.kind),
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
    if (env.DELETE_TEMP_FILES) {
      await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)));
    }
  }
}