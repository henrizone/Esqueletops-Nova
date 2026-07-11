import type { Bot } from "grammy";
import { cacheGetJson } from "../cache/redis.js";
import { env } from "../config/env.js";
import { buildMediaCaption } from "../services/media/caption.js";
import type { CachedMediaPayload } from "../services/media/types.js";
import { isAllowedMediaUrl, mediaCacheKey, normalizeUrl } from "../services/media/urls.js";
import { describeWeather, getCurrentWeather, searchLocations } from "../services/weather.js";
import type { BotContext } from "../types/context.js";
import { escapeHtml, truncate } from "../utils/html.js";

export function registerInlineModule(bot: Bot<BotContext>) {
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    if (!query) {
      return ctx.answerInlineQuery([{ type: "article", id: "help", title: env.BOT_DISPLAY_NAME, description: "Downloads, clima, tradução e figurinhas", input_message_content: { message_text: `Use /help no @${ctx.me.username} para ver todos os comandos.` } }], { cache_time: 60, is_personal: true });
    }
    if (/^clima\s+|^weather\s+/i.test(query)) {
      const place = query.replace(/^(clima|weather)\s+/i, "");
      const locations = await searchLocations(place, ctx.from.language_code?.startsWith("pt") ? "pt" : "en");
      const results = await Promise.all(locations.slice(0, 5).map(async (location, index) => {
        const weather = await getCurrentWeather(location); const d = describeWeather(weather.weatherCode, ctx.from.language_code?.startsWith("pt") ? "pt_BR" : "en_US");
        const title = `${d.emoji} ${location.name}: ${weather.temperature}°C`;
        const text = `<b>${escapeHtml([location.name, location.admin1, location.country].filter(Boolean).join(", "))}</b>\n${d.emoji} ${escapeHtml(d.description)}\n🌡 ${weather.temperature}°C · sensação ${weather.apparentTemperature}°C\n💧 ${weather.humidity}% · 💨 ${weather.windSpeed} km/h`;
        return { type: "article" as const, id: `weather-${index}`, title, description: `${d.description} · sensação ${weather.apparentTemperature}°C`, input_message_content: { message_text: text, parse_mode: "HTML" as const } };
      }));
      return ctx.answerInlineQuery(results, { cache_time: 300 });
    }
    const url = query.match(/https?:\/\/\S+/)?.[0];
    if (url && isAllowedMediaUrl(url)) {
      const normalized = normalizeUrl(url);
      for (const mode of ["auto", "video", "audio"] as const) {
        const payload = await cacheGetJson<CachedMediaPayload>(`media:${mediaCacheKey(normalized, mode)}`);
        const item = payload?.items[0];
        if (!item) continue;
        const caption = buildMediaCaption(payload.metadata, normalized);
        if (item.kind === "photo") return ctx.answerInlineQuery([{ type: "photo", id: `cached-${mode}`, photo_file_id: item.fileId, thumbnail_url: payload.metadata.thumbnail ?? "https://telegram.org/img/t_logo.png", caption, parse_mode: "HTML" }], { cache_time: 60, is_personal: true });
        if (item.kind === "video") return ctx.answerInlineQuery([{ type: "video", id: `cached-${mode}`, video_file_id: item.fileId, title: payload.metadata.title ?? "Vídeo", mime_type: "video/mp4", thumbnail_url: payload.metadata.thumbnail ?? "https://telegram.org/img/t_logo.png", caption, parse_mode: "HTML" }], { cache_time: 60, is_personal: true });
        if (item.kind === "audio") return ctx.answerInlineQuery([{ type: "audio", id: `cached-${mode}`, audio_file_id: item.fileId, caption, parse_mode: "HTML" }], { cache_time: 60, is_personal: true });
      }
      return ctx.answerInlineQuery([{ type: "article", id: "download", title: "Abrir o bot para baixar", description: truncate(normalized, 80), input_message_content: { message_text: `Abra @${ctx.me.username} e envie este link:\n${normalized}` }, reply_markup: { inline_keyboard: [[{ text: "Abrir bot", url: `https://t.me/${ctx.me.username}?start=download` }]] } }], { cache_time: 30, is_personal: true });
    }
    return ctx.answerInlineQuery([{ type: "article", id: "unknown", title: "Não reconheci a consulta", description: "Tente: clima Porto Alegre ou cole um link", input_message_content: { message_text: escapeHtml(query), parse_mode: "HTML" } }], { cache_time: 30, is_personal: true });
  });
}
