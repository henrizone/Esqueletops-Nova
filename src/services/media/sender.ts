import { InputFile, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { BotContext } from "../../types/context.js";
import type {
  CachedMediaItem,
  CachedMediaPayload,
  PreparedMediaItem,
  RemoteMediaItem,
} from "./types.js";
import { sourceCaptionLink, sourceKeyboard } from "./source-button.js";
import { browserHeaders } from "./direct.js";

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
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function isAlbumMedia(item: PreparedMediaItem | CachedMediaItem | RemoteMediaItem) {
  return item.kind === "photo" || item.kind === "video";
}

function albumCaption(caption: string, sourceUrl?: string) {
  if (!env.MEDIA_SOURCE_BUTTON || !sourceUrl) return caption;
  const link = sourceCaptionLink(sourceUrl);
  if (!link) return caption;
  return [caption, link].filter(Boolean).join("\n\n");
}

function remoteInput(url: string, sourceUrl?: string) {
  // Streaming com timeout, headers de navegador e limite de tamanho. Nada é
  // gravado em disco no caminho normal.
  return new InputFile(() => (async function* () {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 90_000)),
      headers: {
        ...browserHeaders,
        accept: "*/*",
        ...(sourceUrl ? { referer: sourceUrl } : {}),
      },
    });
    if (!response.ok || !response.body) throw new Error(`Falha ao transmitir mídia: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > env.MAX_UPLOAD_BYTES) throw new Error("Mídia remota excede o limite do Telegram");
    let received = 0;
    for await (const chunk of response.body as any) {
      const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      received += data.byteLength;
      if (received > env.MAX_UPLOAD_BYTES) throw new Error("Mídia remota excede o limite do Telegram");
      yield data;
    }
  })());
}

function remoteUrls(item: RemoteMediaItem) {
  return [item.url, ...(item.fallbackUrls ?? [])].filter((url, index, all) => all.indexOf(url) === index);
}

async function sendOneLocalOrCached(
  ctx: BotContext,
  item: PreparedMediaItem | CachedMediaItem,
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<Message> {
  const media = "path" in item ? new InputFile(item.path, item.filename) : item.fileId;
  const common = {
    caption: caption || undefined,
    parse_mode: "HTML" as const,
    reply_markup: env.MEDIA_SOURCE_BUTTON && sourceUrl ? sourceKeyboard(sourceUrl) : undefined,
    ...replyParams(replyToMessageId),
  };
  switch (item.kind) {
    case "photo": return ctx.replyWithPhoto(media, common);
    case "video": {
      const prepared = "path" in item ? item : undefined;
      return ctx.replyWithVideo(media, {
        ...common,
        supports_streaming: true,
        width: prepared?.width,
        height: prepared?.height,
        duration: prepared?.duration ? Math.round(prepared.duration) : undefined,
      });
    }
    case "audio": return ctx.replyWithAudio(media, { ...common, title: item.filename });
    default: return ctx.replyWithDocument(media, common);
  }
}

async function sendOneRemote(
  ctx: BotContext,
  item: RemoteMediaItem,
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<Message> {
  let lastError: unknown;
  for (const url of remoteUrls(item)) {
    try {
      const media = remoteInput(url, sourceUrl);
      const common = {
        caption: caption || undefined,
        parse_mode: "HTML" as const,
        reply_markup: env.MEDIA_SOURCE_BUTTON && sourceUrl ? sourceKeyboard(sourceUrl) : undefined,
        ...replyParams(replyToMessageId),
      };
      if (item.kind === "photo") return await ctx.replyWithPhoto(media, common);
      return await ctx.replyWithVideo(media, {
        ...common,
        supports_streaming: true,
        width: item.width,
        height: item.height,
        duration: item.duration ? Math.round(item.duration) : undefined,
        thumbnail: item.thumbnailUrl ? remoteInput(item.thumbnailUrl, sourceUrl) : undefined,
      });
    } catch (error) {
      lastError = error;
      logger.warn({ error, url }, "Falha em uma variante remota; tentando a próxima");
    }
  }
  throw lastError ?? new Error("Nenhuma variante remota pôde ser enviada");
}

function preparedAlbumItem(item: PreparedMediaItem, options?: { caption: string; parse_mode: "HTML" }) {
  const media = new InputFile(item.path, item.filename);
  return item.kind === "photo"
    ? InputMediaBuilder.photo(media, options)
    : InputMediaBuilder.video(media, {
      ...options,
      supports_streaming: true,
      width: item.width,
      height: item.height,
      duration: item.duration ? Math.round(item.duration) : undefined,
    });
}

function cachedAlbumItem(item: CachedMediaItem, options?: { caption: string; parse_mode: "HTML" }) {
  return item.kind === "photo"
    ? InputMediaBuilder.photo(item.fileId, options)
    : InputMediaBuilder.video(item.fileId, { ...options, supports_streaming: true });
}

function remoteAlbumItem(item: RemoteMediaItem, url: string, sourceUrl?: string, options?: { caption: string; parse_mode: "HTML" }) {
  const media = remoteInput(url, sourceUrl);
  return item.kind === "photo"
    ? InputMediaBuilder.photo(media, options)
    : InputMediaBuilder.video(media, {
      ...options,
      supports_streaming: true,
      width: item.width,
      height: item.height,
      duration: item.duration ? Math.round(item.duration) : undefined,
      thumbnail: item.thumbnailUrl ? remoteInput(item.thumbnailUrl, sourceUrl) : undefined,
    });
}

async function sendPreparedAlbumChunk(
  ctx: BotContext,
  items: PreparedMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<CachedMediaItem[]> {
  if (items.length === 1) {
    const message = await sendOneLocalOrCached(ctx, items[0]!, caption, replyToMessageId, sourceUrl);
    const fileId = fileIdFromMessage(message, items[0]!.kind);
    return fileId ? [{ kind: items[0]!.kind, fileId, filename: items[0]!.filename }] : [];
  }
  const finalCaption = albumCaption(caption, sourceUrl);
  const group = items.map((item, index) => preparedAlbumItem(
    item,
    index === 0 && finalCaption ? { caption: finalCaption, parse_mode: "HTML" } : undefined,
  ));
  const messages = await ctx.replyWithMediaGroup(group, replyParams(replyToMessageId));
  return messages.flatMap((message, index) => {
    const item = items[index];
    if (!item) return [];
    const fileId = fileIdFromMessage(message, item.kind);
    return fileId ? [{ kind: item.kind, fileId, filename: item.filename } satisfies CachedMediaItem] : [];
  });
}

async function sendCachedAlbumChunk(
  ctx: BotContext,
  items: CachedMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<void> {
  if (items.length === 1) {
    await sendOneLocalOrCached(ctx, items[0]!, caption, replyToMessageId, sourceUrl);
    return;
  }
  const finalCaption = albumCaption(caption, sourceUrl);
  const group = items.map((item, index) => cachedAlbumItem(
    item,
    index === 0 && finalCaption ? { caption: finalCaption, parse_mode: "HTML" } : undefined,
  ));
  await ctx.replyWithMediaGroup(group, replyParams(replyToMessageId));
}

async function sendRemoteAlbumChunk(
  ctx: BotContext,
  items: RemoteMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<CachedMediaItem[]> {
  if (items.length === 1) {
    const message = await sendOneRemote(ctx, items[0]!, caption, replyToMessageId, sourceUrl);
    const fileId = fileIdFromMessage(message, items[0]!.kind);
    return fileId ? [{ kind: items[0]!.kind, fileId }] : [];
  }

  const maxAttempts = Math.min(4, Math.max(...items.map((item) => remoteUrls(item).length)));
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const finalCaption = albumCaption(caption, sourceUrl);
      const group = items.map((item, index) => {
        const urls = remoteUrls(item);
        const url = urls[Math.min(attempt, urls.length - 1)]!;
        return remoteAlbumItem(item, url, sourceUrl, index === 0 && finalCaption
          ? { caption: finalCaption, parse_mode: "HTML" }
          : undefined);
      });
      const messages = await ctx.replyWithMediaGroup(group, replyParams(replyToMessageId));
      return messages.flatMap((message, index) => {
        const item = items[index];
        if (!item) return [];
        const fileId = fileIdFromMessage(message, item.kind);
        return fileId ? [{ kind: item.kind, fileId } satisfies CachedMediaItem] : [];
      });
    } catch (error) {
      lastError = error;
      logger.warn({ error, attempt: attempt + 1 }, "Falha ao enviar álbum remoto; tentando variantes menores");
    }
  }
  throw lastError ?? new Error("Não foi possível enviar o álbum remoto");
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

export async function sendRemoteMedia(
  ctx: BotContext,
  items: RemoteMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<CachedMediaItem[]> {
  const cached: CachedMediaItem[] = [];
  for (const groupItems of chunks(items.filter(isAlbumMedia), 10)) {
    cached.push(...await sendRemoteAlbumChunk(ctx, groupItems, caption, replyToMessageId, sourceUrl));
    caption = "";
    replyToMessageId = undefined;
    sourceUrl = undefined;
  }
  return cached;
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

  for (const groupItems of chunks(albumItems, 10)) {
    cached.push(...await sendPreparedAlbumChunk(
      ctx,
      groupItems,
      firstMessage ? caption : "",
      firstMessage ? replyToMessageId : undefined,
      firstMessage ? sourceUrl : undefined,
    ));
    firstMessage = false;
  }

  for (const item of otherItems) {
    const message = await sendOneLocalOrCached(
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
    await sendOneLocalOrCached(
      ctx,
      item,
      firstMessage ? caption : "",
      firstMessage ? replyToMessageId : undefined,
      firstMessage ? sourceUrl : undefined,
    );
    firstMessage = false;
  }
}
