import type { Bot, MiddlewareFn } from "grammy";
import { clearAfk, findUserIdByUsername, getAfkByIds, setAfk } from "../database/repositories.js";
import type { BotContext } from "../types/context.js";
import { escapeHtml } from "../utils/html.js";
import { formatDurationSince } from "../utils/time.js";

export const afkMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const text = ctx.message?.text ?? ctx.message?.caption ?? "";
  const settingAfk = /^\/?afk(?:@\w+)?\b/i.test(text) || /^brb\b/i.test(text);
  if (ctx.from && !settingAfk) {
    const previous = await clearAfk(ctx.from.id);
    if (previous) await ctx.reply(ctx.t("afkBack", { name: escapeHtml(ctx.from.first_name), duration: formatDurationSince(previous.since, ctx.locale) }), { parse_mode: "HTML" }).catch(() => undefined);
  }

  const ids = new Set<number>();
  const replied = ctx.message?.reply_to_message?.from;
  if (replied && !replied.is_bot) ids.add(replied.id);
  for (const username of text.match(/@[A-Za-z0-9_]{5,32}/g) ?? []) {
    const id = await findUserIdByUsername(username);
    if (id) ids.add(id);
  }
  if (ctx.from) ids.delete(ctx.from.id);
  const statuses = await getAfkByIds([...ids]);
  for (const status of statuses.slice(0, 3)) {
    await ctx.reply(ctx.t("afkMention", { name: escapeHtml(status.firstName), duration: formatDurationSince(status.since, ctx.locale), reason: escapeHtml(status.reason) }), { parse_mode: "HTML" }).catch(() => undefined);
  }
  await next();
};

async function handleAfk(ctx: BotContext, reason: string) {
  if (!ctx.from) return;
  const clean = reason.trim().slice(0, 300) || (ctx.locale === "pt_BR" ? "Ausente" : "Away");
  await setAfk(ctx.from, clean);
  await ctx.reply(ctx.t("afkSet", { name: escapeHtml(ctx.from.first_name), reason: escapeHtml(clean) }), { parse_mode: "HTML" });
}

export function registerAfkModule(bot: Bot<BotContext>) {
  bot.command("afk", async (ctx) => handleAfk(ctx, ctx.match));
  bot.hears(/^brb(?:\s+([\s\S]+))?$/i, async (ctx) => handleAfk(ctx, ctx.match?.[1] ?? ""));
}
