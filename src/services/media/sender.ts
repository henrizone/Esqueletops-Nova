import { InputFile, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { env } from "../../config/env.js";
import type { BotContext } from "../../types/context.js";
import type { CachedMediaItem, CachedMediaPayload, PreparedMediaItem } from "./types.js";
import { sourceKeyboard } from "./source-button.js";

function replyParams(replyToMessageId?: number) {
  return replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {};
}

function fileIdFromMessage(message: Message, kind: CachedMediaItem["kind"]): string | undefined {
  if (kind === "photo" && message.photo?.length) return message.photo.at(-1)?.file_id;
  if (kind === "video") return message.video?.file_id;
  if (kind === "audio") return message.audio?.file_id;
  if (kind === "document") return message.document?.file_id;
  return undefined;
}

async function sendOne(
  ctx: BotContext,
  item: PreparedMediaItem | CachedMediaItem,
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<Message> {
  const media = "path" in item ? new InputFile(item.path, item.filename) : item.fileId;
  const replyMarkup = env.MEDIA_SOURCE_BUTTON && sourceUrl ? sourceKeyboard(sourceUrl) : undefined;
  const common = {
    caption: caption || undefined,
    parse_mode: "HTML" as const,
    reply_markup: replyMarkup,
    ...replyParams(replyToMessageId),
  };
  switch (item.kind) {
    case "photo": return ctx.replyWithPhoto(media, common);
    case "video": return ctx.replyWithVideo(media, { ...common, supports_streaming: true });
    case "audio": return ctx.replyWithAudio(media, { ...common, title: item.filename });
    default: return ctx.replyWithDocument(media, common);
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

/**
 * Quando existe botão de origem, as mídias são enviadas individualmente para
 * que o botão fique na própria mensagem de mídia. sendMediaGroup não aceita
 * reply_markup, então não usamos uma mensagem "🔗" separada.
 */
async function sendSequential<T extends PreparedMediaItem | CachedMediaItem>(
  ctx: BotContext,
  items: T[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  for (let index = 0; index < items.length; index += 1) {
    messages.push(await sendOne(
      ctx,
      items[index]!,
      index === 0 ? caption : "",
      index === 0 ? replyToMessageId : undefined,
      index === 0 ? sourceUrl : undefined,
    ));
  }
  return messages;
}

export async function sendTextPost(
  ctx: BotContext,
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<void> {
  await ctx.reply(caption || "Publicação sem mídia.", {
    parse_mode: "HTML",
    reply_markup: env.MEDIA_SOURCE_BUTTON && sourceUrl ? sourceKeyboard(sourceUrl) : undefined,
    link_preview_options: { is_disabled: true },
    ...replyParams(replyToMessageId),
  });
}

export async function sendPreparedMedia(
  ctx: BotContext,
  items: PreparedMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<CachedMediaItem[]> {
  const mustSendSequentially = Boolean(env.MEDIA_SOURCE_BUTTON && sourceUrl)
    || items.some((item) => item.kind === "audio" || item.kind === "document");

  if (mustSendSequentially) {
    const messages = await sendSequential(ctx, items, caption, replyToMessageId, sourceUrl);
    return messages.flatMap((message, index) => {
      const item = items[index];
      if (!item) return [];
      const fileId = fileIdFromMessage(message, item.kind);
      return fileId ? [{ kind: item.kind, fileId, filename: item.filename } satisfies CachedMediaItem] : [];
    });
  }

  const cached: CachedMediaItem[] = [];
  let globalIndex = 0;
  for (const groupItems of chunks(items, 10)) {
    if (groupItems.length === 1) {
      const item = groupItems[0]!;
      const message = await sendOne(
        ctx,
        item,
        globalIndex === 0 ? caption : "",
        globalIndex === 0 ? replyToMessageId : undefined,
      );
      const fileId = fileIdFromMessage(message, item.kind);
      if (fileId) cached.push({ kind: item.kind, fileId, filename: item.filename });
      globalIndex += 1;
      continue;
    }

    const group = groupItems.map((item, index) => {
      const media = new InputFile(item.path, item.filename);
      const options = globalIndex === 0 && index === 0 && caption ? { caption, parse_mode: "HTML" as const } : undefined;
      return item.kind === "photo"
        ? InputMediaBuilder.photo(media, options)
        : InputMediaBuilder.video(media, { ...options, supports_streaming: true });
    });
    const messages = await ctx.replyWithMediaGroup(group, globalIndex === 0 ? replyParams(replyToMessageId) : {});
    messages.forEach((message, index) => {
      const item = groupItems[index];
      if (!item) return;
      const fileId = fileIdFromMessage(message, item.kind);
      if (fileId) cached.push({ kind: item.kind, fileId, filename: item.filename });
    });
    globalIndex += groupItems.length;
  }
  return cached;
}

export async function sendCachedMedia(
  ctx: BotContext,
  payload: CachedMediaPayload,
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<void> {
  const mustSendSequentially = Boolean(env.MEDIA_SOURCE_BUTTON && sourceUrl)
    || payload.items.some((item) => item.kind === "audio" || item.kind === "document");
  if (mustSendSequentially) {
    await sendSequential(ctx, payload.items, caption, replyToMessageId, sourceUrl);
    return;
  }

  let globalIndex = 0;
  for (const groupItems of chunks(payload.items, 10)) {
    if (groupItems.length === 1) {
      await sendOne(
        ctx,
        groupItems[0]!,
        globalIndex === 0 ? caption : "",
        globalIndex === 0 ? replyToMessageId : undefined,
      );
      globalIndex += 1;
      continue;
    }
    const group = groupItems.map((item, index) => {
      const options = globalIndex === 0 && index === 0 && caption ? { caption, parse_mode: "HTML" as const } : undefined;
      return item.kind === "photo"
        ? InputMediaBuilder.photo(item.fileId, options)
        : InputMediaBuilder.video(item.fileId, { ...options, supports_streaming: true });
    });
    await ctx.replyWithMediaGroup(group, globalIndex === 0 ? replyParams(replyToMessageId) : {});
    globalIndex += groupItems.length;
  }
}
