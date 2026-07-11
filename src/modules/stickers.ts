import { InlineKeyboard, type Bot } from "grammy";
import { logger } from "../config/logger.js";
import {
  createStickerPack,
  deleteStickerPackRecord,
  getDefaultStickerPack,
  listStickerPacks,
  setDefaultStickerPack,
  updateStickerPackTitle,
  type StickerPackRecord,
} from "../database/repositories.js";
import {
  addStickerToPack,
  createPackWithSticker,
  deleteTelegramStickerPack,
  exportSticker,
  getTelegramStickerPack,
  isStickerSetInvalidError,
  prepareStickerFromMessage,
  renameTelegramStickerPack,
  type PreparedSticker,
} from "../services/stickers.js";
import type { BotContext } from "../types/context.js";
import { errorCode } from "../utils/errors.js";
import { escapeHtml } from "../utils/html.js";

function cleanEmoji(raw: string) {
  return raw.trim().split(/\s+/)[0]?.slice(0, 16) || "✨";
}

export function cleanLegacyPackTitle(title: string) {
  return title
    .replace(/\s+\((?:estático|animado|vídeo|static|animated|video)\)\s*$/iu, "")
    .trim()
    .slice(0, 64);
}

function packName(ctx: BotContext, userId: number, index = 1) {
  const username = ctx.me.username.replace(/[^A-Za-z0-9_]/g, "").slice(0, 28);
  const suffix = `_by_${username}`;
  let base = `nova_${userId}_${Date.now().toString(36)}_${index}`.replace(/[^A-Za-z0-9_]/g, "_");
  base = base.slice(0, Math.max(1, 64 - suffix.length)).replace(/_+$/g, "");
  if (!/^[A-Za-z]/.test(base)) base = `n${base}`;
  return `${base}${suffix}`.slice(0, 64);
}

function packTitle(ctx: BotContext, requested: string, index = 1) {
  const base = cleanLegacyPackTitle(requested.trim().slice(0, 58))
    || `${ctx.from?.first_name ?? "Meu"} • Nova`;
  return `${base}${index > 1 ? ` ${index}` : ""}`.slice(0, 64);
}

async function persistPack(ctx: BotContext, prepared: PreparedSticker, title: string, index = 1) {
  const userId = ctx.from!.id;
  const name = packName(ctx, userId, index);
  const finalTitle = packTitle(ctx, title, index);
  await createPackWithSticker(ctx, userId, name, finalTitle, prepared);
  return createStickerPack({
    userId,
    packName: name,
    title: finalTitle,
    format: prepared.format,
    makeDefault: true,
  });
}

async function createNextPack(ctx: BotContext, prepared: PreparedSticker, previous?: StickerPackRecord) {
  const existingPacks = await validStickerPacks(ctx, await listStickerPacks(ctx.from!.id));
  const title = cleanLegacyPackTitle(previous?.title ?? `${ctx.from!.first_name} • Nova`)
    .replace(/\s+\d+$/u, "")
    .trim();
  return persistPack(ctx, prepared, title, existingPacks.length + 1);
}

async function prepare(ctx: BotContext, emoji: string) {
  const status = await ctx.reply(ctx.t("stickerPreparing"), { parse_mode: "HTML" }).catch(() => undefined);
  try {
    return await prepareStickerFromMessage(ctx, emoji);
  } finally {
    if (status) await ctx.api.deleteMessage(status.chat.id, status.message_id).catch(() => undefined);
  }
}

async function validateStickerPack(
  ctx: BotContext,
  pack: StickerPackRecord,
): Promise<{ pack: StickerPackRecord; size: number } | null> {
  try {
    const telegramPack = await getTelegramStickerPack(ctx, pack.packName);
    const cleanTitle = cleanLegacyPackTitle(telegramPack.title || pack.title) || pack.title;

    if (cleanTitle !== telegramPack.title) {
      await renameTelegramStickerPack(ctx, pack.packName, cleanTitle).catch((error) => {
        logger.warn({ error, packName: pack.packName }, "Não foi possível remover o sufixo antigo do título do pacote");
      });
    }
    if (cleanTitle !== pack.title) {
      await updateStickerPackTitle(pack.userId, pack.id, cleanTitle);
    }

    return { pack: { ...pack, title: cleanTitle }, size: telegramPack.stickers.length };
  } catch (error) {
    if (!isStickerSetInvalidError(error)) throw error;
    await deleteStickerPackRecord(pack.userId, pack.id);
    logger.info({ packId: pack.id, packName: pack.packName }, "Pacote removido do banco porque não existe mais no Telegram");
    return null;
  }
}

async function validStickerPacks(ctx: BotContext, packs: StickerPackRecord[]) {
  const valid: StickerPackRecord[] = [];
  // A validação só ocorre ao usar comandos de figurinhas, nunca em mensagens
  // comuns, então um pacote apagado externamente não afeta o restante do bot.
  for (const pack of packs) {
    try {
      const checked = await validateStickerPack(ctx, pack);
      if (checked) valid.push(checked.pack);
    } catch (error) {
      logger.warn({ error, packName: pack.packName }, "Falha temporária ao validar pacote; mantendo registro");
      valid.push(pack);
    }
  }
  return valid;
}

async function resolveDefaultPack(
  ctx: BotContext,
): Promise<{ pack: StickerPackRecord; size: number } | null> {
  const userId = ctx.from!.id;
  const current = await getDefaultStickerPack(userId);

  if (current) {
    const checked = await validateStickerPack(ctx, current);
    if (checked) return checked;
  }

  // Se o pacote padrão foi apagado manualmente, reutiliza outro pacote válido
  // do usuário antes de criar um novo. Essa varredura só acontece na recuperação.
  for (const candidate of await listStickerPacks(userId)) {
    const checked = await validateStickerPack(ctx, candidate);
    if (!checked) continue;
    if (!checked.pack.isDefault) {
      await setDefaultStickerPack(userId, checked.pack.id);
      checked.pack = { ...checked.pack, isDefault: true };
    }
    return checked;
  }

  return null;
}

async function handleKang(ctx: BotContext) {
  if (!ctx.from) return;
  let prepared: PreparedSticker | undefined;
  try {
    prepared = await prepare(ctx, cleanEmoji(typeof ctx.match === "string" ? ctx.match : ""));
    const resolved = await resolveDefaultPack(ctx);
    let pack = resolved?.pack ?? null;
    let size = resolved?.size ?? 0;

    if (!pack) {
      pack = await persistPack(ctx, prepared, "", 1);
      await ctx.reply(ctx.t("stickerPackCreated", {
        pack: pack.packName,
        title: escapeHtml(pack.title),
      }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }

    const limit = 120;
    if (size >= limit) {
      pack = await createNextPack(ctx, prepared, pack);
      await ctx.reply(`${ctx.t("stickerPackFull")}\n${ctx.t("stickerPackCreated", {
        pack: pack.packName,
        title: escapeHtml(pack.title),
      })}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }

    try {
      await addStickerToPack(ctx, ctx.from.id, pack.packName, prepared);
    } catch (error) {
      // O usuário pode apagar o pacote manualmente entre a validação e o add.
      if (!isStickerSetInvalidError(error)) throw error;
      await deleteStickerPackRecord(ctx.from.id, pack.id);

      const fallback = await resolveDefaultPack(ctx);
      if (fallback && fallback.size < 120) {
        pack = fallback.pack;
        await addStickerToPack(ctx, ctx.from.id, pack.packName, prepared);
      } else {
        pack = fallback
          ? await createNextPack(ctx, prepared, fallback.pack)
          : await persistPack(ctx, prepared, "", 1);
        await ctx.reply(ctx.t("stickerPackCreated", {
          pack: pack.packName,
          title: escapeHtml(pack.title),
        }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        return;
      }
    }

    await ctx.reply(ctx.t("stickerAdded", {
      pack: pack.packName,
      title: escapeHtml(pack.title),
    }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    if (error instanceof Error && ["UNSUPPORTED_STICKER_SOURCE", "Mídia não encontrada"].includes(error.message)) {
      return ctx.reply(ctx.t("stickerReplyRequired"), { parse_mode: "HTML" });
    }
    const code = errorCode("STK");
    logger.error({ error, code, userId: ctx.from.id }, "Falha no /kang");
    await ctx.reply(ctx.t("stickerFailed", { code }), { parse_mode: "HTML" });
  } finally {
    await prepared?.cleanup?.().catch(() => undefined);
  }
}

export function registerStickerModule(bot: Bot<BotContext>) {
  bot.command("kang", handleKang);

  bot.command("newpack", async (ctx) => {
    if (!ctx.from) return;
    let prepared: PreparedSticker | undefined;
    try {
      prepared = await prepare(ctx, "✨");
      const packs = await validStickerPacks(ctx, await listStickerPacks(ctx.from.id));
      const pack = await persistPack(
        ctx,
        prepared,
        typeof ctx.match === "string" ? ctx.match : "",
        packs.length + 1,
      );
      await ctx.reply(ctx.t("stickerPackCreated", {
        pack: pack.packName,
        title: escapeHtml(pack.title),
      }), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      if (error instanceof Error && error.message === "UNSUPPORTED_STICKER_SOURCE") {
        return ctx.reply(ctx.t("stickerReplyRequired"), { parse_mode: "HTML" });
      }
      const code = errorCode("STK");
      logger.error({ error, code, userId: ctx.from.id }, "Falha no /newpack");
      await ctx.reply(ctx.t("stickerFailed", { code }), { parse_mode: "HTML" });
    } finally {
      await prepared?.cleanup?.().catch(() => undefined);
    }
  });

  bot.command("mypacks", async (ctx) => {
    const packs = await validStickerPacks(ctx, await listStickerPacks(ctx.from!.id));
    if (!packs.length) return ctx.reply(ctx.t("noPacks"), { parse_mode: "HTML" });
    const lines = packs.map((pack) => `${pack.isDefault ? "⭐" : "•"} <a href="https://t.me/addstickers/${pack.packName}">${escapeHtml(pack.title)}</a>`);
    await ctx.reply(ctx.t("packsTitle", { packs: lines.join("\n") }), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command("switch", async (ctx) => {
    const packs = await validStickerPacks(ctx, await listStickerPacks(ctx.from!.id));
    if (!packs.length) return ctx.reply(ctx.t("noPacks"), { parse_mode: "HTML" });
    const keyboard = new InlineKeyboard();
    packs.forEach((pack) => keyboard.text(`${pack.isDefault ? "⭐ " : ""}${pack.title}`, `pack:switch:${pack.id}`).row());
    await ctx.reply(ctx.t("choosePack"), { reply_markup: keyboard });
  });

  bot.callbackQuery(/^pack:switch:(\d+)$/, async (ctx) => {
    const pack = (await listStickerPacks(ctx.from.id)).find((item) => item.id === Number(ctx.match[1]));
    if (!pack) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    const checked = await validateStickerPack(ctx, pack).catch(() => null);
    if (!checked || !await setDefaultStickerPack(ctx.from.id, checked.pack.id)) {
      return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    }
    await ctx.answerCallbackQuery({ text: ctx.t("saved") });
    await ctx.editMessageText(ctx.t("packSwitched", { title: escapeHtml(checked.pack.title) }), { parse_mode: "HTML" });
  });

  bot.command("delpack", async (ctx) => {
    const packs = await validStickerPacks(ctx, await listStickerPacks(ctx.from!.id));
    if (!packs.length) return ctx.reply(ctx.t("noPacks"), { parse_mode: "HTML" });
    const keyboard = new InlineKeyboard();
    packs.forEach((pack) => keyboard.text(`🗑 ${pack.title}`, `pack:delete:${pack.id}`).row());
    await ctx.reply(ctx.t("chooseDeletePack"), { reply_markup: keyboard });
  });

  bot.callbackQuery(/^pack:delete:(\d+)$/, async (ctx) => {
    const pack = (await listStickerPacks(ctx.from.id)).find((item) => item.id === Number(ctx.match[1]));
    if (!pack) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    const checked = await validateStickerPack(ctx, pack).catch(() => null);
    if (!checked) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    const keyboard = new InlineKeyboard()
      .text(ctx.t("confirm"), `pack:delete-confirm:${checked.pack.id}`)
      .text(ctx.t("cancel"), "pack:cancel");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ctx.t("confirmDeletePack", { title: escapeHtml(checked.pack.title) }), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^pack:delete-confirm:(\d+)$/, async (ctx) => {
    const pack = (await listStickerPacks(ctx.from.id)).find((item) => item.id === Number(ctx.match[1]));
    if (!pack) return ctx.answerCallbackQuery({ text: ctx.t("packNotFound"), show_alert: true });
    try {
      await deleteTelegramStickerPack(ctx, pack.packName);
    } catch (error) {
      // Se o pacote já foi apagado manualmente, limpamos só o registro local.
      if (!isStickerSetInvalidError(error)) {
        const code = errorCode("STK");
        logger.error({ error, code, packName: pack.packName }, "Falha ao excluir pacote de figurinhas");
        await ctx.answerCallbackQuery({ text: ctx.t("stickerFailed", { code }), show_alert: true });
        return;
      }
    }
    await deleteStickerPackRecord(ctx.from.id, pack.id);
    await ctx.answerCallbackQuery({ text: ctx.t("packDeleted") });
    await ctx.editMessageText(ctx.t("packDeleted"));
  });

  bot.callbackQuery("pack:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(ctx.t("cancelled"));
  });

  bot.command("getsticker", async (ctx) => {
    try {
      const file = await exportSticker(ctx);
      try { await ctx.replyWithDocument(file.input); } finally { await file.cleanup(); }
    } catch {
      await ctx.reply(ctx.t("stickerReplyRequired"), { parse_mode: "HTML" });
    }
  });
}
