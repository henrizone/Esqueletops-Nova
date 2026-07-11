import { copyFile, rename, stat } from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import { execa } from "execa";
import { fileTypeFromFile } from "file-type";
import sharp from "sharp";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { MediaKind, PreparedMediaItem } from "./types.js";

const photoExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
const videoExtensions = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".gif"]);
const audioExtensions = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"]);

async function detectKind(path: string): Promise<MediaKind> {
  const detected = await fileTypeFromFile(path).catch(() => undefined);
  const mime = detected?.mime ?? "";
  const extension = extname(path).toLowerCase();

  if (mime.startsWith("image/") && mime !== "image/gif") return "photo";
  if (mime.startsWith("video/") || mime === "image/gif") return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (photoExtensions.has(extension)) return "photo";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  return "document";
}

const fileSize = (path: string) => stat(path).then((value) => value.size);

async function convertImage(input: string) {
  const output = join(dirname(input), `${parse(input).name}-telegram.jpg`);
  for (const quality of [88, 78, 68, 58, 48, 38]) {
    await sharp(input)
      .rotate()
      .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toFile(output);
    if (await fileSize(output) <= env.MAX_UPLOAD_BYTES) return output;
  }
  return output;
}

async function mediaDuration(path: string) {
  const result = await execa(env.FFPROBE_BINARY, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    path,
  ], { timeout: 30_000 });
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Mantém a proporção, limita cada lado a 1920 px e força largura/altura pares.
 * O libx264 rejeita dimensões ímpares; o filtro antigo podia gerar 1919 px.
 */
export const telegramVideoFilter = [
  "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease",
  "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'",
  "format=yuv420p",
].join(",");

async function convertVideo(input: string) {
  const output = join(dirname(input), `${parse(input).name}-telegram.mp4`);
  const duration = await mediaDuration(input);
  const availableBits = Math.max(2_000_000, env.MAX_UPLOAD_BYTES * 8 * 0.90);
  const audioBitrate = 96_000;
  const videoBitrate = Math.max(180_000, Math.floor(availableBits / duration - audioBitrate));

  await execa(env.FFMPEG_BINARY, [
    "-y",
    "-i", input,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-map_metadata", "-1",
    "-vf", telegramVideoFilter,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-b:v", String(videoBitrate),
    "-maxrate", String(Math.floor(videoBitrate * 1.20)),
    "-bufsize", String(videoBitrate * 2),
    "-c:a", "aac",
    "-b:a", "96k",
    "-movflags", "+faststart",
    output,
  ], { timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000 });

  return output;
}

async function convertAudio(input: string) {
  const output = join(dirname(input), `${parse(input).name}-telegram.mp3`);
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

export async function prepareMediaFiles(paths: string[]): Promise<PreparedMediaItem[]> {
  const output: PreparedMediaItem[] = [];

  for (const original of paths) {
    let kind = await detectKind(original);
    let path = original;
    let extension = extname(path).toLowerCase();

    if (kind === "video" && extension !== ".mp4") path = await convertVideo(path);
    if (kind === "audio" && extension !== ".mp3") path = await convertAudio(path);
    if (kind === "photo" && ![".jpg", ".jpeg", ".png"].includes(extension)) path = await convertImage(path);

    let size = await fileSize(path);
    if (size > env.MAX_UPLOAD_BYTES) {
      path = kind === "photo"
        ? await convertImage(path)
        : kind === "video"
          ? await convertVideo(path)
          : kind === "audio"
            ? await convertAudio(path)
            : path;
      size = await fileSize(path);
    }

    if (size > env.MAX_UPLOAD_BYTES) {
      logger.warn({ path, size }, "Arquivo continuou acima do limite após conversão");
      continue;
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

    kind = await detectKind(path);
    extension = extname(path).toLowerCase();
    output.push({ path, kind, filename: basename(path), size });
    logger.debug({ path, kind, extension, size }, "Mídia preparada para o Telegram");
  }

  return output;
}
