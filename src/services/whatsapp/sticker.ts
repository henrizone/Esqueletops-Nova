import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import sharp from "sharp";
import { env } from "../../config/env.js";

/** Limites do WhatsApp para figurinhas: 512x512, 100 KB (estática) e 500 KB (animada). */
export const STICKER_SIZE = 512;
export const STATIC_STICKER_MAX_BYTES = 100 * 1024;
export const ANIMATED_STICKER_MAX_BYTES = 500 * 1024;
const NAME_LIMIT = 60;
/** Folga para os metadados (nome/autor) gravados depois da compressão. */
const METADATA_MARGIN = 1024;

export interface StickerInfo {
  /** Nome exibido ao tocar na figurinha (o "pacote"). */
  name: string;
  author: string;
}

export interface BuiltSticker {
  webp: Buffer;
  animated: boolean;
}

/* ------------------------------------------------------------------------ */
/* Comando                                                                   */
/* ------------------------------------------------------------------------ */

export interface FigCommand {
  /** Nome pedido pelo usuário; vazio quando ele mandou só "/fig". */
  name: string;
  /** true quando veio com prefixo (/fig, !fig, .fig). "fig" sozinho é implícito. */
  explicit: boolean;
}

/**
 * Reconhece "/fig", "/fig nome da figurinha" e também "fig" sem barra. Sem a
 * barra a mensagem só vira comando se for exatamente "fig" ou "fig <nome>" —
 * e, mais adiante, só se houver uma imagem/vídeo para converter.
 */
export function parseFigCommand(text: string): FigCommand | undefined {
  const match = text.trim().match(/^([/!.])?(?:fig|figurinha|sticker|s)(?:\s+([\s\S]+))?$/i);
  if (!match) return undefined;
  const explicit = Boolean(match[1]);
  // Sem prefixo só aceitamos a palavra "fig", para não capturar conversa comum.
  if (!explicit && !/^fig(?:\s|$)/i.test(text.trim())) return undefined;
  return { name: (match[2] ?? "").replace(/\s+/g, " ").trim(), explicit };
}

export function stickerName(requested: string, senderName?: string): string {
  const clean = requested.replace(/\s+/g, " ").trim();
  if (clean) return clean.slice(0, NAME_LIMIT);
  const person = senderName?.replace(/\s+/g, " ").trim();
  return (person ? `sticker de ${person}` : "sticker").slice(0, NAME_LIMIT);
}

/* ------------------------------------------------------------------------ */
/* Metadados (nome do pacote) dentro do WebP                                 */
/* ------------------------------------------------------------------------ */

function stickerExif(info: StickerInfo): Buffer {
  const json = Buffer.from(JSON.stringify({
    "sticker-pack-id": `esqueletops-${randomBytes(8).toString("hex")}`,
    "sticker-pack-name": info.name,
    "sticker-pack-publisher": info.author,
    emojis: ["✨"],
  }), "utf8");
  // Cabeçalho TIFF com a tag privada 0x5741 ("WA") que o WhatsApp lê.
  const header = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  header.writeUInt32LE(json.length, 14);
  return Buffer.concat([header, json]);
}

function chunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat(data.length % 2 ? [head, data, Buffer.alloc(1)] : [head, data]);
}

/**
 * Grava nome e autor no WebP. O WhatsApp guarda esses dados em um chunk EXIF,
 * que só existe no formato estendido (VP8X): se o arquivo estiver no formato
 * simples, o cabeçalho VP8X é criado aqui.
 */
export function withStickerMetadata(
  webp: Buffer,
  info: StickerInfo,
  canvas: { width: number; height: number; hasAlpha: boolean },
): Buffer {
  if (webp.length < 12 || webp.toString("latin1", 0, 4) !== "RIFF" || webp.toString("latin1", 8, 12) !== "WEBP") {
    throw new Error("Arquivo WebP inválido");
  }
  const chunks: Array<{ fourcc: string; data: Buffer }> = [];
  let offset = 12;
  while (offset + 8 <= webp.length) {
    const fourcc = webp.toString("latin1", offset, offset + 4);
    const size = webp.readUInt32LE(offset + 4);
    const start = offset + 8;
    chunks.push({ fourcc, data: webp.subarray(start, Math.min(start + size, webp.length)) });
    offset = start + size + (size % 2);
  }

  const kept = chunks.filter((entry) => entry.fourcc !== "EXIF" && entry.fourcc !== "VP8X");
  const existing = chunks.find((entry) => entry.fourcc === "VP8X");
  const vp8x = Buffer.alloc(10);
  if (existing && existing.data.length >= 10) {
    existing.data.copy(vp8x, 0, 0, 10);
  } else {
    if (canvas.hasAlpha || kept.some((entry) => entry.fourcc === "ALPH" || entry.fourcc === "VP8L")) vp8x[0]! |= 0x10;
    if (kept.some((entry) => entry.fourcc === "ANIM")) vp8x[0]! |= 0x02;
    vp8x.writeUIntLE(Math.max(0, canvas.width - 1), 4, 3);
    vp8x.writeUIntLE(Math.max(0, canvas.height - 1), 7, 3);
  }
  vp8x[0] = (vp8x[0] ?? 0) | 0x08; // sinaliza a presença do EXIF

  const body = Buffer.concat([
    chunk("VP8X", vp8x),
    ...kept.map((entry) => chunk(entry.fourcc, entry.data)),
    chunk("EXIF", stickerExif(info)),
  ]);
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write("WEBP", 8, "latin1");
  return Buffer.concat([riff, body]);
}

/* ------------------------------------------------------------------------ */
/* Conversão                                                                 */
/* ------------------------------------------------------------------------ */

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

async function staticSticker(input: Buffer): Promise<Buffer> {
  for (const quality of [90, 80, 70, 60, 50, 40, 30, 20]) {
    const webp = await sharp(input, { failOn: "none", limitInputPixels: false })
      .rotate()
      .resize({ width: STICKER_SIZE, height: STICKER_SIZE, fit: "contain", background: TRANSPARENT })
      .webp({ quality, alphaQuality: quality, effort: 5 })
      .toBuffer();
    if (webp.length <= STATIC_STICKER_MAX_BYTES - METADATA_MARGIN) return webp;
  }
  throw new Error("A imagem não pôde ser reduzida para o limite de figurinha do WhatsApp");
}

/** WebP animado (figurinha repassada ou GIF): redimensiona mantendo os quadros. */
async function animatedImageSticker(input: Buffer): Promise<Buffer> {
  for (const quality of [70, 55, 40, 28, 18]) {
    const webp = await sharp(input, { animated: true, failOn: "none", limitInputPixels: false })
      .resize({ width: STICKER_SIZE, height: STICKER_SIZE, fit: "contain", background: TRANSPARENT })
      .webp({ quality, alphaQuality: quality, effort: 4, loop: 0 })
      .toBuffer();
    if (webp.length <= ANIMATED_STICKER_MAX_BYTES - METADATA_MARGIN) return webp;
  }
  throw new Error("A animação não pôde ser reduzida para o limite de figurinha do WhatsApp");
}

/** Passos de compressão do vídeo: duração, fps e qualidade caem até caber em 500 KB. */
export const VIDEO_STICKER_STEPS = [
  { seconds: 8, fps: 15, quality: 55 },
  { seconds: 6, fps: 12, quality: 45 },
  { seconds: 5, fps: 10, quality: 35 },
  { seconds: 4, fps: 10, quality: 25 },
  { seconds: 3, fps: 8, quality: 18 },
];

async function videoSticker(input: Buffer): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-wa-sticker-"));
  try {
    const source = join(directory, "source.mp4");
    const output = join(directory, "sticker.webp");
    await writeFile(source, input);
    for (const step of VIDEO_STICKER_STEPS) {
      const seconds = Math.min(step.seconds, env.WHATSAPP_STICKER_MAX_SECONDS);
      await execa(env.FFMPEG_BINARY, [
        "-y", "-i", source, "-t", String(seconds), "-an",
        "-vf", `fps=${step.fps},scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=${STICKER_SIZE}:${STICKER_SIZE}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
        "-c:v", "libwebp", "-lossless", "0", "-q:v", String(step.quality), "-compression_level", "4",
        "-preset", "default", "-loop", "0", "-fps_mode", "passthrough",
        output,
      ], { timeout: 120_000 });
      const webp = await readFile(output);
      if (webp.length <= ANIMATED_STICKER_MAX_BYTES - METADATA_MARGIN) return webp;
    }
    throw new Error("O vídeo não pôde ser reduzido para o limite de figurinha do WhatsApp");
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Converte uma imagem, GIF/WebP animado ou vídeo em figurinha do WhatsApp
 * (WebP 512x512 dentro dos limites de tamanho) e grava o nome nela.
 */
export async function buildWhatsAppSticker(input: Buffer, mimetype: string, info: StickerInfo): Promise<BuiltSticker> {
  const type = mimetype.toLowerCase();
  let webp: Buffer;
  let animated = false;
  if (type.startsWith("video/")) {
    webp = await videoSticker(input);
    animated = true;
  } else {
    const metadata = await sharp(input, { animated: true, failOn: "none", limitInputPixels: false }).metadata();
    animated = (metadata.pages ?? 1) > 1;
    webp = animated ? await animatedImageSticker(input) : await staticSticker(input);
  }
  const hasAlpha = Boolean((await sharp(webp).metadata()).hasAlpha);
  return {
    webp: withStickerMetadata(webp, info, { width: STICKER_SIZE, height: STICKER_SIZE, hasAlpha }),
    animated,
  };
}
