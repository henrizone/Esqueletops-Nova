import { env } from "../../config/env.js";

/**
 * Cliente do serviço auxiliar "whatsgoapi" (https://github.com/moothz/whatsgoapi),
 * usado SOMENTE para enviar figurinhas com áudio. Ele entra no mesmo número
 * como mais um aparelho conectado; todo o resto continua pela Evolution API.
 *
 * O formato da figurinha com áudio não é documentado pelo WhatsApp (vem de
 * engenharia reversa), por isso fica isolado aqui e é opcional.
 */

export class SoundStickerError extends Error {
  constructor(readonly status: number, path: string, body: string) {
    super(`whatsgoapi ${path} respondeu HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "SoundStickerError";
  }
}

export function soundStickerConfigured(): boolean {
  return Boolean(env.SOUND_STICKER_API_URL && env.SOUND_STICKER_API_KEY);
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; admin?: boolean; timeoutMs?: number } = {},
): Promise<T> {
  const base = env.SOUND_STICKER_API_URL!.replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    headers: {
      "content-type": "application/json",
      apikey: env.SOUND_STICKER_API_KEY!,
      // Com a chave global, a instância é escolhida por este cabeçalho.
      ...(options.admin ? {} : { instance: env.SOUND_STICKER_INSTANCE }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new SoundStickerError(response.status, path, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

/** Cria a instância se ainda não existir. */
async function ensureInstance(): Promise<void> {
  try {
    await call("POST", "/instance/create", { admin: true, body: { name: env.SOUND_STICKER_INSTANCE } });
  } catch (error) {
    if (error instanceof SoundStickerError && /already exists/i.test(error.message)) return;
    throw error;
  }
}

export interface SoundStickerConnection {
  loggedIn: boolean;
  /** Imagem do QR code (data URI) quando ainda falta conectar o número. */
  qrcode?: string;
  /** Nome do perfil conectado. */
  name?: string;
}

interface InstanceStatus extends SoundStickerConnection {
  /** true quando já existe um cliente WhatsApp rodando para a instância. */
  running: boolean;
}

async function status(): Promise<InstanceStatus> {
  const response = await call<{ data?: { Connected?: boolean; LoggedIn?: boolean; Name?: string } }>("GET", "/instance/status");
  return {
    running: Boolean(response?.data?.Connected),
    loggedIn: Boolean(response?.data?.LoggedIn),
    name: response?.data?.Name || undefined,
  };
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * IMPORTANTE: na whatsgoapi, tanto /instance/connect quanto /instance/qr
 * iniciam um cliente quando ainda não há nenhum rodando. Chamar os dois em
 * seguida (ou duas vezes ao mesmo tempo) cria DOIS clientes para a mesma
 * instância: o usuário pareia um deles, o outro continua gerando QR codes,
 * estoura o limite e força um logout que apaga a sessão recém-pareada.
 *
 * Por isso: o cliente é iniciado uma única vez (connect) e o QR só é pedido
 * depois que o status confirma que ele está rodando.
 */
async function resolveConnection(): Promise<SoundStickerConnection> {
  await ensureInstance();
  let current = await status();
  if (current.loggedIn) return current;

  if (!current.running) {
    // Sem webhook: este aparelho não precisa nos avisar de nada, só enviar.
    await call("POST", "/instance/connect", { body: { webhookUrl: "", subscribe: [] } });
    for (let attempt = 0; attempt < 15 && !current.running; attempt += 1) {
      await wait(1000);
      current = await status();
    }
    if (current.loggedIn) return current;
    // Ainda subindo: a página tenta de novo sozinha, sem iniciar outro cliente.
    if (!current.running) return { loggedIn: false };
  }

  try {
    const response = await call<{ data?: { Qrcode?: string } }>("GET", "/instance/qr");
    if (response?.data?.Qrcode) return { loggedIn: false, qrcode: response.data.Qrcode };
  } catch (error) {
    if (error instanceof SoundStickerError && /already logged in/i.test(error.message)) return status();
    // "no QR code available": o código ainda não foi gerado; tenta no próximo refresh.
  }
  return { loggedIn: false };
}

let pendingConnection: Promise<SoundStickerConnection> | undefined;

/**
 * Estado da conexão para a página de pareamento. Pedidos simultâneos (duas
 * abas, ou o refresh automático chegando antes do anterior terminar)
 * compartilham a mesma consulta, para nunca iniciar o cliente em paralelo.
 */
export function soundStickerConnection(): Promise<SoundStickerConnection> {
  pendingConnection ??= resolveConnection().finally(() => {
    pendingConnection = undefined;
  });
  return pendingConnection;
}

export async function sendSoundSticker(input: {
  /** JID do chat (privado, grupo ou @lid), como veio no webhook. */
  number: string;
  /** WebP 512x512 pronto, em base64. A API mantém o arquivo como está. */
  stickerBase64: string;
  /** Áudio em base64; a API converte para Opus no limite do WhatsApp. */
  audioBase64: string;
  name: string;
  author: string;
  quoted?: { messageId: string; participant: string };
}): Promise<void> {
  await call("POST", "/send/sticker/audio", {
    timeoutMs: 120_000,
    body: {
      number: input.number,
      // O JID já vem exato do WhatsApp (via webhook). Com a formatação ligada
      // (padrão), a API "normaliza" números brasileiros removendo o nono
      // dígito e o envio falha com "recipient is not on WhatsApp".
      formatJid: false,
      sticker: input.stickerBase64,
      audio: input.audioBase64,
      pack_name: input.name,
      // Sem autor a API usaria o nome da instância; um espaço mantém "vazio".
      author: input.author || " ",
      emojis: ["✨"],
      ...(input.quoted ? { quoted: input.quoted } : {}),
    },
  });
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Página simples de pareamento: mostra o QR e se atualiza sozinha. */
export function renderConnectionPage(connection: SoundStickerConnection | { error: string }): string {
  let body: string;
  let refresh = 10;
  if ("error" in connection) {
    body = `<h1>Serviço de figurinhas indisponível</h1><p class="error">${escapeHtml(connection.error)}</p>`;
    refresh = 20;
  } else if (connection.loggedIn) {
    body = `<h1>✅ Número conectado</h1><p>${connection.name ? `Conectado como <b>${escapeHtml(connection.name)}</b>. ` : ""}As figurinhas com áudio (<code>/audio</code>) já podem ser enviadas.</p>`;
    refresh = 60;
  } else if (connection.qrcode && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(connection.qrcode)) {
    body = `<h1>Conectar o número</h1>
<p>No WhatsApp do celular: <b>Aparelhos conectados → Conectar um aparelho</b> e aponte para o código.</p>
<img alt="QR code" width="280" height="280" src="${connection.qrcode}">
<p class="hint">O código muda sozinho; esta página se atualiza a cada ${refresh} segundos.</p>`;
  } else {
    body = "<h1>Gerando o QR code…</h1><p class=\"hint\">Aguarde alguns segundos.</p>";
    refresh = 4;
  }
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}"><meta name="robots" content="noindex">
<title>Figurinhas com áudio</title>
<style>
body{font-family:system-ui,sans-serif;background:#111b21;color:#e9edef;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;padding:16px}
main{max-width:420px;text-align:center}
h1{font-size:1.3rem}
img{background:#fff;padding:12px;border-radius:12px;image-rendering:pixelated}
.hint{color:#8696a0;font-size:.9rem}.error{color:#f7a8a8;word-break:break-word}
code{background:#202c33;padding:2px 6px;border-radius:6px}
</style></head><body><main>${body}</main></body></html>`;
}
