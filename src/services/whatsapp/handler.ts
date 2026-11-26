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
  fetchWhatsAppMedia,
  isUnsupportedRoute,
  sendWhatsAppMedia,
  sendWhatsAppSoundSticker,
  sendWhatsAppSticker,
  sendWhatsAppText,
  type WhatsAppMediaType,
  type WhatsAppQuoted,
  type WhatsAppRawMessage,
} from "./evolution.js";
import { buildWhatsAppCaption, htmlToWhatsApp } from "./format.js";
import { sendSoundSticker, soundStickerConfigured } from "./soundSticker.js";
import { buildWhatsAppSticker, extractStickerAudio, parseFigCommand, stickerName, type FigCommand } from "./sticker.js";

/** Mensagem recebida já normalizada a partir do webhook da Evolution. */
export interface IncomingWhatsAppMessage {
  id: string;
  remoteJid: string;
  /** Quem enviou (em grupos é o participante; no privado é o próprio chat). */
  sender: string;
  isGroup: boolean;
  text: string;
  timestamp?: number;
  /** Nome de perfil de quem enviou. */
  senderName?: string;
  /** Imagem/vídeo/figurinha que pode virar figurinha: da própria mensagem ou da mensagem respondida. */
  stickerSource?: WhatsAppStickerSource;
}

export interface WhatsAppStickerSource {
  kind: "image" | "video" | "sticker";
  raw: WhatsAppRawMessage;
  /** Duração (s) e tamanho (bytes) declarados pelo WhatsApp, quando houver. */
  seconds?: number;
  bytes?: number;
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

function unwrapMessage(message: any): any {
  if (!message || typeof message !== "object") return undefined;
  return message.ephemeralMessage?.message
    ?? message.viewOnceMessage?.message
    ?? message.viewOnceMessageV2?.message
    ?? message;
}

function mediaSource(message: any, key: Record<string, unknown>): WhatsAppStickerSource | undefined {
  const inner = unwrapMessage(message);
  if (!inner) return undefined;
  const kinds = [["imageMessage", "image"], ["videoMessage", "video"], ["stickerMessage", "sticker"]] as const;
  for (const [field, kind] of kinds) {
    const media = inner[field];
    if (!media) continue;
    return {
      kind,
      raw: { key, message: { [field]: media } },
      seconds: Number(media.seconds) || undefined,
      bytes: Number(media.fileLength?.low ?? media.fileLength) || undefined,
    };
  }
  return undefined;
}

/** Mídia da mensagem respondida (quando o usuário responde uma foto com /fig). */
function quotedMediaSource(entry: any, remoteJid: string): WhatsAppStickerSource | undefined {
  const inner = unwrapMessage(entry?.message) ?? {};
  const context = entry?.contextInfo
    ?? inner.extendedTextMessage?.contextInfo
    ?? inner.imageMessage?.contextInfo
    ?? inner.videoMessage?.contextInfo;
  if (!context?.quotedMessage || !context.stanzaId) return undefined;
  return mediaSource(context.quotedMessage, {
    id: String(context.stanzaId),
    remoteJid,
    fromMe: false,
    ...(context.participant ? { participant: String(context.participant) } : {}),
  });
}

function messageText(message: any): string {
  const inner = unwrapMessage(message);
  if (!inner) return "";
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
    // A Evolution acrescenta campos próprios à chave; para citar e baixar a
    // mídia interessa só o que o WhatsApp entende.
    const cleanKey: Record<string, unknown> = { id: String(key.id), remoteJid, fromMe: false };
    if (key.participant) cleanKey.participant = String(key.participant);
    const isGroup = remoteJid.endsWith("@g.us");
    messages.push({
      id: String(key.id),
      remoteJid,
      sender: String((isGroup ? key.participant ?? entry.participant : undefined) ?? remoteJid),
      isGroup,
      text,
      timestamp: Number(entry.messageTimestamp) || undefined,
      senderName: typeof entry.pushName === "string" && entry.pushName.trim() ? entry.pushName.trim() : undefined,
      stickerSource: mediaSource(entry.message, cleanKey) ?? quotedMediaSource(entry, remoteJid),
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

/* ------------------------------------------------------------------------ */
/* /fig — figurinha avulsa (exclusivo do WhatsApp)                           */
/* ------------------------------------------------------------------------ */

const FIG_USAGE = "Envie uma foto, GIF ou vídeo curto com a legenda */fig* (ou responda a mídia com */fig*).\nPara dar nome: */fig nome da figurinha*\nCom som (a partir de um vídeo): */audio*";
const AUDIO_NEEDS_VIDEO = "Para figurinha com áudio, use */audio* em um vídeo com som.";
const AUDIO_FAILED = "_Não consegui enviar o áudio agora; enviei a figurinha sem som._";
const AUDIO_UNSUPPORTED = "_Figurinha com áudio ainda não está disponível neste bot; enviei sem som._";

/** Depois do primeiro 404 não adianta insistir a cada pedido: tenta de novo só mais tarde. */
let soundStickerUnsupportedUntil = 0;

async function replyText(message: IncomingWhatsAppMessage, text: string) {
  await sendQueue.add(() => sendWhatsAppText({
    number: message.remoteJid,
    text,
    delay: typingDelay(),
    quoted: quotedFor(message),
  })).catch((error) => logger.warn({ error }, "WhatsApp: falha ao enviar aviso"));
}

async function processSticker(message: IncomingWhatsAppMessage, command: FigCommand, source: WhatsAppStickerSource) {
  const startedAt = Date.now();
  try {
    if ((source.bytes ?? 0) > env.WHATSAPP_STICKER_MAX_INPUT_BYTES) {
      await replyText(message, "Essa mídia é grande demais para virar figurinha.");
      return;
    }
    const media = await fetchWhatsAppMedia(source.raw);
    if (media.buffer.length > env.WHATSAPP_STICKER_MAX_INPUT_BYTES) {
      await replyText(message, "Essa mídia é grande demais para virar figurinha.");
      return;
    }
    const mimetype = source.kind === "video" ? "video/mp4" : media.mimetype;
    const name = stickerName(command.name, message.senderName);
    const sticker = await buildWhatsAppSticker(media.buffer, mimetype, {
      name,
      author: env.WHATSAPP_STICKER_AUTHOR,
    });

    let notice: string | undefined;
    let audio: Buffer | undefined;
    if (command.audio) {
      if (source.kind !== "video") notice = AUDIO_NEEDS_VIDEO;
      else if (!soundStickerConfigured() && Date.now() < soundStickerUnsupportedUntil) notice = AUDIO_UNSUPPORTED;
      else {
        audio = await extractStickerAudio(media.buffer).catch((error) => {
          logger.warn({ error }, "WhatsApp: não foi possível extrair o áudio do vídeo");
          return undefined;
        });
        if (!audio) notice = "_Esse vídeo não tem som; enviei a figurinha sem áudio._";
      }
    }

    const base = {
      number: message.remoteJid,
      sticker: sticker.webp.toString("base64"),
      quoted: quotedFor(message),
    };
    let withSound = false;
    await sendQueue.add(async () => {
      if (audio && soundStickerConfigured()) {
        // Serviço auxiliar (whatsgoapi): outro aparelho conectado no mesmo
        // número, usado só para este envio.
        try {
          await sleep(typingDelay());
          await sendSoundSticker({
            number: message.remoteJid,
            stickerBase64: base.sticker,
            audioBase64: audio.toString("base64"),
            name,
            author: env.WHATSAPP_STICKER_AUTHOR,
            quoted: { messageId: message.id, participant: message.sender },
          });
          withSound = true;
        } catch (error) {
          logger.warn({ error }, "WhatsApp: serviço de figurinha com áudio falhou; enviando sem som");
          notice = AUDIO_FAILED;
        }
      } else if (audio) {
        try {
          await sendWhatsAppSoundSticker({ ...base, audio: audio.toString("base64"), delay: typingDelay() });
          withSound = true;
        } catch (error) {
          if (isUnsupportedRoute(error)) soundStickerUnsupportedUntil = Date.now() + 6 * 60 * 60 * 1000;
          logger.warn({ error }, "WhatsApp: figurinha com áudio recusada pela Evolution; enviando sem som");
          notice = AUDIO_UNSUPPORTED;
        }
      }
      if (!withSound) await sendWhatsAppSticker({ ...base, delay: typingDelay() });
      await sleep(randomBetween(env.WHATSAPP_MIN_DELAY_MS, env.WHATSAPP_MAX_DELAY_MS));
    });
    if (notice) await replyText(message, notice);
    logger.info({
      chat: message.remoteJid,
      durationMs: Date.now() - startedAt,
      animated: sticker.animated,
      withSound,
      bytes: sticker.webp.length,
    }, "WhatsApp: figurinha enviada");
  } catch (error) {
    logger.error({ error, chat: message.remoteJid }, "WhatsApp: falha ao criar figurinha");
    // Um único aviso, e só para quem digitou o comando com barra.
    if (command.explicit) await replyText(message, "Não consegui criar a figurinha com essa mídia.");
  }
}

/**
 * Trata /fig. Devolve true quando a mensagem era o comando (mesmo que tenha
 * sido recusada pelos limites), para não cair no fluxo de links.
 */
async function handleFigCommand(message: IncomingWhatsAppMessage): Promise<boolean> {
  if (!env.WHATSAPP_STICKERS) return false;
  const command = parseFigCommand(message.text);
  if (!command) return false;
  const source = message.stickerSource;
  // "fig" sem barra e sem mídia é só conversa: ignora em silêncio.
  if (!source && !command.explicit) return false;

  const refusal = await admit(message);
  if (refusal) {
    logger.debug({ chat: message.remoteJid, reason: refusal }, "WhatsApp: /fig não atendido");
    return true;
  }
  if (!source) {
    await replyText(message, FIG_USAGE);
    return true;
  }
  if (workQueue.size >= env.WHATSAPP_MAX_QUEUE) {
    logger.warn({ chat: message.remoteJid }, "WhatsApp: fila cheia; /fig ignorado");
    return true;
  }
  void workQueue.add(() => processSticker(message, command, source));
  return true;
}

/** Primeiro link suportado da mensagem; os demais são ignorados de propósito. */
export function firstSupportedUrl(text: string): string | undefined {
  return extractUrls(text).filter(isAllowedMediaUrl).find(isAutoMediaUrl);
}

export async function handleIncomingWhatsApp(message: IncomingWhatsAppMessage): Promise<void> {
  if (await handleFigCommand(message)) return;
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
