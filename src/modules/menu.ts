import { InlineKeyboard, type Bot } from "grammy";
import { env } from "../config/env.js";
import type { BotContext } from "../types/context.js";

function menuKeyboard(username?: string) {
  const keyboard = new InlineKeyboard().text("📚 Comandos", "menu:help").text("🔒 Privacidade", "menu:privacy");
  if (username) keyboard.row().url("➕ Adicionar a um grupo", `https://t.me/${username}?startgroup=true`);
  return keyboard;
}

export function registerMenuModule(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    await ctx.reply(ctx.t("start", { bot: env.BOT_DISPLAY_NAME }), { parse_mode: "HTML", reply_markup: menuKeyboard(ctx.me.username) });
  });
  bot.command("help", async (ctx) => ctx.reply(ctx.t("help", { bot: env.BOT_DISPLAY_NAME }), { parse_mode: "HTML", reply_markup: menuKeyboard(ctx.me.username) }));
  bot.command("privacy", async (ctx) => ctx.reply(ctx.t("privacy"), { parse_mode: "HTML" }));
  bot.callbackQuery("menu:help", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText(ctx.t("help", { bot: env.BOT_DISPLAY_NAME }), { parse_mode: "HTML", reply_markup: menuKeyboard(ctx.me.username) }); });
  bot.callbackQuery("menu:privacy", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText(ctx.t("privacy"), { parse_mode: "HTML", reply_markup: menuKeyboard(ctx.me.username) }); });
}
