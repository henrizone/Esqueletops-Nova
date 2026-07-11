import { InlineKeyboard, type Bot } from "grammy";
import { cacheDelete, cacheGetJson, cacheSetJson } from "../cache/redis.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getChatSettings } from "../database/repositories.js";
import { processDownload } from "../services/media/manager.js";
import { extractUrls, isAllowedMediaUrl, isAutoMediaUrl, isYouTubeShortsUrl, isYouTubeUrl, normalizeUrl } from "../services/media/urls.js";
import { probeYouTube, sendYouTubeDownload, youtubeChoiceMeta } from "../services/media/youtube.js";
import type { DownloadMode } from "../services/media/types.js";
import type { BotContext } from "../types/context.js";
import { errorCode, errorMessage } from "../utils/errors.js";
import { escapeHtml } from "../utils/html.js";

function sourceText(ctx: BotContext) {
  return [ctx.match, ctx.message?.reply_to_message?.text, ctx.message?.reply_to_message?.caption]
    .filter(Boolean)
    .join("\n");
}

async function requestDownload(
  ctx: BotContext,
  url: string,
  mode: DownloadMode,
  automatic: boolean,
  options?: { deleteSource?: boolean },
) {
  const settings = ctx.chat ? await getChatSettings(ctx.chat.id) : undefined;
  return processDownload(ctx, {
    url: normalizeUrl(url),
    mode,
    automatic,
    requesterId: ctx.from!.id,
    chatId: ctx.chat!.id,
    replyToMessageId: ctx.message?.message_id,
    captionEnabled: settings?.mediaCaption ?? true,
    errorMessagesEnabled: automatic ? settings?.mediaErrors ?? true : true,
    deleteSource: options?.deleteSource ?? (settings?.deleteSource ?? false),
    sourceMessageId: ctx.message?.message_id,
  });
}

interface YouTubeButtonState {
  url: string;
  userId: number;
  replyToMessageId?: number;
}

async function showYouTubeMenu(ctx: BotContext, url: string) {
  const normalized = normalizeUrl(url);
  const info = await probeYouTube(normalized);
  const details = youtubeChoiceMeta(info);
  const token = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  await cacheSetJson(`ytdl:${token}`, {
    url: normalized,
    userId: ctx.from!.id,
    replyToMessageId: ctx.message?.message_id,
  } satisfies YouTubeButtonState, 900);

  const meta = [
    info.uploader || info.channel ? `👤 ${escapeHtml(info.uploader ?? info.channel ?? "")}` : "",
    details.duration ? `⏱ ${details.duration}` : "",
  ].filter(Boolean).join(" · ");
  const videoLabel = details.videoSize
    ? `🎬 ${ctx.t("video")} · ~${details.videoSize}`
    : `🎬 ${ctx.t("video")}`;
  const audioLabel = details.audioSize
    ? `🎧 ${ctx.t("audio")} · ~${details.audioSize}`
    : `🎧 ${ctx.t("audio")}`;
  const keyboard = new InlineKeyboard()
    .text(videoLabel, `ytdl:${token}:video`)
    .text(audioLabel, `ytdl:${token}:audio`);
  await ctx.reply(ctx.t("ytdlChoose", {
    title: escapeHtml(info.title),
    meta,
  }), {
    parse_mode: "HTML",
    reply_markup: keyboard,
    reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
  });
}

export function registerMediaModule(bot: Bot<BotContext>) {
  bot.command(["dl", "sdl"], async (ctx) => {
    const url = extractUrls(sourceText(ctx))[0];
    if (!url) return ctx.reply(ctx.t("downloadNeedUrl"), { parse_mode: "HTML" });
    if (!isAllowedMediaUrl(url)) return ctx.reply(ctx.t("downloadUnsupported"), { parse_mode: "HTML" });
    if (isYouTubeUrl(url)) {
      try {
        await showYouTubeMenu(ctx, url);
      } catch (error) {
        const code = errorCode("YT");
        logger.error({ code, error, url }, "Falha ao consultar vídeo do YouTube");
        await ctx.reply(`${ctx.t("downloadFailed", { code })}\n<code>${escapeHtml(errorMessage(error))}</code>`, { parse_mode: "HTML" });
      }
      return;
    }
    await requestDownload(ctx, url, "auto", false);
  });

  bot.command("ytdl", async (ctx) => {
    const url = extractUrls(sourceText(ctx))[0];
    if (!url) return ctx.reply(ctx.t("downloadNeedUrl"), { parse_mode: "HTML" });
    if (!isYouTubeUrl(url)) return ctx.reply(ctx.t("downloadUnsupported"), { parse_mode: "HTML" });

    try {
      await showYouTubeMenu(ctx, url);
    } catch (error) {
      const code = errorCode("YT");
      logger.error({ code, error, url }, "Falha ao consultar vídeo do YouTube");
      await ctx.reply(`${ctx.t("downloadFailed", { code })}\n<code>${escapeHtml(errorMessage(error))}</code>`, {
        parse_mode: "HTML",
      });
    }
  });

  bot.callbackQuery(/^ytdl:([a-f0-9]{12}):(video|audio)$/, async (ctx) => {
    const token = ctx.match[1];
    const mode = ctx.match[2] as "video" | "audio";
    const state = await cacheGetJson<YouTubeButtonState>(`ytdl:${token}`);
    if (!state) return ctx.answerCallbackQuery({ text: ctx.t("expiredButton"), show_alert: true });
    if (state.userId !== ctx.from.id) {
      return ctx.answerCallbackQuery({ text: ctx.t("buttonOwnerOnly"), show_alert: true });
    }

    await ctx.answerCallbackQuery({ text: mode === "audio" ? "Baixando áudio…" : "Baixando vídeo…" });
    await ctx.editMessageText(mode === "audio" ? "🎧 <b>Baixando áudio…</b>" : "🎬 <b>Baixando vídeo…</b>", {
      parse_mode: "HTML",
    }).catch(() => undefined);

    try {
      await sendYouTubeDownload({
        ctx,
        url: state.url,
        mode,
        replyToMessageId: state.replyToMessageId,
      });
      await cacheDelete(`ytdl:${token}`).catch(() => undefined);
      await ctx.deleteMessage().catch(() => undefined);
    } catch (error) {
      const code = errorCode("YT");
      logger.error({ code, error, url: state.url, mode }, "Falha no download do YouTube");
      await ctx.editMessageText(`${ctx.t("downloadFailed", { code })}\n<code>${escapeHtml(errorMessage(error))}</code>`, {
        parse_mode: "HTML",
      }).catch(() => undefined);
    }
  });

  bot.on(["message:text", "message:caption"], async (ctx) => {
    if (!ctx.from || ctx.from.is_bot || !ctx.chat) return;
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    if (text.startsWith("/")) return;
    const settings = await getChatSettings(ctx.chat.id);
    if (!settings.mediaAuto) return;

    // Igual ao SmudgeLord: links normais do YouTube usam /ytdl; apenas Shorts
    // entram no detector automático de mídia.
    const urls = extractUrls(text)
      .filter(isAllowedMediaUrl)
      .filter(isAutoMediaUrl)
      .slice(0, env.MAX_LINKS_PER_MESSAGE);

    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index]!;
      if (isYouTubeShortsUrl(url)) {
        try {
          await sendYouTubeDownload({
            ctx,
            url: normalizeUrl(url),
            mode: "video",
            replyToMessageId: ctx.message?.message_id,
          });
          if (settings.deleteSource && index === urls.length - 1 && ctx.message) {
            await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
          }
        } catch (error) {
          const code = errorCode("YT");
          logger.error({ code, error, url }, "Falha no download automático do YouTube Shorts");
          if (settings.mediaErrors) await ctx.reply(ctx.t("downloadFailed", { code }), { parse_mode: "HTML" });
        }
        continue;
      }
      await requestDownload(ctx, url, "auto", true, {
        deleteSource: settings.deleteSource && index === urls.length - 1,
      });
    }
  });
}
