import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sanitizeFilename from "sanitize-filename";
import { env } from "../../config/env.js";

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
};

export const browserHeaders = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
};

export async function createMediaTempDirectory(prefix: string) {
  return mkdtemp(join(tmpdir(), prefix));
}

function extensionFor(url: string, contentType: string | null, fallback: string) {
  const fromMime = contentType ? MIME_EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] : undefined;
  if (fromMime) return fromMime;
  try {
    const extension = extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/i.test(extension)) return extension;
  } catch {
    // URL inválida será tratada pelo fetch.
  }
  return fallback;
}

export async function downloadDirectFile(input: {
  url: string;
  directory: string;
  index: number;
  basename: string;
  fallbackExtension: string;
  referer?: string;
}): Promise<string> {
  const response = await fetch(input.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 90_000)),
    headers: {
      ...browserHeaders,
      accept: "*/*",
      ...(input.referer ? { referer: input.referer } : {}),
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Falha ao baixar mídia direta: HTTP ${response.status}`);
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  const hardLimit = Math.ceil(env.MAX_UPLOAD_BYTES * 2);
  if (declaredSize > hardLimit) throw new Error("Mídia excede o limite de download");

  const extension = extensionFor(response.url || input.url, response.headers.get("content-type"), input.fallbackExtension);
  const safeBase = sanitizeFilename(input.basename).slice(0, 90) || "media";
  const path = join(input.directory, `${String(input.index + 1).padStart(2, "0")}-${safeBase}${extension}`);
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > hardLimit) callback(new Error("Mídia excede o limite de download"));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(path));
  if ((await stat(path)).size <= 0) throw new Error("Arquivo de mídia vazio");
  return path;
}

export async function cleanupDirectory(directory: string) {
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
