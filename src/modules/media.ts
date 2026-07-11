import { InlineKeyboard, type Bot } from "grammy";
import { cacheGetJson, cacheSetJson } from "../cache/redis.js";
import { env } from "../config/env.js";
import { getChatSettings } from "../database/repositories.js";
import { processDownload } from "../services/media/manager.js";
import { extractUrls, isAllowedMediaUrl, isYouTubeUrl, normalizeUrl } from "../services/media/urls.js";
import { probeMedia } from "../services/media/ytdlp.js";
import type { DownloadMode } from "../services/media/types.js";
import type { BotContext } from "../types/context.js";
import { escapeHtml } from "../utils/html.js";

function sourceText(ctx: BotContext) {
  return [ctx.match, ctx.message?.reply_to_message?.text, ctx.message?.reply_to_message?.caption].filter(Boolean).join("\n");
}
async function requestDownload(ctx: BotContext, url: string, mode: DownloadMode, automatic: boolean, options?: { deleteSource?: boolean }) {
  const settings = ctx.chat ? await getChatSettings(ctx.chat.id) : undefined;
  return processDownload(ctx, {
    url: normalizeUrl(url), mode, automatic, requesterId: ctx.from!.id, chatId: ctx.chat!.id,
    replyToMessageId: ctx.message?.message_id, captionEnabled: settings?.mediaCaption ?? true,
    errorMessagesEnabled: automatic ? settings?.mediaErrors ?? true : true,
    deleteSource: options?.deleteSource ?? (settings?.deleteSource ?? false), sourceMessageId: ctx.message?.message_id,
  });
}

export function registerMediaModule(bot: Bot<BotContext>) {
  bot.command(["dl", "sdl"], async (ctx) => {
    const url = extractUrls(sourceText(ctx))[0];
    if (!url) return ctx.reply(ctx.t("downloadNeedUrl"), { parse_mode: "HTML" });
    if (!isAllowedMediaUrl(url)) return ctx.reply(ctx.t("downloadUnsupported"), { parse_mode: "HTML" });
    await requestDownload(ctx, url, "auto", false);
  });
  bot.command("ytdl", async (ctx) => {
    const url = extractUrls(sourceText(ctx))[0];
    if (!url) return ctx.reply(ctx.t("downloadNeedUrl"), { parse_mode: "HTML" });
    if (!isYouTubeUrl(url)) return ctx.reply(ctx.t("downloadUnsupported"), { parse_mode: "HTML" });
    const metadata = await probeMedia(url);
    const token = crypto.randomUUID().slice(0, 10);
    await cacheSetJson(`ytdl:${token}`, { url: normalizeUrl(url), userId: ctx.from!.id }, 900);
    const meta = [metadata.uploader ? `👤 ${escapeHtml(metadata.uploader)}` : "", metadata.duration ? `⏱ ${Math.floor(metadata.duration / 60)}:${String(Math.floor(metadata.duration % 60)).padStart(2, "0")}` : ""].filter(Boolean).join(" · ");
    const keyboard = new InlineKeyboard().text(`🎬 ${ctx.t("video")}`, `ytdl:${token}:video`).text(`🎧 ${ctx.t("audio")}`, `ytdl:${token}:audio`);
    await ctx.reply(ctx.t("ytdlChoose", { title: escapeHtml(metadata.title ?? "YouTube"), meta }), { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^ytdl:([a-f0-9]{10}):(video|audio)$/, async (ctx) => {
    const cached = await cacheGetJson<{ url: string; userId: number }>(`ytdl:${ctx.match[1]}`);
    if (!cached) return ctx.answerCallbackQuery({ text: ctx.t("expiredButton"), show_alert: true });
    if (cached.userId !== ctx.from.id) return ctx.answerCallbackQuery({ text: ctx.t("buttonOwnerOnly"), show_alert: true });
    await ctx.answerCallbackQuery();
    await processDownload(ctx, {
      url: cached.url, mode: ctx.match[2] as DownloadMode, automatic: false, requesterId: ctx.from.id, chatId: ctx.chat!.id,
      replyToMessageId: ctx.callbackQuery.message?.message_id, captionEnabled: true, errorMessagesEnabled: true,
      deleteSource: false,
    });
  });

  bot.on(["message:text", "message:caption"], async (ctx) => {
    if (!ctx.from || ctx.from.is_bot || !ctx.chat) return;
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    if (text.startsWith("/")) return;
    const settings = await getChatSettings(ctx.chat.id);
    if (!settings.mediaAuto) return;
    const urls = extractUrls(text).filter(isAllowedMediaUrl).slice(0, env.MAX_LINKS_PER_MESSAGE);
    for (let index = 0; index < urls.length; index += 1) {
      await requestDownload(ctx, urls[index]!, "auto", true, { deleteSource: settings.deleteSource && index === urls.length - 1 });
    }
  });
}
