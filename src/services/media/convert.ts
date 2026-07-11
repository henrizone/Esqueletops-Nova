import { copyFile, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import { execa } from "execa";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";
import PQueue from "p-queue";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { MediaKind, PreparedMediaItem } from "./types.js";

const photoExtensions = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif", ".heic", ".heif", ".tif", ".tiff", ".bmp",
]);
const videoExtensions = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".m4v", ".gif", ".avi", ".flv", ".mpeg", ".mpg", ".3gp", ".ts", ".m2ts",
]);
const audioExtensions = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"]);

export const TELEGRAM_PHOTO_EXTENSION = ".jpg";
export const TELEGRAM_VIDEO_EXTENSION = ".mp4";
export const TELEGRAM_VIDEO_FPS = 30;
export const TELEGRAM_VIDEO_MAX_EDGE = 1280;
export const TELEGRAM_VIDEO_AUDIO_BITRATE = 128_000;
export const TELEGRAM_VIDEO_MAX_BITRATE = 2_000_000;

async function isAnimatedImage(path: string, mime: string) {
  if (mime === "image/gif" || extname(path).toLowerCase() === ".gif") return true;
  if (!mime.startsWith("image/")) return false;
  try {
    const metadata = await sharp(path, { animated: true, failOn: "none", limitInputPixels: false }).metadata();
    return (metadata.pages ?? 1) > 1;
  } catch {
    return false;
  }
}

export async function detectMediaKind(path: string): Promise<MediaKind> {
  const detected = await fileTypeFromFile(path).catch(() => undefined);
  const mime = detected?.mime ?? "";
  const extension = extname(path).toLowerCase();

  if (mime.startsWith("image/")) return await isAnimatedImage(path, mime) ? "video" : "photo";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (extension === ".gif") return "video";
  if (photoExtensions.has(extension)) return "photo";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  return "document";
}

const fileSize = (path: string) => stat(path).then((value) => value.size);

function normalizedPath(input: string, suffix: string, extension: string) {
  const parsed = parse(input);
  return join(parsed.dir, `${parsed.name}${suffix}${extension}`);
}

/**
 * Toda imagem estática termina em JPEG. A primeira etapa preserva 100% da
 * largura e altura originais; a resolução só é reduzida como último recurso
 * quando nem a compressão JPEG cabe no limite configurado do Telegram.
 */
async function normalizePhoto(input: string) {
  const output = normalizedPath(input, "-telegram", TELEGRAM_PHOTO_EXTENSION);
  const base = () => sharp(input, {
    animated: false,
    failOn: "none",
    limitInputPixels: false,
  })
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } });

  for (const quality of [92, 86, 80, 74, 68, 60, 52, 44]) {
    await base()
      .jpeg({ quality, progressive: true, chromaSubsampling: "4:2:0" })
      .toFile(output);
    if (await fileSize(output) <= env.MAX_UPLOAD_BYTES) return output;
  }

  const metadata = await base().metadata();
  const originalWidth = metadata.width ?? 0;
  for (const scale of [0.90, 0.80, 0.70, 0.60, 0.50, 0.40]) {
    const width = originalWidth > 0 ? Math.max(1, Math.floor(originalWidth * scale)) : undefined;
    await base()
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, progressive: true, chromaSubsampling: "4:2:0" })
      .toFile(output);
    if (await fileSize(output) <= env.MAX_UPLOAD_BYTES) return output;
  }

  return output;
}

export interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeResult {
  format?: {
    duration?: string;
    format_name?: string;
    bit_rate?: string;
  };
  streams?: ProbeStream[];
}

async function probeMedia(path: string): Promise<ProbeResult> {
  const result = await execa(env.FFPROBE_BINARY, [
    "-v", "error",
    "-show_entries", "format=duration,format_name,bit_rate:stream=codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,display_aspect_ratio,avg_frame_rate,r_frame_rate:stream_tags=rotate:stream_side_data=rotation",
    "-of", "json",
    path,
  ], { timeout: 30_000 });
  return JSON.parse(result.stdout) as ProbeResult;
}

function durationFromProbe(probe: ProbeResult) {
  const value = Number(probe.format?.duration ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function parseRatio(raw?: string) {
  if (!raw || raw === "N/A" || raw === "0:1") return undefined;
  const match = raw.trim().match(/^(-?\d+(?:\.\d+)?)[:/](-?\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  const left = Number(match[1]);
  const right = Number(match[2]);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return undefined;
  return left / right;
}

function rotationFromStream(stream: ProbeStream) {
  const sideDataRotation = stream.side_data_list?.find((item) => Number.isFinite(item.rotation))?.rotation;
  const raw = sideDataRotation ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

function evenDimension(value: number) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

export interface VideoDimensions {
  width: number;
  height: number;
}

/**
 * Calcula as dimensões visuais reais antes de converter. Considera SAR/DAR e
 * rotação do arquivo; depois reduz apenas quando algum lado excede 1280 px.
 * Não corta, não adiciona bordas e nunca força 1:1.
 */
export function targetVideoDimensions(stream: ProbeStream): VideoDimensions {
  const encodedWidth = Math.max(2, stream.width ?? 2);
  const encodedHeight = Math.max(2, stream.height ?? 2);
  const sar = parseRatio(stream.sample_aspect_ratio) ?? 1;
  const declaredDar = parseRatio(stream.display_aspect_ratio);

  let displayWidth = encodedWidth * sar;
  let displayHeight = encodedHeight;

  if (declaredDar && Number.isFinite(declaredDar) && declaredDar > 0) {
    displayWidth = displayHeight * declaredDar;
  }

  const rotation = rotationFromStream(stream);
  if (rotation === 90 || rotation === 270) {
    [displayWidth, displayHeight] = [displayHeight, displayWidth];
  }

  const scale = Math.min(
    1,
    TELEGRAM_VIDEO_MAX_EDGE / Math.max(displayWidth, 1),
    TELEGRAM_VIDEO_MAX_EDGE / Math.max(displayHeight, 1),
  );

  return {
    width: evenDimension(displayWidth * scale),
    height: evenDimension(displayHeight * scale),
  };
}

export function telegramVideoFilter(dimensions: VideoDimensions) {
  return [
    // O FFmpeg aplica a rotação de exibição automaticamente antes deste filtro.
    // Escalar para dimensões calculadas pelo DAR/SAR remove anamorfismo sem
    // achatar a imagem e sem preservar matrizes de rotação problemáticas no iOS.
    `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`,
    "setsar=1",
    `fps=${TELEGRAM_VIDEO_FPS}`,
    "format=yuv420p",
  ].join(",");
}

function bitrateCapForDimensions(width: number, height: number) {
  const pixels = width * height;
  if (pixels <= 426 * 240) return 650_000;
  if (pixels <= 640 * 360) return 900_000;
  if (pixels <= 854 * 480) return 1_250_000;
  return TELEGRAM_VIDEO_MAX_BITRATE;
}

/**
 * Mantém vídeos sociais 720p próximos de 2 Mbps (um Reel de 14 s fica perto
 * de 3,5–4 MB), reduzindo automaticamente para vídeos longos caberem no limite.
 */
export function targetVideoBitrate(width: number, height: number, duration: number) {
  const safeDuration = Math.max(1, duration);
  const fitTotalBitrate = Math.floor((env.MAX_UPLOAD_BYTES * 8 * 0.88) / safeDuration);
  const fitVideoBitrate = Math.max(260_000, fitTotalBitrate - TELEGRAM_VIDEO_AUDIO_BITRATE);
  return Math.min(bitrateCapForDimensions(width, height), fitVideoBitrate);
}

function videoOutput(input: string) {
  return normalizedPath(input, "-telegram", TELEGRAM_VIDEO_EXTENSION);
}

interface NormalizedVideo {
  path: string;
  width: number;
  height: number;
  duration: number;
}

async function transcodeVideo(
  input: string,
  output: string,
  stream: ProbeStream,
  duration: number,
): Promise<NormalizedVideo> {
  const dimensions = targetVideoDimensions(stream);
  const videoBitrate = targetVideoBitrate(dimensions.width, dimensions.height, duration);

  await execa(env.FFMPEG_BINARY, [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map_metadata", "-1",
    "-map_chapters", "-1",
    "-sn",
    "-dn",
    "-vf", telegramVideoFilter(dimensions),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", String(videoBitrate),
    "-maxrate", String(Math.floor(videoBitrate * 1.12)),
    "-bufsize", String(videoBitrate * 2),
    "-pix_fmt", "yuv420p",
    "-profile:v", "main",
    "-level:v", "4.0",
    "-tag:v", "avc1",
    "-c:a", "aac",
    "-b:a", String(TELEGRAM_VIDEO_AUDIO_BITRATE),
    "-ar", "48000",
    "-ac", "2",
    "-metadata:s:v:0", "rotate=0",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "2048",
    "-f", "mp4",
    output,
  ], { timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000 });

  return { path: output, width: dimensions.width, height: dimensions.height, duration };
}

/**
 * Todo vídeo, Reel, GIF ou imagem animada passa pelo mesmo perfil final:
 * MP4/H.264/AAC, 30 fps, pixels quadrados, proporção visual preservada e
 * bitrate reduzido. A recodificação única remove metadados que fazem o vídeo
 * aparecer espremido no Telegram para iOS.
 */
async function normalizeVideo(input: string): Promise<NormalizedVideo> {
  const output = videoOutput(input);
  const probe = await probeMedia(input);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const duration = durationFromProbe(probe);

  if (!video) throw new Error("Arquivo classificado como vídeo não possui stream de vídeo");

  const normalized = await transcodeVideo(input, output, video, duration);
  logger.debug({
    input,
    output,
    width: normalized.width,
    height: normalized.height,
    fps: TELEGRAM_VIDEO_FPS,
    bitrate: targetVideoBitrate(normalized.width, normalized.height, duration),
  }, "Vídeo convertido para o perfil universal do Telegram");
  return normalized;
}

async function convertAudio(input: string) {
  const output = normalizedPath(input, "-telegram", ".mp3");
  await execa(env.FFMPEG_BINARY, [
    "-y",
    "-i", input,
    "-map_metadata", "-1",
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    output,
  ], { timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000 });
  return output;
}

async function prepareOneMediaFile(original: string): Promise<PreparedMediaItem | undefined> {
  let kind = await detectMediaKind(original);
  let path = original;
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;

  if (kind === "photo") {
    path = await normalizePhoto(original);
  } else if (kind === "video") {
    const normalized = await normalizeVideo(original);
    path = normalized.path;
    width = normalized.width;
    height = normalized.height;
    duration = normalized.duration;
  } else if (kind === "audio" && extname(original).toLowerCase() !== ".mp3") {
    path = await convertAudio(original);
  }

  let size = await fileSize(path);
  if (size > env.MAX_UPLOAD_BYTES) {
    if (kind === "photo") {
      path = await normalizePhoto(path);
    } else if (kind === "video") {
      const normalized = await normalizeVideo(path);
      path = normalized.path;
      width = normalized.width;
      height = normalized.height;
      duration = normalized.duration;
    } else if (kind === "audio") {
      path = await convertAudio(path);
    }
    size = await fileSize(path);
  }

  if (size > env.MAX_UPLOAD_BYTES) {
    logger.warn({ path, size }, "Arquivo continuou acima do limite após normalização");
    return undefined;
  }

  const safePath = join(dirname(path), basename(path).replace(/[^a-zA-Z0-9._-]/g, "_"));
  if (safePath !== path) {
    try {
      await rename(path, safePath);
      path = safePath;
    } catch {
      await copyFile(path, safePath);
      path = safePath;
    }
  }

  kind = await detectMediaKind(path);
  const extension = extname(path).toLowerCase();
  if (kind === "photo" && extension !== TELEGRAM_PHOTO_EXTENSION) {
    throw new Error(`Foto não foi normalizada para JPEG: ${basename(path)}`);
  }
  if (kind === "video" && extension !== TELEGRAM_VIDEO_EXTENSION) {
    throw new Error(`Vídeo não foi normalizado para MP4: ${basename(path)}`);
  }

  logger.debug({ path, kind, extension, size, width, height, duration }, "Mídia normalizada para o Telegram");
  return { path, kind, filename: basename(path), size, width, height, duration };
}

/**
 * Ponto único usado por /dl, /sdl, /ytdl, Shorts e download automático de
 * todas as plataformas. Mantém a ordem do álbum e limita a concorrência para
 * responder rápido sem saturar CPU/RAM do container.
 */
export async function prepareMediaFiles(paths: string[]): Promise<PreparedMediaItem[]> {
  const queue = new PQueue({ concurrency: Math.min(env.DOWNLOAD_CONCURRENCY, 2) });
  const prepared = await Promise.all(paths.map((path) => queue.add(() => prepareOneMediaFile(path))));
  return prepared.filter((item): item is PreparedMediaItem => Boolean(item));
}
