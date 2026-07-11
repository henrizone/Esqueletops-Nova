import { InlineKeyboard, type Bot } from "grammy";
import { cacheGetJson, cacheSetJson } from "../cache/redis.js";
import type { BotContext } from "../types/context.js";
import { escapeHtml, truncate } from "../utils/html.js";
import { describeWeather, getCurrentWeather, searchLocations, type WeatherLocation } from "../services/weather.js";
import { translateText } from "../services/translate.js";

function commandText(ctx: BotContext) { return typeof ctx.match === "string" ? ctx.match.trim() : ""; }

export function registerMiscModule(bot: Bot<BotContext>) {
  const weather = async (ctx: BotContext) => {
    const query = commandText(ctx);
    if (!query) return ctx.reply(ctx.t("weatherUsage"), { parse_mode: "HTML" });
    const locations = await searchLocations(query, ctx.locale === "pt_BR" ? "pt" : "en");
    if (!locations.length) return ctx.reply(ctx.t("weatherUsage"), { parse_mode: "HTML" });
    const token = crypto.randomUUID().slice(0, 8);
    await cacheSetJson(`weather:${token}`, { userId: ctx.from!.id, locations }, 600);
    const keyboard = new InlineKeyboard();
    locations.forEach((location, index) => keyboard.text(`${location.name}${location.admin1 ? `, ${location.admin1}` : ""}${location.country ? ` — ${location.country}` : ""}`, `weather:${token}:${index}`).row());
    await ctx.reply(ctx.t("weatherChoose"), { reply_markup: keyboard });
  };
  bot.command(["weather", "clima"], weather);
  bot.callbackQuery(/^weather:([a-f0-9]{8}):(\d+)$/, async (ctx) => {
    const cached = await cacheGetJson<{ userId: number; locations: WeatherLocation[] }>(`weather:${ctx.match[1]}`);
    if (!cached || cached.userId !== ctx.from.id) return ctx.answerCallbackQuery({ text: ctx.t("expiredButton"), show_alert: true });
    const location = cached.locations[Number(ctx.match[2])];
    if (!location) return ctx.answerCallbackQuery({ text: ctx.t("expiredButton"), show_alert: true });
    const current = await getCurrentWeather(location);
    const described = describeWeather(current.weatherCode, ctx.locale);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ctx.t("weatherDetails", {
      location: escapeHtml([location.name, location.admin1, location.country].filter(Boolean).join(", ")),
      emoji: described.emoji, condition: described.description, temperature: current.temperature,
      feels: current.apparentTemperature, humidity: current.humidity, wind: current.windSpeed,
    }), { parse_mode: "HTML" });
  });

  bot.command(["tr", "translate"], async (ctx) => {
    const raw = commandText(ctx);
    const [language = "", ...rest] = raw.split(/\s+/);
    const replied = ctx.message?.reply_to_message?.text ?? ctx.message?.reply_to_message?.caption;
    const text = rest.join(" ").trim() || replied?.trim() || "";
    if (!language || !text) return ctx.reply(ctx.t("translateUsage"), { parse_mode: "HTML" });
    const [source, target] = language.includes("-") ? language.split("-", 2) : ["auto", language];
    const result = await translateText(text.slice(0, 4000), source || "auto", target || "pt");
    await ctx.reply(ctx.t("translation", { source: escapeHtml(result.source), target: escapeHtml(result.target), text: escapeHtml(truncate(result.text, 3500)) }), { parse_mode: "HTML" });
  });
  bot.command("slap", async (ctx) => {
    const target = ctx.message?.reply_to_message?.from;
    if (!target || !ctx.from) return ctx.reply(ctx.t("slapNeedReply"), { parse_mode: "HTML" });
    const actions = ctx.locale === "pt_BR" ? ["deu um tapa em", "jogou um travesseiro em", "empurrou de leve", "atingiu com um peixe virtual"] : ["slapped", "threw a pillow at", "gently pushed", "hit with a virtual fish"];
    const action = actions[Math.floor(Math.random() * actions.length)]!;
    await ctx.reply(`🫲 <b>${escapeHtml(ctx.from.first_name)}</b> ${action} <b>${escapeHtml(target.first_name)}</b>.`, { parse_mode: "HTML" });
  });
  bot.command("ping", async (ctx) => { const start = Date.now(); const message = await ctx.reply("🏓"); await ctx.api.editMessageText(message.chat.id, message.message_id, ctx.t("ping", { ms: Date.now() - start }), { parse_mode: "HTML" }); });
  bot.command("id", async (ctx) => ctx.reply(ctx.t("idInfo", { userId: ctx.from?.id ?? "-", chatId: ctx.chat?.id ?? "-" }), { parse_mode: "HTML" }));
}
