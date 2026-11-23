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
import {
  PartialSendError,
  sendCachedArticle,
  sendCachedMedia,
  sendPreparedMedia,
  sendRemoteArticle,
  sendRemoteMedia,
  sendTextPost,
} from "./sender.js";
import type { CachedArticle, CachedMediaItem, CachedMediaPayload, DownloadRequest, PreparedMediaItem, RemoteMediaItem } from "./types.js";
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

async function deleteSourceMessage(ctx: BotContext, request: DownloadRequest) {
  if (!request.deleteSource || !request.sourceMessageId) return;
  await ctx.api.deleteMessage(request.chatId, request.sourceMessageId).catch(() => undefined);
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
    // Vídeo: aceitamos se a URL for MP4 explícito (Twitter, maioria dos CDNs) OU
    // se vier de um CDN de vídeo confiável que serve MP4 sem a extensão no
    // caminho (ex.: proxy do TikTok/tikwm). Assim o TikTok também pula o ffmpeg.
    const url = (item.url ?? "").toLowerCase();
    if (/\.mp4(?:$|[?#])/.test(url)) return true;
    try {
      const host = new URL(url).hostname.toLowerCase();
      const trustedVideoHosts = ["tikwm.com", "tiktokcdn", "muscdn.com", "byteoversea.com"];
      return trustedVideoHosts.some((h) => host === h || host.endsWith(`.${h}`) || host.includes(h));
    } catch {
      return false;
    }
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
  if (cached?.items.length || cached?.article) {
    const caption = request.captionEnabled ? buildMediaCaption(cached.metadata, request.url) : "";
    try {
      // O artigo carrega o texto dos tweets; com legendas desligadas no chat
      // vai só o álbum de mídias.
      if (cached.article && (request.captionEnabled || !cached.items.length)) {
        await sendCachedArticle(ctx, cached.article, request.replyToMessageId, request.url);
      } else {
        await sendCachedMedia(ctx, cached, caption, request.replyToMessageId, request.url);
      }
      // Antes o link original só era apagado quando a mídia NÃO vinha do cache.
      await deleteSourceMessage(ctx, request);
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
    const store = async (items: CachedMediaItem[], article?: CachedArticle) => {
      if (!items.length && !article) return;
      await cacheSetJson(`media:${key}`, {
        article,
        items,
        metadata,
        cachedAt: new Date().toISOString(),
      } satisfies CachedMediaPayload, env.MEDIA_CACHE_TTL_SECONDS).catch(() => undefined);
    };

    // ARTIGO (estilo SmudgeLord): tweet com quote vai em uma única rich
    // message — cada tweet com o próprio texto e as próprias mídias, mais o
    // botão "Abrir no Twitter/X". Se o Telegram recusar, segue o fluxo de álbum.
    if (env.MEDIA_ARTICLES && request.captionEnabled && downloaded.article?.length) {
      try {
        const hasVideo = downloaded.remoteItems?.some((item) => item.kind === "video");
        await ctx.api.sendChatAction(request.chatId, hasVideo ? "upload_video" : "upload_photo").catch(() => undefined);
        const article = await sendRemoteArticle(ctx, downloaded.article, request.replyToMessageId, request.url);
        if (article) {
          await store(article.media.map((entry) => ({ kind: entry.kind, fileId: entry.fileId })), article);
        }
        await deleteSourceMessage(ctx, request);
        logger.info({
          url: request.url,
          durationMs: Date.now() - startedAt,
          mediaCount: downloaded.remoteItems?.length ?? 0,
          extractor: metadata.extractor,
          article: true,
        }, "Mídia enviada");
        return true;
      } catch (error) {
        logger.warn({ error, url: request.url }, "Envio como artigo falhou; usando álbum");
      }
    }

    // Itens ainda não entregues e o que já foi enviado. O caminho rápido pode
    // falhar depois do primeiro álbum de uma publicação com mais de 10 mídias;
    // nesse caso o fallback continua só com o restante, sem duplicar nada.
    let remaining: RemoteMediaItem[] = downloaded.remoteItems ?? [];
    const delivered: CachedMediaItem[] = [];
    let sentSomething = false;

    // CAMINHO RÁPIDO (estilo SmudgeLord): quando o extrator já entrega URLs de
    // MP4/foto prontos (Twitter/X, TikTok via tikwm), enviamos direto ao
    // Telegram sem baixar em disco e sem passar pelo FFmpeg.
    //
    // EXCEÇÃO: Instagram. O Telegram NÃO consegue baixar as URLs do CDN do
    // Instagram (cdninstagram.com/fbcdn.net), então ele sempre baixa os bytes
    // pelo bot, exatamente como o SmudgeLord faz.
    const isInstagram = isInstagramPostUrl(request.url);
    if (
      env.REMOTE_FAST_PATH
      && !isInstagram
      && remaining.length
      && !downloaded.files.length
      && remoteItemsAreTelegramReady(remaining)
    ) {
      const total = remaining.length;
      try {
        const activity = remaining.some((item) => item.kind === "video")
          ? "upload_video" as const
          : "upload_photo" as const;
        await ctx.api.sendChatAction(request.chatId, activity).catch(() => undefined);
        const fastItems = await sendRemoteMedia(ctx, remaining, caption, request.replyToMessageId, request.url);
        await store(fastItems);
        await deleteSourceMessage(ctx, request);
        logger.info({
          url: request.url,
          durationMs: Date.now() - startedAt,
          mediaCount: total,
          extractor: metadata.extractor,
          fastPath: true,
        }, "Mídia enviada");
        return true;
      } catch (error) {
        if (error instanceof PartialSendError) {
          delivered.push(...error.sent);
          remaining = remaining.slice(error.sentCount);
          sentSomething = error.sentCount > 0;
        }
        // Se o envio direto falhar (CDN recusa, mídia fora do padrão etc.),
        // o restante segue pelo fluxo de baixar + preparar logo abaixo.
        logger.warn({ error, url: request.url, alreadySent: total - remaining.length }, "Caminho rápido remoto falhou; usando download tradicional");
      }
    }

    let prepared: PreparedMediaItem[] = [];
    // Só guardamos no cache publicações entregues por inteiro. Um álbum
    // incompleto em cache seria reenviado incompleto por dias.
    let complete = true;

    if (remaining.length) {
      // O SmudgeLord baixa as mídias antes de enviá-las. Isso preserva o tipo
      // real e evita travamentos do Telegram ao buscar CDNs com referer.
      const local = await materializeRemoteItems(remaining, request.url);
      directories.add(local.directory);
      prepared = await prepareMediaFiles(local.files);
      complete = local.failed === 0 && prepared.length === local.files.length;
    } else if (downloaded.files.length) {
      prepared = await prepareMediaFiles(downloaded.files);
      complete = prepared.length === downloaded.files.length;
    }

    // Última barreira antes do Telegram: Reel ou post identificado como vídeo
    // jamais pode ser enviado como foto, mesmo que algum fallback tenha
    // retornado apenas a thumbnail.
    const instagramExpectsVideo = isInstagram && (
      isInstagramReelUrl(request.url)
      || Boolean(metadata.duration && metadata.duration > 0)
    );
    if (instagramExpectsVideo && !prepared.some((item) => item.kind === "video")) {
      throw new Error("Instagram identificou publicação em vídeo, mas nenhum MP4 foi obtido; thumbnail não será enviada como foto");
    }

    if (prepared.length) {
      await ctx.api.sendChatAction(request.chatId, activityFor(prepared)).catch(() => undefined);
      delivered.push(...await sendPreparedMedia(
        ctx,
        prepared,
        sentSomething ? "" : caption,
        request.replyToMessageId,
        sentSomething ? undefined : request.url,
      ));
    } else if (sentSomething) {
      complete = false;
    } else if (metadata.captionHtml) {
      await sendTextPost(ctx, caption, request.replyToMessageId, request.url);
    } else {
      if (request.errorMessagesEnabled) await ctx.reply(ctx.t("downloadNoMedia"), { parse_mode: "HTML" });
      return false;
    }

    if (complete) await store(delivered);
    else logger.warn({ url: request.url, sent: delivered.length }, "Publicação enviada incompleta; resultado não será guardado em cache");

    await deleteSourceMessage(ctx, request);

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