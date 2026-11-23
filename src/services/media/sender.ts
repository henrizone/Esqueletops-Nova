import { InputFile, InputMediaBuilder } from "grammy";
import type { Message } from "grammy/types";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { BotContext } from "../../types/context.js";
import type {
  CachedArticle,
  CachedMediaItem,
  CachedMediaPayload,
  MediaArticlePart,
  PreparedMediaItem,
  RemoteMediaItem,
} from "./types.js";
import { sourceCaptionLink, sourceKeyboard } from "./source-button.js";
import { browserHeaders } from "./direct.js";

/** Limite de itens por álbum (sendMediaGroup) no Telegram. */
const ALBUM_SIZE = 10;
/**
 * Quando o Telegram baixa a mídia a partir de uma URL, o limite é 20 MB para
 * vídeos e 5 MB para fotos. Acima disso o bot precisa transmitir os bytes.
 */
const TELEGRAM_URL_VIDEO_LIMIT = 19 * 1024 * 1024;

type CaptionOptions = { caption: string; parse_mode: "HTML" };

/**
 * Erro de envio remoto que preserva o que já foi entregue. Sem isso, uma falha
 * no segundo álbum de uma publicação com mais de 10 mídias fazia o fallback
 * reenviar tudo desde o início, duplicando o primeiro álbum no chat.
 */
export class PartialSendError extends Error {
  constructor(
    cause: unknown,
    readonly sent: CachedMediaItem[],
    /** Quantos itens da lista original já foram enviados com sucesso. */
    readonly sentCount: number,
  ) {
    super("Envio remoto interrompido", { cause });
    this.name = "PartialSendError";
  }
}

function replyParams(replyToMessageId?: number) {
  return replyToMessageId
    ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
    : {};
}

function fileIdFromMessage(message: Message, kind: CachedMediaItem["kind"]): string | undefined {
  if (kind === "photo" && message.photo?.length) return message.photo.at(-1)?.file_id;
  // GIFs do X chegam como vídeo sem áudio; o Telegram pode devolvê-los como animação.
  if (kind === "video") return message.video?.file_id ?? message.animation?.file_id;
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

function singleOptions(caption: string, replyToMessageId?: number, sourceUrl?: string) {
  return {
    caption: caption || undefined,
    parse_mode: "HTML" as const,
    reply_markup: env.MEDIA_SOURCE_BUTTON && sourceUrl ? sourceKeyboard(sourceUrl) : undefined,
    ...replyParams(replyToMessageId),
  };
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

/**
 * Alguns CDNs são públicos e o próprio Telegram consegue baixar a mídia a
 * partir da URL, sem precisar que o bot faça streaming pelo Node. Isso torna o
 * envio praticamente instantâneo (o arquivo nunca passa pela nossa máquina).
 *
 * Só entram hosts que NÃO exigem referer nem cookies. Se um link falhar, o
 * mesmo arquivo é transmitido pelo bot (`remoteInput`) na tentativa seguinte,
 * então o pior caso é o comportamento antigo, sem perda de qualidade.
 *
 * A lista pode ser estendida via env `TELEGRAM_DIRECT_CDN_HOSTS`.
 */
const DEFAULT_DIRECT_CDN_HOSTS = [
  // Twitter / X -- comprovadamente aceitos pelo Telegram sem referer.
  "twimg.com",
  // Reddit
  "redd.it",
  "redditmedia.com",
  // Proxy do extrator de TikTok (tikwm) -- URLs públicas, sem referer.
  "tikwm.com",
  // ATENÇÃO: NÃO adicionar cdninstagram.com / fbcdn.net aqui. O Telegram
  // RECUSA essas URLs (erro 400 "Wrong file identifier/HTTP URL specified").
  // O Instagram é sempre baixado em bytes pelo bot, como o SmudgeLord faz.
];

function directCdnHosts(): string[] {
  const extra = (env.TELEGRAM_DIRECT_CDN_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_DIRECT_CDN_HOSTS, ...extra];
}

function hostMatchesDirectCdn(host: string): boolean {
  // Somente o host exato ou um subdomínio. Antes havia um `includes`, que
  // casava hosts de terceiros como "twimg.com.exemplo.net".
  return directCdnHosts().some((cdn) => host === cdn || host.endsWith(`.${cdn}`));
}

function telegramCanFetchDirectly(item: RemoteMediaItem, url: string): boolean {
  if (!env.REMOTE_FAST_PATH) return false;
  // Vídeo grande demais para o Telegram buscar sozinho: vai por streaming, na
  // mesma qualidade, em vez de cair para uma variante menor.
  if (item.kind === "video" && url === item.url && (item.sizeBytes ?? 0) > TELEGRAM_URL_VIDEO_LIMIT) return false;
  try {
    return hostMatchesDirectCdn(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

interface SendPlan {
  url: string;
  /** true = o Telegram baixa da URL; false = o bot transmite os bytes. */
  direct: boolean;
}

/**
 * Ordem das tentativas para um item: melhor URL direto -> a MESMA URL por
 * streaming -> variantes menores. A qualidade só cai quando a melhor variante
 * realmente não pôde ser enviada de nenhuma forma.
 */
export function remoteSendPlans(item: RemoteMediaItem): SendPlan[] {
  const plans: SendPlan[] = [];
  for (const url of remoteUrls(item)) {
    if (telegramCanFetchDirectly(item, url)) plans.push({ url, direct: true });
    plans.push({ url, direct: false });
  }
  return plans;
}

function planInput(plan: SendPlan, sourceUrl?: string) {
  return plan.direct ? plan.url : remoteInput(plan.url, sourceUrl);
}

function remoteVideoOptions(item: RemoteMediaItem, plan: SendPlan, sourceUrl?: string) {
  return {
    supports_streaming: true,
    width: item.width,
    height: item.height,
    duration: item.duration ? Math.round(item.duration) : undefined,
    thumbnail: item.thumbnailUrl && !plan.direct ? remoteInput(item.thumbnailUrl, sourceUrl) : undefined,
  };
}

async function sendOneLocalOrCached(
  ctx: BotContext,
  item: PreparedMediaItem | CachedMediaItem,
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<Message> {
  const media = "path" in item ? new InputFile(item.path, item.filename) : item.fileId;
  const common = singleOptions(caption, replyToMessageId, sourceUrl);
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
  for (const plan of remoteSendPlans(item)) {
    try {
      const media = planInput(plan, sourceUrl);
      const common = singleOptions(caption, replyToMessageId, sourceUrl);
      if (item.kind === "photo") return await ctx.replyWithPhoto(media, common);
      return await ctx.replyWithVideo(media, { ...common, ...remoteVideoOptions(item, plan, sourceUrl) });
    } catch (error) {
      lastError = error;
      logger.warn({ error, url: plan.url, direct: plan.direct }, "Falha em uma variante remota; tentando a próxima");
    }
  }
  throw lastError ?? new Error("Nenhuma variante remota pôde ser enviada");
}

function preparedAlbumItem(item: PreparedMediaItem, options?: CaptionOptions) {
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

function cachedAlbumItem(item: CachedMediaItem, options?: CaptionOptions) {
  return item.kind === "photo"
    ? InputMediaBuilder.photo(item.fileId, options)
    : InputMediaBuilder.video(item.fileId, { ...options, supports_streaming: true });
}

function remoteAlbumItem(item: RemoteMediaItem, plan: SendPlan, sourceUrl?: string, options?: CaptionOptions) {
  const media = planInput(plan, sourceUrl);
  return item.kind === "photo"
    ? InputMediaBuilder.photo(media, options)
    : InputMediaBuilder.video(media, { ...options, ...remoteVideoOptions(item, plan, sourceUrl) });
}

function firstItemCaption(index: number, caption: string): CaptionOptions | undefined {
  return index === 0 && caption ? { caption, parse_mode: "HTML" } : undefined;
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
  const group = items.map((item, index) => preparedAlbumItem(item, firstItemCaption(index, finalCaption)));
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
  const group = items.map((item, index) => cachedAlbumItem(item, firstItemCaption(index, finalCaption)));
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

  const plans = items.map(remoteSendPlans);
  const maxAttempts = Math.min(4, Math.max(...plans.map((list) => list.length)));
  const finalCaption = albumCaption(caption, sourceUrl);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const group = items.map((item, index) => {
        const list = plans[index]!;
        const plan = list[Math.min(attempt, list.length - 1)]!;
        return remoteAlbumItem(item, plan, sourceUrl, firstItemCaption(index, finalCaption));
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
      logger.warn({ error, attempt: attempt + 1, url: sourceUrl }, "Falha ao enviar álbum remoto; tentando a próxima forma de envio");
    }
  }
  throw lastError ?? new Error("Não foi possível enviar o álbum remoto");
}

/* ------------------------------------------------------------------------ */
/* Artigo (rich message)                                                     */
/* ------------------------------------------------------------------------ */

/** Máximo de mídias em uma rich message, segundo a Bot API. */
const ARTICLE_MAX_MEDIA = 50;

interface RenderedArticle {
  html: string;
  media: Array<{ id: string; item: RemoteMediaItem }>;
}

/**
 * Converte os trechos do artigo no HTML da rich message. Cada mídia vira uma
 * tag apontando para `tg://photo?id=N` / `tg://video?id=N`; duas ou mais
 * fotos seguidas são agrupadas em uma colagem, como no SmudgeLord.
 */
export function renderArticle(parts: MediaArticlePart[]): RenderedArticle {
  const media: RenderedArticle["media"] = [];
  let html = "";
  for (const part of parts) {
    if ("html" in part) {
      html += part.html;
      continue;
    }
    let photoRun: string[] = [];
    const flushPhotos = () => {
      if (photoRun.length > 1) html += `<tg-collage>\n${photoRun.join("\n")}\n</tg-collage>\n`;
      else if (photoRun.length === 1) html += `${photoRun[0]}\n`;
      photoRun = [];
    };
    for (const item of part.media) {
      const id = String(media.length + 1);
      media.push({ id, item });
      if (item.kind === "photo") {
        photoRun.push(`<img src="tg://photo?id=${id}"></img>`);
      } else {
        flushPhotos();
        html += `<video src="tg://video?id=${id}"></video>\n`;
      }
    }
    flushPhotos();
  }
  return { html, media };
}

/** Coleta, na ordem do documento, os file_id das mídias de uma rich message enviada. */
function articleFileIds(blocks: unknown): string[] {
  const ids: string[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const block of list as Array<Record<string, any>>) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "photo" && Array.isArray(block.photo) && block.photo.length) {
        ids.push(block.photo.at(-1).file_id);
      } else if (block.type === "video" && block.video?.file_id) {
        ids.push(block.video.file_id);
      } else if (block.type === "animation" && block.animation?.file_id) {
        ids.push(block.animation.file_id);
      } else if (Array.isArray(block.blocks)) {
        walk(block.blocks);
      }
    }
  };
  walk(blocks);
  return ids;
}

function articleOptions(replyToMessageId?: number, sourceUrl?: string) {
  return {
    // Diferente dos álbuns, a rich message aceita teclado inline: o botão
    // "Abrir no ..." acompanha a mensagem mesmo com várias mídias.
    reply_markup: env.MEDIA_SOURCE_BUTTON && sourceUrl ? sourceKeyboard(sourceUrl) : undefined,
    ...replyParams(replyToMessageId),
  };
}

/**
 * Envia a publicação como uma única rich message. Devolve o artigo pronto
 * para cache (com os file_id) ou `undefined` se o Telegram não informou todos.
 * Lança erro quando nenhuma forma de envio funcionou — o chamador então usa
 * o álbum tradicional.
 */
export async function sendRemoteArticle(
  ctx: BotContext,
  parts: MediaArticlePart[],
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<CachedArticle | undefined> {
  const { html, media } = renderArticle(parts);
  if (media.length > ARTICLE_MAX_MEDIA) throw new Error(`Mídias demais para uma rich message: ${media.length}`);

  const plans = media.map(({ item }) => remoteSendPlans(item));
  const maxAttempts = Math.max(1, Math.min(4, ...(plans.length ? [Math.max(...plans.map((list) => list.length))] : [1])));
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const inputMedia = media.map(({ id, item }, index) => {
        const list = plans[index]!;
        const plan = list[Math.min(attempt, list.length - 1)]!;
        return { id, media: remoteAlbumItem(item, plan, sourceUrl) };
      });
      const message = await ctx.replyWithRichMessage(
        { html, media: inputMedia } as never,
        articleOptions(replyToMessageId, sourceUrl),
      );
      const fileIds = articleFileIds((message as { rich_message?: { blocks?: unknown } }).rich_message?.blocks);
      if (fileIds.length !== media.length) return undefined;
      return {
        html,
        media: media.map(({ id, item }, index) => ({ id, kind: item.kind, fileId: fileIds[index]! })),
      };
    } catch (error) {
      lastError = error;
      logger.warn({ error, attempt: attempt + 1, url: sourceUrl }, "Falha ao enviar artigo; tentando a próxima forma de envio");
    }
  }
  throw lastError ?? new Error("Não foi possível enviar o artigo");
}

export async function sendCachedArticle(
  ctx: BotContext,
  article: CachedArticle,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<void> {
  const inputMedia = article.media.map((entry) => ({
    id: entry.id,
    media: entry.kind === "photo"
      ? InputMediaBuilder.photo(entry.fileId)
      : InputMediaBuilder.video(entry.fileId, { supports_streaming: true }),
  }));
  await ctx.replyWithRichMessage(
    { html: article.html, media: inputMedia } as never,
    articleOptions(replyToMessageId, sourceUrl),
  );
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

/**
 * Envia mídias remotas em álbuns de até 10 itens (uma publicação com 20
 * mídias vira dois álbuns). A legenda vai apenas no primeiro álbum; todos
 * respondem à mensagem original.
 */
export async function sendRemoteMedia(
  ctx: BotContext,
  items: RemoteMediaItem[],
  caption: string,
  replyToMessageId?: number,
  sourceUrl?: string,
): Promise<CachedMediaItem[]> {
  const cached: CachedMediaItem[] = [];
  let sentCount = 0;
  for (const groupItems of chunks(items.filter(isAlbumMedia), ALBUM_SIZE)) {
    const first = sentCount === 0;
    try {
      cached.push(...await sendRemoteAlbumChunk(
        ctx,
        groupItems,
        first ? caption : "",
        replyToMessageId,
        first ? sourceUrl : undefined,
      ));
    } catch (error) {
      throw new PartialSendError(error, cached, sentCount);
    }
    sentCount += groupItems.length;
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

  for (const groupItems of chunks(albumItems, ALBUM_SIZE)) {
    cached.push(...await sendPreparedAlbumChunk(
      ctx,
      groupItems,
      firstMessage ? caption : "",
      replyToMessageId,
      firstMessage ? sourceUrl : undefined,
    ));
    firstMessage = false;
  }

  for (const item of otherItems) {
    const message = await sendOneLocalOrCached(
      ctx,
      item,
      firstMessage ? caption : "",
      replyToMessageId,
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

  for (const groupItems of chunks(albumItems, ALBUM_SIZE)) {
    await sendCachedAlbumChunk(
      ctx,
      groupItems,
      firstMessage ? caption : "",
      replyToMessageId,
      firstMessage ? sourceUrl : undefined,
    );
    firstMessage = false;
  }

  for (const item of otherItems) {
    await sendOneLocalOrCached(
      ctx,
      item,
      firstMessage ? caption : "",
      replyToMessageId,
      firstMessage ? sourceUrl : undefined,
    );
    firstMessage = false;
  }
}
