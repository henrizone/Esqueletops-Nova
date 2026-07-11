import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { execa } from "execa";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { DownloadedMedia, DownloadMode, MediaMetadata, RemoteMediaItem } from "./types.js";
import { downloadWithGalleryDl } from "./gallerydl.js";
import { downloadInstagramMedia, isInstagramPostUrl } from "./instagram.js";
import { downloadTwitterMedia, isTwitterStatusUrl } from "./twitter.js";

interface FormatInfo {
  url?: string;
  ext?: string;
  protocol?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  tbr?: number;
  filesize?: number;
  filesize_approx?: number;
}

interface ThumbnailInfo {
  url?: string;
  width?: number;
  height?: number;
}

interface Info {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  channel?: string;
  uploader_id?: string;
  duration?: number;
  webpage_url?: string;
  original_url?: string;
  thumbnail?: string;
  extractor_key?: string;
  extractor?: string;
  ext?: string;
  url?: string;
  width?: number;
  height?: number;
  is_live?: boolean;
  formats?: FormatInfo[];
  thumbnails?: ThumbnailInfo[];
  entries?: Array<Info | null>;
}

let cookiePromise: Promise<string | undefined> | undefined;

function flattenEntries(info: Info): Info[] {
  const output: Info[] = [];
  const visit = (entry: Info | null | undefined) => {
    if (!entry) return;
    if (entry.entries?.length) {
      for (const child of entry.entries) visit(child);
      return;
    }
    output.push(entry);
  };
  if (info.entries?.length) {
    for (const entry of info.entries) visit(entry);
  } else {
    output.push(info);
  }
  return output;
}

function bestThumbnail(entry: Info) {
  const thumbnails = [...(entry.thumbnails ?? [])]
    .filter((item) => item.url)
    .sort((a, b) => ((b.width ?? 0) * (b.height ?? 0)) - ((a.width ?? 0) * (a.height ?? 0)));
  return thumbnails[0]?.url ?? entry.thumbnail;
}

function imageUrl(entry: Info) {
  if (entry.url && /^(?:jpe?g|png|webp|gif)$/i.test(entry.ext ?? "")) return entry.url;
  return bestThumbnail(entry);
}

function videoFormats(entry: Info) {
  const maxBytes = env.MAX_UPLOAD_BYTES;
  return [...(entry.formats ?? [])]
    .filter((format) => Boolean(format.url) && format.vcodec && format.vcodec !== "none")
    .filter((format) => !format.height || format.height <= 1080)
    .filter((format) => {
      const size = format.filesize ?? format.filesize_approx;
      return !size || size <= maxBytes;
    })
    .sort((a, b) => {
      const mp4A = a.ext === "mp4" ? 1 : 0;
      const mp4B = b.ext === "mp4" ? 1 : 0;
      return mp4B - mp4A
        || (b.height ?? 0) - (a.height ?? 0)
        || (b.tbr ?? 0) - (a.tbr ?? 0);
    });
}

/**
 * Recupera fotos e vídeos do JSON do yt-dlp mesmo quando ele informa
 * "No video formats found" para itens de imagem de um carrossel.
 */
export function instagramRemoteItemsFromInfo(info: Info): RemoteMediaItem[] {
  const items: RemoteMediaItem[] = [];
  const seen = new Set<string>();
  const imageExt = /^(?:jpe?g|png|webp|gif|heic)$/i;
  for (const entry of flattenEntries(info)) {
    // Alguns posts de foto do Instagram fazem o yt-dlp devolver um "formats"
    // com vcodec preenchido mesmo sem haver vídeo de fato (ex.: preview
    // sintético gerado pela Meta). Se o próprio yt-dlp já classificou a
    // extensão do item como imagem, confiamos nisso antes de tratar como
    // vídeo — mesma prioridade de __typename usada no extrator direto.
    const isDeclaredImage = imageExt.test(entry.ext ?? "");
    const formats = isDeclaredImage ? [] : videoFormats(entry);
    if (formats.length) {
      const urls = formats.map((format) => format.url!).filter((url, index, all) => all.indexOf(url) === index);
      const url = urls.shift();
      if (url && !seen.has(url)) {
        seen.add(url);
        items.push({
          kind: "video",
          url,
          fallbackUrls: urls,
          width: formats[0]?.width ?? entry.width,
          height: formats[0]?.height ?? entry.height,
          duration: entry.duration,
          thumbnailUrl: bestThumbnail(entry),
        });
      }
      continue;
    }

    const photo = imageUrl(entry);
    if (photo && !seen.has(photo)) {
      seen.add(photo);
      items.push({ kind: "photo", url: photo, width: entry.width, height: entry.height });
    }
  }
  return items.slice(0, env.MAX_MEDIA_ITEMS);
}

async function probeInstagramRemoteMedia(url: string): Promise<DownloadedMedia> {
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-instagram-meta-"));
  try {
    const template = join(directory, "%(playlist_index|)s%(id)s-%(title).80B.%(ext)s");
    let commandError: unknown;
    try {
      await execa(env.YTDLP_BINARY, [
        ...await common(),
        "--ignore-errors",
        "--skip-download",
        "--yes-playlist",
        "--playlist-end", String(env.MAX_MEDIA_ITEMS),
        "--restrict-filenames",
        "--trim-filenames", "120",
        "--output", template,
        "--write-info-json",
        "--write-playlist-metafiles",
        url,
      ], {
        timeout: Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 30_000),
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (error) {
      // O yt-dlp pode encerrar com código 1 após escrever o JSON da playlist
      // quando os itens são fotos. O SmudgeLord usa esses URLs diretamente,
      // então ainda tentamos aproveitar os metadados gerados.
      commandError = error;
    }

    const paths = await walk(directory);
    const jsonPaths = paths.filter((path) => path.endsWith(".info.json"));
    const parsed: Info[] = [];
    for (const path of jsonPaths) {
      try { parsed.push(JSON.parse(await readFile(path, "utf8")) as Info); } catch { /* ignora JSON parcial */ }
    }
    const info = parsed.find((item) => item.entries?.length) ?? parsed[0];
    if (!info) {
      if (commandError) throw commandError;
      throw new Error("yt-dlp não gerou metadados do Instagram");
    }

    const remoteItems = instagramRemoteItemsFromInfo(info);
    if (!remoteItems.length) throw new Error("yt-dlp não retornou fotos ou vídeos do Instagram");
    return {
      files: [],
      remoteItems,
      metadata: {
        ...metadata(info, url),
        extractor: "instagram-ytdlp-metadata",
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function cookieFile() {
  const b64 = env.YTDLP_COOKIES_B64;
  if (!b64) return undefined;
  cookiePromise ??= (async () => {
    const path = join(tmpdir(), "esqueletops-nova-cookies.txt");
    await writeFile(path, Buffer.from(b64, "base64"), { mode: 0o600 });
    return path;
  })();
  return cookiePromise;
}

async function common() {
  const args = [
    "--no-warnings",
    "--no-progress",
    "--newline",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "20",
    "--concurrent-fragments", "4",
    "--no-check-certificates",
  ];
  const cookies = await cookieFile();
  if (cookies) args.push("--cookies", cookies);
  if (env.YTDLP_PROXY) args.push("--proxy", env.YTDLP_PROXY);
  return args;
}

function metadata(info: Info, url: string): MediaMetadata {
  const source = info.entries?.find(Boolean) ?? info;
  return {
    id: source.id,
    title: source.title,
    description: source.description,
    uploader: source.uploader ?? source.channel,
    uploaderId: source.uploader_id,
    duration: source.duration,
    webpageUrl: source.webpage_url ?? info.webpage_url ?? info.original_url ?? url,
    thumbnail: source.thumbnail,
    extractor: source.extractor_key ?? source.extractor,
  };
}

export async function probeMedia(url: string) {
  const result = await execa(env.YTDLP_BINARY, [
    ...await common(),
    "--dump-single-json",
    "--skip-download",
    "--playlist-end", "1",
    url,
  ], {
    timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return metadata(JSON.parse(result.stdout) as Info, url);
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

async function downloadWithYtDlp(url: string, mode: DownloadMode): Promise<DownloadedMedia> {
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-media-"));
  try {
    const template = join(directory, "%(playlist_index|)s%(id)s-%(title).80B.%(ext)s");
    const args = [
      ...await common(),
      "--yes-playlist",
      "--playlist-end", String(env.MAX_MEDIA_ITEMS),
      "--restrict-filenames",
      "--trim-filenames", "120",
      "--output", template,
      "--write-info-json",
      "--max-filesize", `${Math.ceil(env.MAX_UPLOAD_MB * 2)}M`,
    ];
    if (mode === "audio") {
      args.push("--extract-audio", "--audio-format", "mp3", "--audio-quality", "0");
    } else {
      args.push(
        "--format",
        "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/best",
        "--merge-output-format", "mp4",
      );
    }
    args.push(url);
    logger.debug({ url, mode }, "yt-dlp");
    await execa(env.YTDLP_BINARY, args, {
      timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });

    const all = await walk(directory);
    let mediaMetadata: MediaMetadata = { webpageUrl: url };
    const info = all.find((path) => path.endsWith(".info.json"));
    if (info) {
      try { mediaMetadata = metadata(JSON.parse(await readFile(info, "utf8")) as Info, url); } catch { /* ignore */ }
    } else {
      try { mediaMetadata = await probeMedia(url); } catch { /* ignore */ }
    }
    const ignored = new Set([".json", ".part", ".ytdl", ".temp"]);
    const files: string[] = [];
    for (const path of all) {
      if (path.endsWith(".info.json") || ignored.has(extname(path).toLowerCase())) continue;
      const info = await stat(path);
      if (info.isFile() && info.size > 0) files.push(path);
    }
    files.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));
    if (!files.length) throw new Error("yt-dlp não encontrou mídia utilizável");
    return { directory, files: files.slice(0, env.MAX_MEDIA_ITEMS), metadata: mediaMetadata };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function downloadMedia(url: string, mode: DownloadMode): Promise<DownloadedMedia> {
  if (mode !== "audio" && isTwitterStatusUrl(url)) {
    // O extrator dedicado seleciona somente as mídias do tweet principal e
    // mantém o tweet citado apenas como texto. O yt-dlp não garante isso.
    return downloadTwitterMedia(url);
  }

  const instagram = mode !== "audio" && isInstagramPostUrl(url);
  const extractorErrors: unknown[] = [];
  if (instagram) {
    if (env.INSTAGRAM_EMBED_ENABLED) {
      try {
        return await downloadInstagramMedia(url);
      } catch (error) {
        extractorErrors.push(error);
        logger.info({ url, error }, "Extração direta do Instagram indisponível; tentando metadados do yt-dlp");
      }
    }
    try {
      return await probeInstagramRemoteMedia(url);
    } catch (error) {
      extractorErrors.push(error);
      logger.info({ url, error }, "Metadados do Instagram indisponíveis; tentando download convencional");
    }
  }

  try {
    return await downloadWithYtDlp(url, mode);
  } catch (ytDlpError) {
    extractorErrors.push(ytDlpError);
    if (mode === "audio" || instagram || !env.GALLERYDL_ENABLED) {
      if (extractorErrors.length === 1) throw ytDlpError;
      throw new AggregateError(extractorErrors, "Nenhum extrator conseguiu baixar a publicação");
    }
    logger.info({ url, error: ytDlpError }, "yt-dlp não encontrou mídia; tentando fallback com gallery-dl");
    try {
      return await downloadWithGalleryDl(url);
    } catch (galleryDlError) {
      extractorErrors.push(galleryDlError);
      throw new AggregateError(extractorErrors, "Nenhum extrator conseguiu baixar a publicação");
    }
  }
}