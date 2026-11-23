import { readFile, rm } from "node:fs/promises";
import { extname } from "node:path";
import PQueue from "p-queue";
import { claimOnce, consumeCooldown, incrementWindow } from "../../cache/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { buildMediaCaption } from "../media/caption.js";
import { fitVideoToSize, prepareMediaFiles } from "../media/convert.js";
import { materializeRemoteItems } from "../media/direct.js";
import type { PreparedMediaItem } from "../media/types.js";
import { extractUrls, isAllowedMediaUrl, isAutoMediaUrl, isYouTubeShortsUrl, normalizeUrl } from "../media/urls.js";
import { downloadMedia } from "../media/ytdlp.js";
import {
  sendWhatsAppMedia,
  sendWhatsAppText,
  type WhatsAppMediaType,
  type WhatsAppQuoted,
} from "./evolution.js";
import { buildWhatsAppCaption, htmlToWhatsApp } from "./format.js";

/** Mensagem recebida já normalizada a partir do webhook da Evolution. */
export interface IncomingWhatsAppMessage {
  id: string;
  remoteJid: string;
  /** Quem enviou (em grupos é o participante; no privado é o próprio chat). */
  sender: string;
  isGroup: boolean;
  text: string;
  timestamp?: number;
}

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
};

/**
 * A Evolution decide como entregar pelo `mediatype`, mas mimetype genérico ou
 * nome sem a extensão certa fazem o WhatsApp tratar a mídia como arquivo.
 */
function mimeTypeFor(item: PreparedMediaItem): string {
  const known = MIME_TYPES[extname(item.path).toLowerCase()];
  if (known) return known;
  if (item.kind === "photo") return "image/jpeg";
  if (item.kind === "video") return "video/mp4";
  return "application/octet-stream";
}

function fileNameFor(item: PreparedMediaItem, index: number): string {
  if (item.kind === "photo") return `foto-${index + 1}.jpg`;
  if (item.kind === "video") return `video-${index + 1}.mp4`;
  return item.filename;
}

/* ------------------------------------------------------------------------ */
/* Leitura do webhook                                                        */
/* ------------------------------------------------------------------------ */

function messageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  const inner = message.ephemeralMessage?.message
    ?? message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message;
  return String(
    inner.conversation
    ?? inner.extendedTextMessage?.text
    ?? inner.imageMessage?.caption
    ?? inner.videoMessage?.caption
    ?? inner.documentMessage?.caption
    ?? "",
  );
}

/**
 * Extrai as mensagens de um evento `messages.upsert`. Ignora tudo que o bot
 * não deve responder: as próprias mensagens, status, canais e transmissões.
 */
export function parseEvolutionWebhook(body: any): IncomingWhatsAppMessage[] {
  if (!body || typeof body !== "object") return [];
  const event = String(body.event ?? "").toLowerCase().replace(/_/g, ".");
  if (event !== "messages.upsert") return [];
  if (env.EVOLUTION_INSTANCE && body.instance && body.instance !== env.EVOLUTION_INSTANCE) return [];

  const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.data?.messages) ? body.data.messages : [body.data];
  const messages: IncomingWhatsAppMessage[] = [];
  for (const entry of entries) {
    const key = entry?.key;
    const remoteJid = typeof key?.remoteJid === "string" ? key.remoteJid : "";
    if (!key?.id || !remoteJid || key.fromMe) continue;
    if (remoteJid === "status@broadcast" || /@(?:broadcast|newsletter)$/i.test(remoteJid)) continue;
    const text = messageText(entry.message).trim();
    if (!text) continue;
    const isGroup = remoteJid.endsWith("@g.us");
    messages.push({
      id: String(key.id),
      remoteJid,
      sender: String((isGroup ? key.participant ?? entry.participant : undefined) ?? remoteJid),
      isGroup,
      text,
      timestamp: Number(entry.messageTimestamp) || undefined,
    });
  }
  return messages;
}

/* ------------------------------------------------------------------------ */
/* Proteções anti-banimento                                                  */
/* ------------------------------------------------------------------------ */

function chatAllowed(message: IncomingWhatsAppMessage): boolean {
  if (message.isGroup && !env.WHATSAPP_GROUPS) return false;
  if (!env.WHATSAPP_ALLOWED_CHAT_LIST.length) return true;
  const candidates = [message.remoteJid, message.sender].flatMap((jid) => [jid, jid.split("@")[0]!]);
  return candidates.some((candidate) => env.WHATSAPP_ALLOWED_CHAT_LIST.includes(candidate.toLowerCase()));
}

/**
 * Decide se a mensagem pode ser atendida. Todas as recusas são silenciosas:
 * responder "aguarde" a cada link repetido é exatamente o tipo de rajada de
 * mensagens que leva um número a ser denunciado e banido.
 */
async function admit(message: IncomingWhatsAppMessage): Promise<string | undefined> {
  if (!chatAllowed(message)) return "chat não permitido";
  const ageSeconds = message.timestamp ? Date.now() / 1000 - message.timestamp : 0;
  if (ageSeconds > env.WHATSAPP_MAX_MESSAGE_AGE_SECONDS) return "mensagem antiga (fila acumulada)";

  try {
    if (!await claimOnce(`wa:msg:${message.id}`, 3600)) return "mensagem duplicada";
    if (await consumeCooldown(`wa:user:${message.sender}`, env.WHATSAPP_USER_COOLDOWN_SECONDS) > 0) return "cooldown do usuário";
    if (await incrementWindow(`wa:chat-hour:${message.remoteJid}`, 3600) > env.WHATSAPP_CHAT_HOURLY_LIMIT) return "limite por chat";
    if (await incrementWindow("wa:global-hour", 3600) > env.WHATSAPP_GLOBAL_HOURLY_LIMIT) return "limite global";
  } catch (error) {
    // Sem Redis não há como garantir os limites; melhor não responder.
    logger.warn({ error }, "Limites do WhatsApp indisponíveis; mensagem ignorada");
    return "limites indisponíveis";
  }
  return undefined;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function randomBetween(min: number, max: number) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

/** Pausa "humana" que a Evolution exibe como digitando/gravando antes do envio. */
const typingDelay = () => randomBetween(env.WHATSAPP_MIN_DELAY_MS, env.WHATSAPP_MAX_DELAY_MS);

/**
 * Um único envio por vez no número inteiro. Disparar várias mídias em
 * paralelo para chats diferentes é um padrão típico de automação.
 */
const sendQueue = new PQueue({ concurrency: 1 });
const workQueue = new PQueue({ concurrency: Math.max(1, env.DOWNLOAD_CONCURRENCY) });

/* ------------------------------------------------------------------------ */
/* Envio                                                                     */
/* ------------------------------------------------------------------------ */

function quotedFor(message: IncomingWhatsAppMessage): WhatsAppQuoted {
  return {
    key: {
      id: message.id,
      remoteJid: message.remoteJid,
      fromMe: false,
      ...(message.isGroup ? { participant: message.sender } : {}),
    },
    message: { conversation: message.text },
  };
}

export function whatsAppMediaType(item: Pick<PreparedMediaItem, "kind">): WhatsAppMediaType {
  if (item.kind === "photo") return "image";
  if (item.kind === "video") return "video";
  // O sendMedia da Evolution só aceita image/video/document.
  return "document";
}

/**
 * Vídeo sempre chega como vídeo (com player), nunca como arquivo. Quando passa
 * do limite de mídia do WhatsApp ele é comprimido para caber; se nem assim
 * couber (vídeo muito longo), é omitido e entra no aviso da legenda.
 */
async function fitForWhatsApp(item: PreparedMediaItem): Promise<PreparedMediaItem | undefined> {
  if (item.kind !== "video") return item.size <= env.WHATSAPP_MAX_FILE_BYTES ? item : undefined;
  if (item.size <= env.WHATSAPP_MAX_VIDEO_BYTES) return item;
  try {
    const fitted = await fitVideoToSize(item, env.WHATSAPP_MAX_VIDEO_BYTES);
    if (fitted) logger.debug({ from: item.size, to: fitted.size }, "WhatsApp: vídeo comprimido para caber como mídia");
    return fitted;
  } catch (error) {
    logger.warn({ error, path: item.path }, "WhatsApp: não foi possível comprimir o vídeo");
    return undefined;
  }
}

async function sendPrepared(message: IncomingWhatsAppMessage, items: PreparedMediaItem[], caption: string) {
  for (const [index, item] of items.entries()) {
    const media = (await readFile(item.path)).toString("base64");
    await sendQueue.add(async () => {
      await sendWhatsAppMedia({
        number: message.remoteJid,
        mediatype: whatsAppMediaType(item),
        mimetype: mimeTypeFor(item),
        media,
        fileName: fileNameFor(item, index),
        caption: index === 0 && caption ? caption : undefined,
        delay: typingDelay(),
        quoted: index === 0 ? quotedFor(message) : undefined,
      });
      // Intervalo entre mídias da mesma publicação e entre chats diferentes.
      await sleep(randomBetween(env.WHATSAPP_MIN_DELAY_MS, env.WHATSAPP_MAX_DELAY_MS));
    });
  }
}

async function processLink(message: IncomingWhatsAppMessage, rawUrl: string) {
  const url = normalizeUrl(rawUrl);
  const startedAt = Date.now();
  const directories = new Set<string>();
  try {
    const downloaded = await downloadMedia(url, isYouTubeShortsUrl(url) ? "video" : "auto");
    if (downloaded.directory) directories.add(downloaded.directory);
    const metadata = { ...downloaded.metadata, webpageUrl: downloaded.metadata.webpageUrl ?? url };
    if (metadata.duration && metadata.duration > env.MAX_AUTO_DURATION_SECONDS) {
      logger.info({ url, duration: metadata.duration }, "WhatsApp: mídia longa demais; ignorada");
      return;
    }

    const limit = env.WHATSAPP_MAX_MEDIA;
    const remote = downloaded.remoteItems ?? [];
    const total = remote.length || downloaded.files.length;
    let files = downloaded.files.slice(0, limit);
    if (remote.length) {
      const local = await materializeRemoteItems(remote.slice(0, limit), url);
      directories.add(local.directory);
      files = local.files;
    }

    const prepared: PreparedMediaItem[] = [];
    for (const item of await prepareMediaFiles(files)) {
      const fitted = await fitForWhatsApp(item);
      if (fitted) prepared.push(fitted);
    }

    const captionHtml = buildMediaCaption(metadata, url);
    const caption = buildWhatsAppCaption({
      captionHtml,
      sourceUrl: metadata.webpageUrl,
      omittedMedia: Math.max(0, total - prepared.length),
    });

    if (prepared.length) {
      await sendPrepared(message, prepared, caption);
    } else if (metadata.captionHtml && !total) {
      // Publicação só de texto (ex.: tweet sem mídia).
      await sendQueue.add(() => sendWhatsAppText({
        number: message.remoteJid,
        text: caption || htmlToWhatsApp(captionHtml),
        delay: typingDelay(),
        quoted: quotedFor(message),
      }));
    } else {
      logger.info({ url }, "WhatsApp: nenhuma mídia utilizável");
      return;
    }

    logger.info({
      url,
      chat: message.remoteJid,
      durationMs: Date.now() - startedAt,
      mediaCount: prepared.length,
      omitted: Math.max(0, total - prepared.length),
      extractor: metadata.extractor,
    }, "WhatsApp: mídia enviada");
  } catch (error) {
    // Falhas não geram resposta no chat (evita mensagens repetidas de erro).
    logger.error({ error, url, chat: message.remoteJid }, "WhatsApp: falha no download");
  } finally {
    if (env.DELETE_TEMP_FILES) {
      await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)));
    }
  }
}

/** Primeiro link suportado da mensagem; os demais são ignorados de propósito. */
export function firstSupportedUrl(text: string): string | undefined {
  return extractUrls(text).filter(isAllowedMediaUrl).find(isAutoMediaUrl);
}

export async function handleIncomingWhatsApp(message: IncomingWhatsAppMessage): Promise<void> {
  const url = firstSupportedUrl(message.text);
  if (!url) return;
  const refusal = await admit(message);
  if (refusal) {
    logger.debug({ chat: message.remoteJid, reason: refusal }, "WhatsApp: mensagem não atendida");
    return;
  }
  if (workQueue.size >= env.WHATSAPP_MAX_QUEUE) {
    logger.warn({ chat: message.remoteJid }, "WhatsApp: fila cheia; mensagem ignorada");
    return;
  }
  void workQueue.add(() => processLink(message, url));
}

/** Ponto de entrada do webhook: responde na hora e processa em segundo plano. */
export function handleEvolutionWebhook(body: unknown): number {
  const messages = parseEvolutionWebhook(body);
  for (const message of messages) {
    void handleIncomingWhatsApp(message).catch((error) => {
      logger.error({ error }, "WhatsApp: erro ao tratar mensagem");
    });
  }
  return messages.length;
}
