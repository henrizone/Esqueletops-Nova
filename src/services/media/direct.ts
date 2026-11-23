import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import PQueue from "p-queue";
import sanitizeFilename from "sanitize-filename";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { RemoteMediaItem } from "./types.js";

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

const DOWNLOAD_ATTEMPTS_PER_URL = 2;

/**
 * Baixa as mídias remotas para o disco (Instagram e CDNs que o Telegram não
 * consegue buscar sozinho). Os downloads rodam em paralelo com concorrência
 * limitada — disparar 20 conexões de uma vez fazia o CDN recusar algumas — e
 * cada URL é tentada mais de uma vez antes de o item ser dado como perdido.
 * `failed` informa quantos itens não puderam ser baixados.
 */
export async function materializeRemoteItems(
  items: RemoteMediaItem[],
  sourceUrl: string,
): Promise<{ directory: string; files: string[]; failed: number }> {
  const directory = await createMediaTempDirectory("esqueletops-nova-remote-");
  const queue = new PQueue({ concurrency: env.REMOTE_DOWNLOAD_CONCURRENCY });
  try {
    const results = await Promise.allSettled(items.map((item, index) => queue.add(async () => {
      const urls = [item.url, ...(item.fallbackUrls ?? [])]
        .filter((url, position, all) => all.indexOf(url) === position);
      let lastError: unknown;
      for (const url of urls) {
        for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS_PER_URL; attempt += 1) {
          try {
            return await downloadDirectFile({
              url,
              directory,
              index,
              basename: `media-${index + 1}`,
              fallbackExtension: item.kind === "video" ? ".mp4" : ".jpg",
              referer: sourceUrl,
            });
          } catch (error) {
            lastError = error;
            if (attempt < DOWNLOAD_ATTEMPTS_PER_URL) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
          }
        }
      }
      throw lastError ?? new Error("Não foi possível baixar a mídia remota");
    })));

    const files = results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (!files.length) throw new AggregateError(errors, "Nenhuma mídia remota pôde ser baixada");
    if (errors.length) {
      logger.warn({ url: sourceUrl, failed: errors.length, total: items.length, error: errors[0] }, "Parte das mídias remotas não pôde ser baixada");
    }
    return { directory, files, failed: errors.length };
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}
