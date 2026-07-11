import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { execa } from "execa";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { DownloadMode, MediaMetadata } from "./types.js";
import { downloadWithGalleryDl } from "./gallerydl.js";
import { downloadInstagramMedia, isInstagramPostUrl } from "./instagram.js";
import { downloadTwitterMedia, isTwitterStatusUrl } from "./twitter.js";

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
  entries?: Info[];
}

let cookiePromise: Promise<string | undefined> | undefined;

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

async function downloadWithYtDlp(url: string, mode: DownloadMode) {
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

export async function downloadMedia(url: string, mode: DownloadMode) {
  if (mode !== "audio" && isTwitterStatusUrl(url)) {
    // O extrator dedicado seleciona somente as mídias do tweet principal e
    // mantém o tweet citado apenas como texto. O yt-dlp não garante isso.
    return downloadTwitterMedia(url);
  }

  const extractorErrors: unknown[] = [];
  if (mode !== "audio" && env.INSTAGRAM_EMBED_ENABLED && isInstagramPostUrl(url)) {
    try {
      return await downloadInstagramMedia(url);
    } catch (error) {
      extractorErrors.push(error);
      logger.info({ url, error }, "Embed do Instagram indisponível; tentando yt-dlp");
    }
  }

  try {
    return await downloadWithYtDlp(url, mode);
  } catch (ytDlpError) {
    extractorErrors.push(ytDlpError);
    if (mode === "audio" || !env.GALLERYDL_ENABLED) {
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
