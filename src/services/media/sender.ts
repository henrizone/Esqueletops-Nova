import { InputFile, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
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

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function isAlbumMedia(item: PreparedMediaItem | CachedMediaItem) {
  return item.kind === "photo" || item.kind === "video";
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
    case "photo":
      return ctx.replyWithPhoto(media, common);
    case "video":
      return ctx.replyWithVideo(media, { ...common, supports_streaming: true });
    case "audio":
      return ctx.replyWithAudio(media, { ...common, title: item.filename });
    default:
      return ctx.replyWithDocument(media, common);
  }
}

/**
 * O Bot API não recebe reply_markup diretamente em sendMediaGroup. Porém, as
 * mensagens retornadas pelo álbum podem ser editadas logo após o envio. Ao
 * anexar o teclado à última mensagem do media_group, os clientes do Telegram
 * mostram o botão embaixo do álbum, no mesmo bloco visual das mídias.
 */
async function attachKeyboardToAlbum(
  ctx: BotContext,
  messages: Message[],
  sourceUrl?: string,
): Promise<void> {
  if (!env.MEDIA_SOURCE_BUTTON || !sourceUrl || messages.length === 0) return;
  const keyboard = sourceKeyboard(sourceUrl);
  const candidates = [...messages].reverse();

  for (const message of candidates) {
    try {
      await ctx.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
        reply_markup: keyboard,
      });
      return;
    } catch (error) {
      logger.debug({ error, messageId: message.message_id }, "Não foi possível anexar o botão a este item do álbum");
    }
  }

  logger.warn({ sourceUrl }, "O álbum foi enviado, mas o Telegram não aceitou o botão de origem");
}

function preparedAlbumItem(item: PreparedMediaItem, options?: { caption: string; parse_mode: "HTML" }) {
  const media = new InputFile(item.path, item.filename);
  return item.kind === "photo"
    ? InputMediaBuilder.photo(media, options)
    : InputMediaBuilder.video(media, { ...options, supports_streaming: true });
}

function cachedAlbumItem(item: CachedMediaItem, options?: { caption: string; parse_mode: "HTML" }) {
  return item.kind === "photo"
    ? InputMediaBuilder.photo(item.fileId, options)
    : InputMediaBuilder.video(item.fileId, { ...options, supports_streaming: true });
}

async function sendPreparedAlbumChunk(
  ctx: BotContext,
  items: PreparedMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<{ messages: Message[]; cached: CachedMediaItem[] }> {
  if (items.length === 1) {
    const message = await sendOne(ctx, items[0]!, caption, replyToMessageId, sourceUrl);
    const fileId = fileIdFromMessage(message, items[0]!.kind);
    return {
      messages: [message],
      cached: fileId ? [{ kind: items[0]!.kind, fileId, filename: items[0]!.filename }] : [],
    };
  }

  const group = items.map((item, index) => preparedAlbumItem(
    item,
    index === 0 && caption ? { caption, parse_mode: "HTML" } : undefined,
  ));
  const messages = await ctx.replyWithMediaGroup(group, replyParams(replyToMessageId));
  await attachKeyboardToAlbum(ctx, messages, sourceUrl);

  const cached = messages.flatMap((message, index) => {
    const item = items[index];
    if (!item) return [];
    const fileId = fileIdFromMessage(message, item.kind);
    return fileId ? [{ kind: item.kind, fileId, filename: item.filename } satisfies CachedMediaItem] : [];
  });
  return { messages, cached };
}

async function sendCachedAlbumChunk(
  ctx: BotContext,
  items: CachedMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<void> {
  if (items.length === 1) {
    await sendOne(ctx, items[0]!, caption, replyToMessageId, sourceUrl);
    return;
  }

  const group = items.map((item, index) => cachedAlbumItem(
    item,
    index === 0 && caption ? { caption, parse_mode: "HTML" } : undefined,
  ));
  const messages = await ctx.replyWithMediaGroup(group, replyParams(replyToMessageId));
  await attachKeyboardToAlbum(ctx, messages, sourceUrl);
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
  const cached: CachedMediaItem[] = [];
  const albumItems = items.filter(isAlbumMedia);
  const otherItems = items.filter((item) => !isAlbumMedia(item));
  let firstMessage = true;

  // Fotos e vídeos, inclusive misturados, são enviados como um único álbum
  // visual. O Telegram aceita no máximo 10 itens por media_group.
  for (const groupItems of chunks(albumItems, 10)) {
    const result = await sendPreparedAlbumChunk(
      ctx,
      groupItems,
      firstMessage ? caption : "",
      firstMessage ? replyToMessageId : undefined,
      firstMessage ? sourceUrl : undefined,
    );
    cached.push(...result.cached);
    firstMessage = false;
  }

  // Áudio e documento não podem participar de um álbum misto com foto/vídeo.
  for (const item of otherItems) {
    const message = await sendOne(
      ctx,
      item,
      firstMessage ? caption : "",
      firstMessage ? replyToMessageId : undefined,
      firstMessage ? sourceUrl : undefined,
    );
    const fileId = fileIdFromMessage(message, item.kind);
    if (fileId) cached.push({ kind: item.kind, fileId, filename: item.filename });
    firstMessage = false;
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
  const albumItems = payload.items.filter(isAlbumMedia);
  const otherItems = payload.items.filter((item) => !isAlbumMedia(item));
  let firstMessage = true;

  for (const groupItems of chunks(albumItems, 10)) {
    await sendCachedAlbumChunk(
      ctx,
      groupItems,
      firstMessage ? caption : "",
      firstMessage ? replyToMessageId : undefined,
      firstMessage ? sourceUrl : undefined,
    );
    firstMessage = false;
  }

  for (const item of otherItems) {
    await sendOne(
      ctx,
      item,
      firstMessage ? caption : "",
      firstMessage ? replyToMessageId : undefined,
      firstMessage ? sourceUrl : undefined,
    );
    firstMessage = false;
  }
}
