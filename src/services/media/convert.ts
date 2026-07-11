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
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

interface ProbeResult {
  format?: {
    duration?: string;
    format_name?: string;
  };
  streams?: ProbeStream[];
}

async function probeMedia(path: string): Promise<ProbeResult> {
  const result = await execa(env.FFPROBE_BINARY, [
    "-v", "error",
    "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt,sample_aspect_ratio,display_aspect_ratio:stream_tags=rotate:stream_side_data=rotation",
    "-of", "json",
    path,
  ], { timeout: 30_000 });
  return JSON.parse(result.stdout) as ProbeResult;
}

function durationFromProbe(probe: ProbeResult) {
  const value = Number(probe.format?.duration ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizedRotation(stream: ProbeStream) {
  const sideDataRotation = stream.side_data_list?.find((item) => Number.isFinite(item.rotation))?.rotation;
  const raw = sideDataRotation ?? Number(stream.tags?.rotate ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

function hasSquarePixels(stream: ProbeStream) {
  const sar = stream.sample_aspect_ratio?.trim();
  return !sar || sar === "1:1" || sar === "0:1" || sar === "N/A";
}

/**
 * Mantém a proporção real, limita cada lado a 1920 px, força dimensões pares
 * e pixels quadrados. `setsar=1` evita o vídeo achatado/esticado no iOS.
 */
export const telegramVideoFilter = [
  // Primeiro transforma pixels anamórficos em pixels quadrados sem alterar a
  // proporção visual. Depois aplica apenas redução, nunca esticamento.
  "scale=w='max(2,trunc(iw*sar/2)*2)':h='max(2,trunc(ih/2)*2)':flags=lanczos",
  "setsar=1",
  "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
  "scale=w='max(2,trunc(iw/2)*2)':h='max(2,trunc(ih/2)*2)':flags=lanczos",
  "setsar=1",
  "format=yuv420p",
].join(",");

export function canFastRemuxVideo(stream: ProbeStream | undefined) {
  if (!stream) return false;
  const width = stream.width ?? 0;
  const height = stream.height ?? 0;
  return stream.codec_name === "h264"
    && width > 0
    && height > 0
    && width <= 1920
    && height <= 1920
    && width % 2 === 0
    && height % 2 === 0
    && ["yuv420p", "yuvj420p"].includes(stream.pix_fmt ?? "")
    && hasSquarePixels(stream)
    && normalizedRotation(stream) === 0;
}

function videoOutput(input: string) {
  return normalizedPath(input, "-telegram", TELEGRAM_VIDEO_EXTENSION);
}

async function remuxOrCopyVideo(input: string, output: string, audioCodec?: string) {
  const args = [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map_metadata", "-1",
    "-sn",
    "-dn",
    "-c:v", "copy",
  ];

  if (audioCodec && audioCodec !== "aac") {
    args.push("-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-c:a", "copy");
  }

  args.push(
    "-metadata:s:v:0", "rotate=0",
    "-movflags", "+faststart",
    "-f", "mp4",
    output,
  );
  await execa(env.FFMPEG_BINARY, args, { timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000 });
}

async function transcodeVideo(input: string, output: string, duration: number) {
  const availableBits = Math.max(2_000_000, env.MAX_UPLOAD_BYTES * 8 * 0.90);
  const audioBitrate = 128_000;
  const fitBitrate = Math.max(220_000, Math.floor(availableBits / duration - audioBitrate));
  const videoBitrate = Math.min(8_000_000, fitBitrate);

  await execa(env.FFMPEG_BINARY, [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map_metadata", "-1",
    "-sn",
    "-dn",
    "-vf", telegramVideoFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", String(videoBitrate),
    "-maxrate", String(Math.floor(videoBitrate * 1.20)),
    "-bufsize", String(videoBitrate * 2),
    "-pix_fmt", "yuv420p",
    "-profile:v", "high",
    "-level:v", "4.1",
    "-tag:v", "avc1",
    "-c:a", "aac",
    "-b:a", "128k",
    "-metadata:s:v:0", "rotate=0",
    "-movflags", "+faststart",
    "-f", "mp4",
    output,
  ], { timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000 });
}

/**
 * Todo vídeo, GIF ou imagem animada termina como MP4 H.264/AAC. Quando o vídeo
 * já é H.264, o fluxo rápido apenas remuxa para MP4 e copia o stream de vídeo;
 * a recodificação completa só acontece quando o codec é incompatível ou o
 * arquivo continua acima do limite.
 */
async function normalizeVideo(input: string) {
  const output = videoOutput(input);
  const probe = await probeMedia(input);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = durationFromProbe(probe);

  if (!video) throw new Error("Arquivo classificado como vídeo não possui stream de vídeo");

  if (canFastRemuxVideo(video)) {
    try {
      await remuxOrCopyVideo(input, output, audio?.codec_name);
      if (await fileSize(output) <= env.MAX_UPLOAD_BYTES) return output;
      logger.debug({ input, size: await fileSize(output) }, "MP4 compatível excedeu o limite; comprimindo");
    } catch (error) {
      logger.debug({ input, error }, "Remux rápido falhou; convertendo vídeo para H.264/AAC");
    }
  }

  await transcodeVideo(input, output, duration);
  return output;
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

  if (kind === "photo") path = await normalizePhoto(original);
  else if (kind === "video") path = await normalizeVideo(original);
  else if (kind === "audio" && extname(original).toLowerCase() !== ".mp3") path = await convertAudio(original);

  let size = await fileSize(path);
  if (size > env.MAX_UPLOAD_BYTES) {
    path = kind === "photo"
      ? await normalizePhoto(path)
      : kind === "video"
        ? await normalizeVideo(path)
        : kind === "audio"
          ? await convertAudio(path)
          : path;
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

  logger.debug({ path, kind, extension, size }, "Mídia normalizada para o Telegram");
  return { path, kind, filename: basename(path), size };
}

/**
 * Ponto único de normalização usado por /dl, /sdl, /ytdl, Shorts e pelo
 * download automático de todas as plataformas. Mantém a ordem do álbum e
 * processa no máximo poucas mídias em paralelo para responder rápido sem
 * saturar CPU/RAM do container.
 */
export async function prepareMediaFiles(paths: string[]): Promise<PreparedMediaItem[]> {
  const queue = new PQueue({ concurrency: Math.min(env.DOWNLOAD_CONCURRENCY, 3) });
  const prepared = await Promise.all(paths.map((path) => queue.add(() => prepareOneMediaFile(path))));
  return prepared.filter((item): item is PreparedMediaItem => Boolean(item));
}
