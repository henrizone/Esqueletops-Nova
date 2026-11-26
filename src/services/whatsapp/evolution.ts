import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/** Referência à mensagem recebida, usada para responder citando-a. */
export interface WhatsAppQuoted {
  key: { id: string; remoteJid: string; fromMe: boolean; participant?: string };
  message: { conversation: string };
}

export type WhatsAppMediaType = "image" | "video" | "document" | "audio";

export interface WhatsAppMediaPayload {
  number: string;
  mediatype: WhatsAppMediaType;
  mimetype: string;
  /** Base64 puro (sem prefixo data:) ou URL pública. */
  media: string;
  fileName: string;
  caption?: string;
  /** Tempo (ms) em que a Evolution mostra "digitando/gravando" antes de enviar. */
  delay?: number;
  quoted?: WhatsAppQuoted;
}

export function whatsAppEnabled(): boolean {
  return Boolean(env.WHATSAPP_ENABLED && env.EVOLUTION_API_URL && env.EVOLUTION_API_KEY && env.EVOLUTION_INSTANCE);
}

/**
 * Segredo do webhook. Se WHATSAPP_WEBHOOK_SECRET não for definido, é derivado
 * da chave da Evolution: assim a rota nunca fica aberta, mesmo sem configurar
 * nada a mais.
 */
export function webhookSecret(): string {
  return env.WHATSAPP_WEBHOOK_SECRET
    ?? createHash("sha256").update(`esqueletops-whatsapp:${env.EVOLUTION_API_KEY ?? ""}`).digest("hex").slice(0, 40);
}

export const WHATSAPP_WEBHOOK_PATH = "/whatsapp/webhook";

function endpoint(path: string): string {
  const base = env.EVOLUTION_API_URL!.replace(/\/+$/, "");
  return `${base}/${path}/${encodeURIComponent(env.EVOLUTION_INSTANCE!)}`;
}

export class EvolutionError extends Error {
  constructor(readonly status: number, path: string, body: string) {
    super(`Evolution API ${path} respondeu HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "EvolutionError";
  }
}

async function request<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const response = await fetch(endpoint(path), {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      apikey: env.EVOLUTION_API_KEY!,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new EvolutionError(response.status, path, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export async function sendWhatsAppText(input: {
  number: string;
  text: string;
  delay?: number;
  quoted?: WhatsAppQuoted;
}): Promise<void> {
  await request("message/sendText", { ...input, linkPreview: false }, 30_000);
}

export async function sendWhatsAppMedia(payload: WhatsAppMediaPayload): Promise<void> {
  await request("message/sendMedia", payload, Math.max(60_000, env.DOWNLOAD_TIMEOUT_SECONDS * 1000));
}

/** Mensagem crua do WhatsApp (chave + conteúdo), como chega no webhook. */
export interface WhatsAppRawMessage {
  key: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/**
 * Baixa e descriptografa a mídia de uma mensagem. Enviar o conteúdo completo
 * dispensa a Evolution de ter a mensagem salva no banco; se isso falhar, tenta
 * de novo só com a chave (busca no histórico da instância).
 */
export async function fetchWhatsAppMedia(raw: WhatsAppRawMessage): Promise<{ buffer: Buffer; mimetype: string }> {
  type MediaResponse = { base64?: string; mimetype?: string };
  let response: MediaResponse | undefined;
  try {
    response = await request<MediaResponse>("chat/getBase64FromMediaMessage", { message: raw, convertToMp4: false }, 90_000);
  } catch (error) {
    if (!raw.message) throw error;
    response = await request<MediaResponse>("chat/getBase64FromMediaMessage", { message: { key: raw.key }, convertToMp4: false }, 90_000);
  }
  if (!response?.base64) throw new Error("Evolution API não devolveu a mídia da mensagem");
  return { buffer: Buffer.from(response.base64, "base64"), mimetype: response.mimetype ?? "application/octet-stream" };
}

export async function sendWhatsAppSticker(input: {
  number: string;
  /** WebP já pronto, em base64. */
  sticker: string;
  delay?: number;
  quoted?: WhatsAppQuoted;
}): Promise<void> {
  // notConvertSticker: a Evolution envia o WebP como está. Sem isso ela
  // recodifica a imagem e apaga o nome gravado na figurinha.
  await request("message/sendSticker", { ...input, notConvertSticker: true }, 90_000);
}

/**
 * Figurinha com áudio. O formato foi observado nos apps (não é documentado
 * pelo WhatsApp) e a Evolution oficial ainda não tem essa rota: ela existe só
 * em builds com o patch de "sound sticker". Em um servidor sem a rota a
 * chamada devolve 404 e o chamador envia a figurinha comum.
 */
export async function sendWhatsAppSoundSticker(input: {
  number: string;
  /** WebP pronto, em base64. */
  sticker: string;
  /** Ogg/Opus pronto, em base64. */
  audio: string;
  delay?: number;
  quoted?: WhatsAppQuoted;
}): Promise<void> {
  await request("message/sendSoundSticker", {
    ...input,
    ptt: false,
    encoding: false,
    notConvertSticker: true,
  }, 90_000);
}

/** true quando o servidor Evolution não conhece a rota (versão sem o recurso). */
export function isUnsupportedRoute(error: unknown): boolean {
  return error instanceof EvolutionError && (error.status === 404 || error.status === 405);
}

/**
 * Aponta o webhook da instância para este servidor, pedindo apenas o evento
 * de mensagens recebidas. Tenta o formato da Evolution v2 e, se a API recusar,
 * o formato da v1.
 */
export async function registerWhatsAppWebhook(): Promise<string | undefined> {
  if (!whatsAppEnabled()) return undefined;
  const publicBase = (env.SERVER_URL ?? env.WEBHOOK_URL)?.replace(/\/+$/, "");
  if (!publicBase || !/^https?:\/\/[^$()\s]+$/i.test(publicBase)) {
    logger.warn({ serverUrl: env.SERVER_URL }, "SERVER_URL ausente ou inválida; configure o webhook da Evolution manualmente");
    return undefined;
  }
  const url = `${publicBase}${WHATSAPP_WEBHOOK_PATH}?token=${webhookSecret()}`;
  const events = ["MESSAGES_UPSERT"];
  try {
    await request("webhook/set", {
      webhook: { enabled: true, url, byEvents: false, base64: false, events },
    }, 20_000);
  } catch (error) {
    logger.debug({ error }, "Formato v2 do webhook recusado; tentando formato v1");
    await request("webhook/set", {
      enabled: true,
      url,
      webhook_by_events: false,
      webhook_base64: false,
      events,
    }, 20_000);
  }
  return `${publicBase}${WHATSAPP_WEBHOOK_PATH}`;
}
