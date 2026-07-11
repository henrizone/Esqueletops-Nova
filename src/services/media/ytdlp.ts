import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { execa } from "execa";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { DownloadedMedia, DownloadMode, MediaMetadata, RemoteMediaItem } from "./types.js";
import { downloadWithGalleryDl } from "./gallerydl.js";
import { downloadInstagramMedia, isInstagramPostUrl, isInstagramReelUrl } from "./instagram.js";
import { downloadTwitterMedia, isTwitterStatusUrl } from "./twitter.js";
import { cookieFileForUrl } from "./cookies.js";

interface FormatInfo {
  url?: string;
  ext?: string;
  video_ext?: string;
  protocol?: string;
  vcodec?: string;
  acodec?: string;
  width?: number;
  height?: number;
  tbr?: number;
  filesize?: number;
  filesize_approx?: number;
  http_headers?: Record<string, string>;
}

interface ThumbnailInfo {
  url?: string;
  width?: number;
  height?: number;
}

interface Info {
  _type?: string;
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
  video_ext?: string;
  url?: string;
  width?: number;
  height?: number;
  is_live?: boolean;
  formats?: FormatInfo[];
  thumbnails?: ThumbnailInfo[];
  http_headers?: Record<string, string>;
  entries?: Array<Info | null>;
}

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

function isImageExtension(value?: string) {
  return /^(?:jpe?g|png|webp|gif|avif)$/i.test(value ?? "");
}

function isVideoExtension(value?: string) {
  return /^(?:mp4|m4v|mov|webm|mkv)$/i.test(value ?? "");
}

function directVideoUrl(entry: Info) {
  return entry.url
    && entry._type !== "url"
    && (isVideoExtension(entry.ext ?? entry.video_ext) || /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(entry.url))
    ? entry.url
    : undefined;
}

function titleExpectsVideo(title?: string) {
  return /^(?:video(?:\s+\d+)?|reel)(?:\s+by\b|\s*$|\s+\d+\b)/i.test(title?.trim() ?? "");
}

function instagramEntryExpectsVideo(entry: Info, forceVideo = false) {
  return forceVideo
    || titleExpectsVideo(entry.title)
    || isVideoExtension(entry.ext ?? entry.video_ext)
    || Boolean(entry.duration && entry.duration > 0);
}

function instagramEntryHasVideo(entry: Info) {
  return Boolean(directVideoUrl(entry) || videoFormats(entry).length);
}

export function instagramInfoExpectsVideo(info: Info, sourceUrl?: string) {
  const forceVideo = Boolean(sourceUrl && isInstagramReelUrl(sourceUrl));
  return flattenEntries(info).some((entry) => instagramEntryExpectsVideo(entry, forceVideo));
}

function videoFormats(entry: Info) {
  const maxBytes = env.MAX_UPLOAD_BYTES;
  return [...(entry.formats ?? [])]
    .filter((format) => Boolean(format.url))
    // O extrator do Instagram nem sempre preenche vcodec/video_ext nas
    // variantes retornadas por video_versions. Ausência não significa áudio.
    .filter((format) => format.vcodec !== "none")
    .filter((format) => !isImageExtension(format.ext ?? format.video_ext))
    .filter((format) => !format.height || format.height <= 1080)
    .filter((format) => {
      const size = format.filesize ?? format.filesize_approx;
      return !size || size <= maxBytes;
    })
    .sort((a, b) => {
      const mp4A = (a.ext === "mp4" || a.video_ext === "mp4") ? 1 : 0;
      const mp4B = (b.ext === "mp4" || b.video_ext === "mp4") ? 1 : 0;
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
  for (const entry of flattenEntries(info)) {
    const formats = videoFormats(entry);
    const directVideo = directVideoUrl(entry);

    if (formats.length || directVideo) {
      const urls = [directVideo, ...formats.map((format) => format.url)]
        .filter((url): url is string => Boolean(url))
        .filter((url, index, all) => all.indexOf(url) === index);
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

    // Um item identificado como vídeo sem URL/formatos contém somente a capa.
    // Nunca promovemos essa thumbnail a foto da publicação.
    if (instagramEntryExpectsVideo(entry)) continue;

    const photo = imageUrl(entry);
    if (photo && !seen.has(photo)) {
      seen.add(photo);
      items.push({ kind: "photo", url: photo, width: entry.width, height: entry.height });
    }
  }
  return items.slice(0, env.MAX_MEDIA_ITEMS);
}

async function probeInstagramRemoteMedia(url: string): Promise<DownloadedMedia> {
  const args = [
    ...await common(url),
    "--ignore-errors",
    // Essencial para posts/carrosséis de foto: o Instagram extractor do
    // yt-dlp representa imagens como entries sem formatos de vídeo.
    "--ignore-no-formats-error",
    "--skip-download",
    "--yes-playlist",
    "--no-flat-playlist",
    "--playlist-end", String(env.MAX_MEDIA_ITEMS),
    "--dump-single-json",
    url,
  ];

  let stdout = "";
  let commandError: unknown;
  try {
    const result = await execa(env.YTDLP_BINARY, args, {
      timeout: Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 45_000),
      maxBuffer: 80 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    commandError = error;
    if (error && typeof error === "object" && "stdout" in error && typeof (error as { stdout?: unknown }).stdout === "string") {
      stdout = (error as { stdout: string }).stdout;
    }
  }

  const trimmed = stdout.trim();
  let info: Info | undefined;
  if (trimmed) {
    try {
      info = JSON.parse(trimmed) as Info;
    } catch {
      // Algumas builds podem misturar uma linha informativa no stdout. O JSON
      // de --dump-single-json é o último objeto completo emitido.
      const first = trimmed.indexOf("{");
      const last = trimmed.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try { info = JSON.parse(trimmed.slice(first, last + 1)) as Info; } catch { /* tratado abaixo */ }
      }
    }
  }

  if (!info) {
    if (commandError) throw commandError;
    throw new Error("yt-dlp não gerou JSON do Instagram");
  }

  const entries = flattenEntries(info);
  const forceVideo = isInstagramReelUrl(url);
  const missingVideos = entries.filter((entry) =>
    instagramEntryExpectsVideo(entry, forceVideo) && !instagramEntryHasVideo(entry));
  if (missingVideos.length) {
    throw new Error(`Instagram identificou ${missingVideos.length} vídeo(s), mas retornou somente thumbnail; capa descartada`);
  }

  const remoteItems = instagramRemoteItemsFromInfo(info);
  if (!remoteItems.length) {
    throw new Error(`yt-dlp retornou ${entries.length} itens, mas nenhuma foto ou vídeo utilizável`);
  }

  logger.info({
    url,
    entries: flattenEntries(info).length,
    photos: remoteItems.filter((item) => item.kind === "photo").length,
    videos: remoteItems.filter((item) => item.kind === "video").length,
  }, "Instagram extraído por metadados do yt-dlp");

  return {
    files: [],
    remoteItems,
    metadata: {
      ...metadata(info, url),
      extractor: "instagram-ytdlp-json",
    },
  };
}

async function common(url: string) {
  const args = [
    "--no-warnings",
    "--no-progress",
    "--newline",
    "--retries", "3",
    "--fragment-retries", "3",
    "--socket-timeout", "20",
    "--concurrent-fragments", "4",
    "--no-check-certificates",
    "--js-runtimes", "node",
  ];
  const cookies = await cookieFileForUrl(url);
  if (cookies) args.push("--cookies", cookies);
  if (env.YTDLP_PROXY) args.push("--proxy", env.YTDLP_PROXY);
  return args;
}

function metadata(info: Info, url: string): MediaMetadata {
  const source = info.entries?.find(Boolean) ?? info;
  return {
    id: info.id ?? source.id,
    title: info.title ?? source.title,
    description: info.description ?? source.description,
    uploader: info.uploader ?? info.channel ?? source.uploader ?? source.channel,
    uploaderId: info.uploader_id ?? source.uploader_id,
    duration: info.duration ?? source.duration,
    webpageUrl: info.webpage_url ?? source.webpage_url ?? info.original_url ?? url,
    thumbnail: info.thumbnail ?? source.thumbnail,
    extractor: info.extractor_key ?? info.extractor ?? source.extractor_key ?? source.extractor,
  };
}

export async function probeMedia(url: string) {
  const result = await execa(env.YTDLP_BINARY, [
    ...await common(url),
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
    const instagram = isInstagramPostUrl(url) && mode !== "audio";
    const args = [
      ...await common(url),
      "--yes-playlist",
      "--playlist-end", String(env.MAX_MEDIA_ITEMS),
      "--restrict-filenames",
      "--trim-filenames", "120",
      "--output", template,
      "--write-info-json",
      "--max-filesize", `${Math.ceil(env.MAX_UPLOAD_MB * 2)}M`,
    ];

    if (mode === "audio") {
      args.push(
        "--no-playlist",
        "--format", "ba[ext=m4a]/ba/best",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
      );
    } else if (mode === "video") {
      args.push(
        "--no-playlist",
        "--format", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/best[height<=1080]/best",
        "--merge-output-format", "mp4",
      );
    } else {
      // No modo automático não forçamos um formato de vídeo. Essa era a causa
      // de fotos/carrosséis serem tratados como vídeo e descartados.
      args.push(
        "--ignore-errors",
        "--ignore-no-formats-error",
        "--write-thumbnail",
        "--convert-thumbnails", "jpg",
      );
    }

    if (instagram) {
      // Mantém as imagens de cada slide mesmo quando o extrator informa que
      // não há formatos de vídeo.
      args.push("--ignore-errors", "--ignore-no-formats-error", "--write-thumbnail", "--convert-thumbnails", "jpg");
    }

    args.push(url);
    logger.debug({ url, mode }, "yt-dlp");

    let commandError: unknown;
    try {
      await execa(env.YTDLP_BINARY, args, {
        timeout: env.DOWNLOAD_TIMEOUT_SECONDS * 1000,
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (error) {
      // Alguns extratores encerram com código 1 mesmo depois de gravar fotos
      // e metadados válidos. Inspecionamos o diretório antes de desistir.
      commandError = error;
    }

    const all = await walk(directory);
    let mediaMetadata: MediaMetadata = { webpageUrl: url };
    const jsonFiles = all.filter((path) => path.endsWith(".info.json"));
    const expectedVideoBases = new Set<string>();
    let expectsAnyVideo = isInstagramReelUrl(url);
    for (const infoPath of jsonFiles) {
      try {
        const parsed = JSON.parse(await readFile(infoPath, "utf8")) as Info;
        mediaMetadata = metadata(parsed, url);
        if (instagramInfoExpectsVideo(parsed, url)) expectsAnyVideo = true;
        if (!parsed.entries?.length && instagramEntryExpectsVideo(parsed, isInstagramReelUrl(url))) {
          expectedVideoBases.add(infoPath.slice(0, -".info.json".length));
        }
        if (parsed.entries?.length) break;
      } catch {
        // ignora JSON parcial
      }
    }
    if (!jsonFiles.length) {
      try { mediaMetadata = await probeMedia(url); } catch { /* ignora */ }
    }

    const ignored = new Set([".json", ".part", ".ytdl", ".temp"]);
    const files: string[] = [];
    for (const path of all) {
      if (path.endsWith(".info.json") || ignored.has(extname(path).toLowerCase())) continue;
      const fileInfo = await stat(path);
      if (fileInfo.isFile() && fileInfo.size > 0) files.push(path);
    }
    files.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));

    // Se um item possui vídeo e thumbnail com o mesmo nome-base, a thumbnail
    // é apenas capa e não deve virar uma foto extra no álbum.
    const videoExtensions = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv"]);
    const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);
    const videoFiles = files.filter((path) => videoExtensions.has(extname(path).toLowerCase()));
    const stemsWithVideo = new Set(
      videoFiles.map((path) => path.slice(0, -extname(path).length).replace(/\.(?:webp|jpg|jpeg|png)$/i, "")),
    );
    const missingExpectedVideos = [...expectedVideoBases].filter((base) => !stemsWithVideo.has(base));
    if (instagram && expectsAnyVideo && !videoFiles.length) {
      throw new Error("Instagram identificou publicação em vídeo, mas o yt-dlp baixou somente a thumbnail; capa descartada");
    }
    if (instagram && missingExpectedVideos.length) {
      throw new Error(`Instagram não baixou ${missingExpectedVideos.length} vídeo(s) do carrossel; thumbnails descartadas`);
    }

    const usableFiles = files.filter((path) => {
      const extension = extname(path).toLowerCase();
      if (!imageExtensions.has(extension)) return true;
      const stem = path.slice(0, -extension.length).replace(/\.(?:webp|jpg|jpeg|png)$/i, "");
      return !stemsWithVideo.has(stem) && !expectedVideoBases.has(stem);
    });

    if (!usableFiles.length) {
      if (commandError) throw commandError;
      throw new Error("yt-dlp não encontrou mídia utilizável");
    }
    return {
      directory,
      files: usableFiles.slice(0, env.MAX_MEDIA_ITEMS),
      metadata: mediaMetadata,
    };
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
    // Mesma prioridade do SmudgeLord: embed/scraper/GraphQL primeiro. O JSON
    // do yt-dlp é apenas fallback para imagens e carrosséis.
    if (env.INSTAGRAM_EMBED_ENABLED) {
      try {
        return await downloadInstagramMedia(url);
      } catch (error) {
        extractorErrors.push(error);
        logger.info({ url, error }, "Extração do Instagram no fluxo Smudge indisponível; tentando metadados do yt-dlp");
      }
    }
    try {
      return await probeInstagramRemoteMedia(url);
    } catch (error) {
      extractorErrors.push(error);
      logger.info({ url, error }, "Metadados completos do Instagram indisponíveis; tentando fallback convencional");
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
