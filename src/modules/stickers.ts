import { InlineKeyboard, type Bot } from "grammy";
import { createStickerPack, deleteStickerPackRecord, getDefaultStickerPack, listStickerPacks, setDefaultStickerPack, type StickerFormat, type StickerPackRecord } from "../database/repositories.js";
import { addStickerToPack, createPackWithSticker, deleteTelegramStickerPack, exportSticker, getPackSize, prepareStickerFromMessage, type PreparedSticker } from "../services/stickers.js";
import type { BotContext } from "../types/context.js";
import { errorCode } from "../utils/errors.js";
import { escapeHtml } from "../utils/html.js";

function formatLabel(format: StickerFormat) { return format === "static" ? "estático" : format === "animated" ? "animado" : "vídeo"; }
function cleanEmoji(raw: string) { return raw.trim().split(/\s+/)[0]?.slice(0, 16) || "✨"; }
function packName(ctx: BotContext, userId: number, index = 1) {
  const username = ctx.me.username.replace(/[^A-Za-z0-9_]/g, "").slice(0, 28);
  const suffix = `_by_${username}`;
  let base = `nova_${userId}_${Date.now().toString(36)}_${index}`.replace(/[^A-Za-z0-9_]/g, "_");
  base = base.slice(0, Math.max(1, 64 - suffix.length)).replace(/_+$/g, "");
  if (!/^[A-Za-z]/.test(base)) base = `n${base}`;
  return `${base}${suffix}`.slice(0, 64);
}
function packTitle(ctx: BotContext, requested: string, format: StickerFormat, index = 1) {
  const base = requested.trim().slice(0, 46) || `${ctx.from?.first_name ?? "Meu"} • Nova`;
  return `${base}${index > 1 ? ` ${index}` : ""} (${formatLabel(format)})`.slice(0, 64);
}
async function persistPack(ctx: BotContext, prepared: PreparedSticker, title: string, index = 1) {
  const userId = ctx.from!.id;
  const name = packName(ctx, userId, index);
  const finalTitle = packTitle(ctx, title, prepared.format, index);
  await createPackWithSticker(ctx, userId, name, finalTitle, prepared);
  return createStickerPack({ userId, packName: name, title: finalTitle, format: prepared.format, makeDefault: true });
}
async function createNextPack(ctx: BotContext, prepared: PreparedSticker, previous?: StickerPackRecord) {
  const sameFormat = await listStickerPacks(ctx.from!.id, prepared.format);
  const title = previous?.title.replace(/\s+\d+\s+\([^)]*\)$/u, "") ?? `${ctx.from!.first_name} • Nova`;
  return persistPack(ctx, prepared, title, sameFormat.length + 1);
}
async function prepare(ctx: BotContext, emoji: string) {
  const status = await ctx.reply(ctx.t("stickerPreparing"), { parse_mode: "HTML" }).catch(() => undefined);
  try { return await prepareStickerFromMessage(ctx, emoji); }
  finally { if (status) await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => undefined); }
}
async function handleKang(ctx: BotContext) {
  if (!ctx.from) return;
  let prepared: PreparedSticker | undefined;
  try {
    prepared = await prepare(ctx, cleanEmoji(typeof ctx.match === "string" ? ctx.match : ""));
    let pack = await getDefaultStickerPack(ctx.from.id, prepared.format);
    if (!pack) {
      pack = await persistPack(ctx, prepared, "", 1);
      await ctx.reply(ctx.t("stickerPackCreated", { pack: pack.packName, title: escapeHtml(pack.title) }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }
    const limit = prepared.format === "static" ? 120 : 50;
    const size = await getPackSize(ctx, pack.packName);
    if (size >= limit) {
      pack = await createNextPack(ctx, prepared, pack);
      await ctx.reply(`${ctx.t("stickerPackFull")}\n${ctx.t("stickerPackCreated", { pack: pack.packName, title: escapeHtml(pack.title) })}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }
    await addStickerToPack(ctx, ctx.from.id, pack.packName, prepared);
    await ctx.reply(ctx.t("stickerAdded", { pack: pack.packName, title: escapeHtml(pack.title) }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    if (error instanceof Error && ["UNSUPPORTED_STICKER_SOURCE", "Mídia não encontrada"].includes(error.message)) return ctx.reply(ctx.t("stickerReplyRequired"), { parse_mode: "HTML" });
    const code = errorCode("STK");
    await ctx.reply(ctx.t("stickerFailed", { code }), { parse_mode: "HTML" });
  } finally { await prepared?.cleanup?.().catch(() => undefined); }
}

export function registerStickerModule(bot: Bot<BotContext>) {
  bot.command("kang", handleKang);
  bot.command("newpack", async (ctx) => {
    if (!ctx.from) return;
    let prepared: PreparedSticker | undefined;
    try {
      prepared = await prepare(ctx, "✨");
      const packs = await listStickerPacks(ctx.from.id, prepared.format);
      const pack = await persistPack(ctx, prepared, typeof ctx.match === "string" ? ctx.match : "", packs.length + 1);
      await ctx.reply(ctx.t("stickerPackCreated", { pack: pack.packName, title: escapeHtml(pack.title) }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      if (error instanceof Error && error.message === "UNSUPPORTED_STICKER_SOURCE") return ctx.reply(ctx.t("stickerReplyRequired"), { parse_mode: "HTML" });
      const code = errorCode("STK"); await ctx.reply(ctx.t("stickerFailed", { code }), { parse_mode: "HTML" });
    } finally { await prepared?.cleanup?.().catch(() => undefined); }
  });
  bot.command("mypacks", async (ctx) => {
    const packs = await listStickerPacks(ctx.from!.id);
    if (!packs.length) return ctx.reply(ctx.t("noPacks"), { parse_mode: "HTML" });
    const lines = packs.map((pack) => `${pack.isDefault ? "⭐" : "•"} <a href="https://t.me/addstickers/${pack.packName}">${escapeHtml(pack.title)}</a> — ${formatLabel(pack.format)}`);
    await ctx.reply(ctx.t("packsTitle", { packs: lines.join("\n") }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });
  bot.command("switch", async (ctx) => {
    const packs = await listStickerPacks(ctx.from!.id);
    if (!packs.length) return ctx.reply(ctx.t("noPacks"), { parse_mode: "HTML" });
    const keyboard = new InlineKeyboard(); packs.forEach((pack) => keyboard.text(`${pack.isDefault ? "⭐ " : ""}${pack.title}`, `pack:switch:${pack.id}`).row());
    await ctx.reply(ctx.t("choosePack"), { reply_markup: keyboard });
  });
  bot.callbackQuery(/^pack:switch:(\d+)$/, async (ctx) => {
    const pack = (await listStickerPacks(ctx.from.id)).find((item) => item.id === Number(ctx.match[1]));
    if (!pack || !await setDefaultStickerPack(ctx.from.id, pack.id)) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    await ctx.answerCallbackQuery({ text: ctx.t("saved") });
    await ctx.editMessageText(ctx.t("packSwitched", { title: escapeHtml(pack.title) }), { parse_mode: "HTML" });
  });
  bot.command("delpack", async (ctx) => {
    const packs = await listStickerPacks(ctx.from!.id);
    if (!packs.length) return ctx.reply(ctx.t("noPacks"), { parse_mode: "HTML" });
    const keyboard = new InlineKeyboard(); packs.forEach((pack) => keyboard.text(`🗑 ${pack.title}`, `pack:delete:${pack.id}`).row());
    await ctx.reply(ctx.t("chooseDeletePack"), { reply_markup: keyboard });
  });
  bot.callbackQuery(/^pack:delete:(\d+)$/, async (ctx) => {
    const pack = (await listStickerPacks(ctx.from.id)).find((item) => item.id === Number(ctx.match[1]));
    if (!pack) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    const keyboard = new InlineKeyboard().text(ctx.t("confirm"), `pack:delete-confirm:${pack.id}`).text(ctx.t("cancel"), "pack:cancel");
    await ctx.answerCallbackQuery(); await ctx.editMessageText(ctx.t("confirmDeletePack", { title: escapeHtml(pack.title) }), { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^pack:delete-confirm:(\d+)$/, async (ctx) => {
    const pack = (await listStickerPacks(ctx.from.id)).find((item) => item.id === Number(ctx.match[1]));
    if (!pack) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    await deleteTelegramStickerPack(ctx, pack.packName);
    await deleteStickerPackRecord(ctx.from.id, pack.id);
    await ctx.answerCallbackQuery({ text: ctx.t("packDeleted") }); await ctx.editMessageText(ctx.t("packDeleted"));
  });
  bot.callbackQuery("pack:cancel", async (ctx) => { await ctx.answerCallbackQuery(); await ctx.editMessageText(ctx.t("cancelled")); });
  bot.command("getsticker", async (ctx) => {
    try { const file = await exportSticker(ctx); try { await ctx.replyWithDocument(file.input); } finally { await file.cleanup(); } }
    catch { await ctx.reply(ctx.t("stickerReplyRequired"), { parse_mode: "HTML" }); }
  });
}
