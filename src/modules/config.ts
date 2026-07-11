import { InlineKeyboard, type Bot } from "grammy";
import { disableCommand, enableCommand, getChatSettings, listDisabledCommands, setLocale, toggleChatSetting, type ChatBooleanSetting, type Locale } from "../database/repositories.js";
import { requireGroupAdmin } from "../middlewares/admin.js";
import type { BotContext } from "../types/context.js";
import { disableableCommands, isDisableable, normalizeCommand } from "../utils/commands.js";

const icons = (value: boolean) => value ? "✅" : "❌";
async function configView(ctx: BotContext) {
  if (!ctx.chat) return;
  const settings = await getChatSettings(ctx.chat.id);
  const keyboard = new InlineKeyboard()
    .text(`${icons(settings.mediaAuto)} ${ctx.t("mediaAuto")}`, "cfg:media_auto").row()
    .text(`${icons(settings.mediaCaption)} ${ctx.t("mediaCaption")}`, "cfg:media_caption").row()
    .text(`${icons(settings.mediaErrors)} ${ctx.t("mediaErrors")}`, "cfg:media_errors").row()
    .text(`${icons(settings.deleteSource)} ${ctx.t("deleteSource")}`, "cfg:delete_source").row()
    .text("🇧🇷 Português", "cfg:lang:pt_BR").text("🇺🇸 English", "cfg:lang:en_US");
  return { text: ctx.t("configTitle"), keyboard };
}

export function registerConfigModule(bot: Bot<BotContext>) {
  bot.command("config", async (ctx) => { if (!await requireGroupAdmin(ctx)) return; const view = await configView(ctx); if (view) await ctx.reply(view.text, { parse_mode: "HTML", reply_markup: view.keyboard }); });
  bot.callbackQuery(/^cfg:(media_auto|media_caption|media_errors|delete_source)$/, async (ctx) => {
    if (!await requireGroupAdmin(ctx)) return ctx.answerCallbackQuery({ text: ctx.t("adminOnly"), show_alert: true });
    const setting = ctx.match[1] as ChatBooleanSetting;
    await toggleChatSetting(ctx.chat!.id, setting);
    const view = await configView(ctx);
    await ctx.answerCallbackQuery({ text: ctx.t("saved") });
    if (view) await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  });
  bot.callbackQuery(/^cfg:lang:(pt_BR|en_US)$/, async (ctx) => {
    if (!await requireGroupAdmin(ctx)) return ctx.answerCallbackQuery({ text: ctx.t("adminOnly"), show_alert: true });
    const locale = ctx.match[1] as Locale;
    await setLocale("chat", ctx.chat!.id, locale);
    ctx.locale = locale;
    const view = await configView(ctx);
    await ctx.answerCallbackQuery({ text: ctx.t("saved") });
    if (view) await ctx.editMessageText(view.text, { parse_mode: "HTML", reply_markup: view.keyboard });
  });
  bot.command("disable", async (ctx) => {
    if (!await requireGroupAdmin(ctx)) return;
    const command = normalizeCommand(ctx.match.trim().split(/\s+/)[0] ?? "");
    if (!command) return ctx.reply(ctx.t("disableUsage"), { parse_mode: "HTML" });
    if (!isDisableable(command)) return ctx.reply(ctx.t("invalidCommand"), { parse_mode: "HTML" });
    const changed = await disableCommand(ctx.chat!.id, command);
    await ctx.reply(ctx.t(changed ? "commandDisabledOk" : "commandAlreadyDisabled", { command }), { parse_mode: "HTML" });
  });
  bot.command("enable", async (ctx) => {
    if (!await requireGroupAdmin(ctx)) return;
    const command = normalizeCommand(ctx.match.trim().split(/\s+/)[0] ?? "");
    if (!command) return ctx.reply(ctx.t("enableUsage"), { parse_mode: "HTML" });
    if (!isDisableable(command)) return ctx.reply(ctx.t("invalidCommand"), { parse_mode: "HTML" });
    const changed = await enableCommand(ctx.chat!.id, command);
    await ctx.reply(ctx.t(changed ? "commandEnabledOk" : "commandAlreadyEnabled", { command }), { parse_mode: "HTML" });
  });
  bot.command("disabled", async (ctx) => {
    if (!await requireGroupAdmin(ctx)) return;
    const commands = await listDisabledCommands(ctx.chat!.id);
    await ctx.reply(commands.length ? ctx.t("disabledCommands", { commands: commands.map((x) => `• <code>/${x}</code>`).join("\n") }) : ctx.t("noDisabledCommands"), { parse_mode: "HTML" });
  });
  bot.command("disableable", async (ctx) => ctx.reply(ctx.t("disableableCommands", { commands: disableableCommands.map((x) => `• <code>/${x}</code>`).join("\n") }), { parse_mode: "HTML" }));
}
