import PQueue from "p-queue";
import { GrammyError, InlineKeyboard, type Bot } from "grammy";
import { cacheGetJson, cacheSetJson } from "../cache/redis.js";
import { countAudience, listAudience, markUserBlocked, writeAuditLog } from "../database/repositories.js";
import { isOwner } from "../middlewares/admin.js";
import type { BotContext } from "../types/context.js";
import { escapeHtml, truncate } from "../utils/html.js";

interface Announcement { ownerId: number; target: "users" | "groups" | "all"; message: string; }
async function ownerGuard(ctx: BotContext) { if (isOwner(ctx.from?.id)) return true; await ctx.reply(ctx.t("ownerOnly"), { parse_mode: "HTML" }); return false; }

export function registerOwnerModule(bot: Bot<BotContext>) {
  bot.command("stats", async (ctx) => { if (!await ownerGuard(ctx)) return; const stats = await countAudience(); await ctx.reply(ctx.t("stats", stats), { parse_mode: "HTML" }); });
  bot.command("announce", async (ctx) => {
    if (!await ownerGuard(ctx)) return;
    const [rawTarget, ...parts] = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/);
    const target = rawTarget as "users" | "groups" | "all";
    const message = parts.join(" ").trim();
    if (!(["users", "groups", "all"] as string[]).includes(target ?? "") || !message) return ctx.reply(ctx.t("announceUsage"), { parse_mode: "HTML" });
    const token = crypto.randomUUID().slice(0, 10);
    await cacheSetJson(`announce:${token}`, { ownerId: ctx.from!.id, target, message } satisfies Announcement, 1800);
    const keyboard = new InlineKeyboard().text(`✅ ${ctx.t("confirm")}`, `announce:${token}:confirm`).text(`❌ ${ctx.t("cancel")}`, `announce:${token}:cancel`);
    await ctx.reply(ctx.t("announcePreview", { target, message: escapeHtml(truncate(message, 3000)) }), { parse_mode: "HTML", reply_markup: keyboard });
  });
  bot.callbackQuery(/^announce:([a-f0-9]{10}):(confirm|cancel)$/, async (ctx) => {
    const data = await cacheGetJson<Announcement>(`announce:${ctx.match[1]}`);
    if (!data || data.ownerId !== ctx.from.id || !isOwner(ctx.from.id)) return ctx.answerCallbackQuery({ text: ctx.t("expiredButton"), show_alert: true });
    if (ctx.match[2] === "cancel") { await ctx.answerCallbackQuery(); return ctx.editMessageText(ctx.t("cancelled")); }
    await ctx.answerCallbackQuery(); await ctx.editMessageText("⏳ Enviando anúncio…");
    const audience = await listAudience(data.target);
    const queue = new PQueue({ concurrency: 20, interval: 1000, intervalCap: 25 });
    let sent = 0; let failed = 0;
    await Promise.all(audience.map((chatId) => queue.add(async () => {
      try { await ctx.api.sendMessage(chatId, data.message); sent += 1; }
      catch (error) { failed += 1; if (error instanceof GrammyError && error.error_code === 403 && chatId > 0) await markUserBlocked(chatId).catch(() => undefined); }
    })));
    await writeAuditLog({ actorId: ctx.from.id, chatId: ctx.chat?.id, action: "announcement", metadata: { target: data.target, sent, failed } });
    await ctx.editMessageText(ctx.t("announceDone", { sent, failed }), { parse_mode: "HTML" });
  });
}
