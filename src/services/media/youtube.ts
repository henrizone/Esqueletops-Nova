import { InputFile } from "grammy";
import type { Message } from "grammy/types";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { execa } from "execa";
import sharp from "sharp";
import { cacheGetJson, cacheSetJson } from "../../cache/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { BotContext } from "../../types/context.js";
import { escapeHtml } from "../../utils/html.js";
import { sourceKeyboard } from "./source-button.js";
import { prepareMediaFiles } from "./convert.js";
import { cookieFileForUrl } from "./cookies.js";

export type YouTubeDownloadMode = "video" | "audio";

interface YouTubeFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  fps?: number;
  filesize?: number;
  filesize_approx?: number;
  tbr?: number;
  abr?: number;
}

export interface YouTubeInfo {
  id: string;
  title: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  webpage_url?: string;
  thumbnail?: string;
  formats?: YouTubeFormat[];
}

interface HelperFormat {
  itag: number;
  size: number;
  width?: number;
  height?: number;
  quality_label?: string;
}

interface HelperInfo {
  id: string;
  title: string;
  author: string;
  duration_seconds: number;
  thumbnail?: string;
  video?: HelperFormat;
  audio?: HelperFormat;
}

interface YouTubeCache {
  fileId: string;
  mode: YouTubeDownloadMode;
  title: string;
  uploader?: string;
  caption: string;
}

async function commonArgs(url: string) {
  const args = [
    "--no-warnings",
    "--no-progress",
    "--newline",
    "--no-playlist",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "20",
    "--no-check-certificates",
    "--js-runtimes", "node",
  ];
  const cookies = await cookieFileForUrl(url);
  if (cookies) args.push("--cookies", cookies);
  if (env.YTDLP_PROXY) args.push("--proxy", env.YTDLP_PROXY);
  return args;
}

async function helperArgs(url: string) {
  const args = ["--url", url, "--max-bytes", String(env.MAX_UPLOAD_BYTES)];
  const cookies = await cookieFileForUrl(url);
  if (cookies) args.push("--cookies", cookies);
  return args;
}

function helperToInfo(info: HelperInfo): YouTubeInfo {
  const formats: YouTubeFormat[] = [];
  if (info.video) {
    formats.push({
      format_id: String(info.video.itag),
      ext: "mp4",
      vcodec: "h264",
      acodec: "none",
      width: info.video.width,
      height: info.video.height,
      filesize: info.video.size,
    });
  }
  if (info.audio) {
    formats.push({
      format_id: String(info.audio.itag),
      ext: "m4a",
      vcodec: "none",
      acodec: "aac",
      filesize: info.audio.size,
    });
  }
  return {
    id: info.id,
    title: info.title,
    uploader: info.author,
    channel: info.author,
    duration: info.duration_seconds,
    webpage_url: `https://www.youtube.com/watch?v=${info.id}`,
    thumbnail: info.thumbnail,
    formats,
  };
}

async function probeWithHelper(url: string): Promise<YouTubeInfo> {
  const result = await execa(env.YOUTUBE_HELPER_BINARY, ["info", ...await helperArgs(url)], {
    timeout: Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 60_000),
    maxBuffer: 10 * 1024 * 1024,
  });
  const info = helperToInfo(JSON.parse(result.stdout) as HelperInfo);
  if (!info.id || !info.title) throw new Error("O YouTube não retornou os dados do vídeo");
  return info;
}

async function probeWithYtDlp(url: string): Promise<YouTubeInfo> {
  const result = await execa(env.YTDLP_BINARY, [
    ...await commonArgs(url),
    "--dump-single-json",
    "--skip-download",
    url,
  ], {
    timeout: Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 60_000),
    maxBuffer: 30 * 1024 * 1024,
  });
  const info = JSON.parse(result.stdout) as YouTubeInfo;
  if (!info.id || !info.title) throw new Error("O YouTube não retornou os dados do vídeo");
  return info;
}

export async function probeYouTube(url: string): Promise<YouTubeInfo> {
  try {
    return await probeWithHelper(url);
  } catch (helperError) {
    logger.warn({ error: helperError, url }, "Cliente direto do YouTube indisponível; tentando yt-dlp");
    return probeWithYtDlp(url);
  }
}

function estimatedBytes(info: YouTubeInfo, mode: YouTubeDownloadMode) {
  const formats = info.formats ?? [];
  if (mode === "audio") {
    const audio = formats
      .filter((format) => format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none"))
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
    return audio?.filesize ?? audio?.filesize_approx;
  }
  const video = formats
    .filter((format) => format.vcodec && format.vcodec !== "none" && (format.height ?? 0) <= 1080)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.tbr ?? 0) - (a.tbr ?? 0))[0];
  const audio = formats
    .filter((format) => format.acodec && format.acodec !== "none" && (!format.vcodec || format.vcodec === "none"))
    .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0];
  const videoBytes = video?.filesize ?? video?.filesize_approx ?? 0;
  const audioBytes = audio?.filesize ?? audio?.filesize_approx ?? 0;
  return videoBytes || audioBytes ? videoBytes + audioBytes : undefined;
}

export function youtubeChoiceMeta(info: YouTubeInfo) {
  const duration = info.duration
    ? `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, "0")}`
    : undefined;
  const videoBytes = estimatedBytes(info, "video");
  const audioBytes = estimatedBytes(info, "audio");
  const formatMb = (bytes?: number) => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : undefined;
  return {
    duration,
    videoSize: formatMb(videoBytes),
    audioSize: formatMb(audioBytes),
  };
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}

async function makeThumbnail(input?: string) {
  if (!input) return undefined;
  const output = join(tmpdir(), `esqueletops-youtube-thumb-${crypto.randomUUID()}.jpg`);
  try {
    await sharp(input)
      .rotate()
      .resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 78, mozjpeg: true })
      .toFile(output);
    const size = (await stat(output)).size;
    if (size > 200_000) {
      await sharp(input)
        .rotate()
        .resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 60, mozjpeg: true })
        .toFile(output);
    }
    return output;
  } catch {
    await rm(output, { force: true }).catch(() => undefined);
    return undefined;
  }
}

async function makeThumbnailFromUrl(url?: string) {
  if (!url) return undefined;
  const source = join(tmpdir(), `esqueletops-youtube-thumb-source-${crypto.randomUUID()}`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return undefined;
    await writeFile(source, Buffer.from(await response.arrayBuffer()));
    return await makeThumbnail(source);
  } catch {
    return undefined;
  } finally {
    await rm(source, { force: true }).catch(() => undefined);
  }
}

function cacheKey(id: string, mode: YouTubeDownloadMode) {
  return `youtube:v3:${id}:${mode}`;
}

function captionFor(info: YouTubeInfo) {
  const uploader = info.uploader ?? info.channel ?? "YouTube";
  return `<b>${escapeHtml(uploader)}:</b> ${escapeHtml(info.title)}`;
}

function replyParams(messageId?: number) {
  return messageId ? { reply_parameters: { message_id: messageId } } : {};
}

async function sendCached(
  ctx: BotContext,
  cached: YouTubeCache,
  replyToMessageId: number | undefined,
  sourceUrl: string,
): Promise<Message> {
  const common = {
    caption: cached.caption,
    parse_mode: "HTML" as const,
    reply_markup: env.MEDIA_SOURCE_BUTTON ? sourceKeyboard(sourceUrl) : undefined,
    ...replyParams(replyToMessageId),
  };
  if (cached.mode === "audio") {
    return ctx.replyWithAudio(cached.fileId, {
      ...common,
      title: cached.title,
      performer: cached.uploader,
    });
  }
  return ctx.replyWithVideo(cached.fileId, { ...common, supports_streaming: true });
}

async function downloadWithHelper(url: string, mode: YouTubeDownloadMode, info: YouTubeInfo) {
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-youtube-direct-"));
  const mediaPath = join(directory, mode === "audio" ? `${info.id}.m4a` : `${info.id}.mp4`);
  try {
    const result = await execa(env.YOUTUBE_HELPER_BINARY, [
      "download",
      ...await helperArgs(url),
      "--mode", mode,
      "--output", mediaPath,
    ], {
      timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const downloadedInfo = helperToInfo(JSON.parse(result.stdout) as HelperInfo);
    const thumbnailPath = await makeThumbnailFromUrl(downloadedInfo.thumbnail ?? info.thumbnail);
    return { directory, mediaPath, thumbnailPath, info: downloadedInfo };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function downloadWithYtDlp(url: string, mode: YouTubeDownloadMode) {
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-youtube-"));
  const outputTemplate = join(directory, "%(id)s-%(title).80B.%(ext)s");
  const args = [
    ...await commonArgs(url),
    "--restrict-filenames",
    "--trim-filenames", "120",
    "--output", outputTemplate,
    "--write-info-json",
    "--write-thumbnail",
    "--convert-thumbnails", "jpg",
    "--max-filesize", `${Math.ceil(env.MAX_UPLOAD_MB * 2)}M`,
  ];
  if (mode === "audio") {
    args.push(
      "--format", "ba[ext=m4a]/ba/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
    );
  } else {
    args.push(
      "--format", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b[ext=mp4]/best[height<=1080]/best",
      "--merge-output-format", "mp4",
    );
  }
  args.push(url);

  try {
    await execa(env.YTDLP_BINARY, args, {
      timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
    const files = await walk(directory);
    const infoPath = files.find((path) => path.endsWith(".info.json"));
    const info = infoPath
      ? JSON.parse(await readFile(infoPath, "utf8")) as YouTubeInfo
      : await probeWithYtDlp(url);
    const mediaExtensions = mode === "audio"
      ? new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus"])
      : new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v"]);
    const mediaPath = files.find((path) => mediaExtensions.has(extname(path).toLowerCase()));
    if (!mediaPath) throw new Error(`O YouTube não gerou um arquivo de ${mode === "audio" ? "áudio" : "vídeo"}`);
    const thumbnails = files.filter((path) => [".jpg", ".jpeg", ".png", ".webp"].includes(extname(path).toLowerCase()));
    const thumbnailPath = await makeThumbnail(thumbnails[0]);
    return { directory, mediaPath, thumbnailPath, info };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function downloadFile(url: string, mode: YouTubeDownloadMode, info: YouTubeInfo) {
  try {
    return await downloadWithHelper(url, mode, info);
  } catch (helperError) {
    logger.warn({ error: helperError, url, mode }, "Download direto do YouTube falhou; tentando yt-dlp");
    return downloadWithYtDlp(url, mode);
  }
}

export async function sendYouTubeDownload(input: {
  ctx: BotContext;
  url: string;
  mode: YouTubeDownloadMode;
  replyToMessageId?: number;
}): Promise<Message> {
  const { ctx, url, mode, replyToMessageId } = input;
  const info = await probeYouTube(url);
  const cached = await cacheGetJson<YouTubeCache>(cacheKey(info.id, mode)).catch(() => null);
  if (cached) {
    try {
      return await sendCached(ctx, cached, replyToMessageId, url);
    } catch (error) {
      logger.warn({ error, id: info.id, mode }, "Cache do YouTube inválido; baixando novamente");
    }
  }

  await ctx.api.sendChatAction(ctx.chat!.id, mode === "audio" ? "upload_voice" : "upload_video").catch(() => undefined);
  const downloaded = await downloadFile(url, mode, info);
  try {
    const prepared = await prepareMediaFiles([downloaded.mediaPath]);
    const item = prepared[0];
    if (!item) throw new Error("O arquivo do YouTube não pôde ser preparado para o Telegram");
    if (mode === "audio" && item.kind !== "audio") throw new Error("O YouTube retornou um arquivo que não é áudio");
    if (mode === "video" && item.kind !== "video") throw new Error("O YouTube retornou um arquivo que não é vídeo");

    const caption = captionFor(downloaded.info);
    const common = {
      caption,
      parse_mode: "HTML" as const,
      reply_markup: env.MEDIA_SOURCE_BUTTON ? sourceKeyboard(url) : undefined,
      ...replyParams(replyToMessageId),
    };
    let message: Message;
    if (mode === "audio") {
      message = await ctx.replyWithAudio(new InputFile(item.path, item.filename), {
        ...common,
        title: downloaded.info.title,
        performer: downloaded.info.uploader ?? downloaded.info.channel,
        thumbnail: downloaded.thumbnailPath ? new InputFile(downloaded.thumbnailPath, "thumbnail.jpg") : undefined,
      });
    } else {
      message = await ctx.replyWithVideo(new InputFile(item.path, item.filename), {
        ...common,
        supports_streaming: true,
        thumbnail: downloaded.thumbnailPath ? new InputFile(downloaded.thumbnailPath, "thumbnail.jpg") : undefined,
      });
    }

    const fileId = mode === "audio" ? message.audio?.file_id : message.video?.file_id;
    if (fileId) {
      await cacheSetJson(cacheKey(info.id, mode), {
        fileId,
        mode,
        title: downloaded.info.title,
        uploader: downloaded.info.uploader ?? downloaded.info.channel,
        caption,
      } satisfies YouTubeCache, env.MEDIA_CACHE_TTL_SECONDS).catch(() => undefined);
    }
    return message;
  } finally {
    await rm(downloaded.directory, { recursive: true, force: true }).catch(() => undefined);
    if (downloaded.thumbnailPath) await rm(downloaded.thumbnailPath, { force: true }).catch(() => undefined);
  }
}
