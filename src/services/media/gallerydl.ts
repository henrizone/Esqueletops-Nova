import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { execa } from "execa";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { MediaMetadata } from "./types.js";

let cookiePromise: Promise<string | undefined> | undefined;

async function cookieFile() {
  if (!env.YTDLP_COOKIES_B64) return undefined;
  cookiePromise ??= (async () => {
    const path = join(tmpdir(), "esqueletops-nova-cookies.txt");
    await writeFile(path, Buffer.from(env.YTDLP_COOKIES_B64!, "base64"), { mode: 0o600 });
    return path;
  })();
  return cookiePromise;
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

function firstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (candidate && typeof candidate === "object") {
      const nested = firstString(candidate, keys);
      if (nested) return nested;
    }
  }
  for (const candidate of Object.values(record)) {
    if (candidate && typeof candidate === "object") {
      const nested = firstString(candidate, keys);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function metadataFromFiles(paths: string[], url: string): Promise<MediaMetadata> {
  for (const path of paths.filter((item) => item.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      return {
        id: firstString(parsed, ["post_id", "shortcode", "tweet_id", "id"]),
        title: firstString(parsed, ["title", "headline"]),
        description: firstString(parsed, ["description", "caption", "content", "text"]),
        uploader: firstString(parsed, ["username", "uploader", "author", "user", "owner"]),
        webpageUrl: firstString(parsed, ["post_url", "webpage_url", "permalink"]) ?? url,
        extractor: "gallery-dl",
      };
    } catch {
      // Um arquivo de metadados inválido não deve impedir o envio das mídias.
    }
  }
  return { webpageUrl: url, extractor: "gallery-dl" };
}

export async function downloadWithGalleryDl(url: string) {
  if (!env.GALLERYDL_ENABLED) throw new Error("gallery-dl desabilitado");
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-gallery-"));
  const args = [
    "--config-ignore",
    "--no-input",
    "--no-colors",
    "--no-part",
    "--no-mtime",
    "--retries", "1",
    "-o", "extractor.instagram.sleep-429=null",
    "--http-timeout", "20",
    "--range", `1-${env.MAX_MEDIA_ITEMS}`,
    "--filesize-max", `${Math.ceil(env.MAX_UPLOAD_MB * 2)}M`,
    "--write-info-json",
    "--directory", directory,
  ];
  const cookies = await cookieFile();
  if (cookies) args.push("--cookies", cookies);
  if (env.YTDLP_PROXY) args.push("--proxy", env.YTDLP_PROXY);
  args.push(url);

  logger.debug({ url }, "gallery-dl");
  await execa(env.GALLERYDL_BINARY, args, {
    timeout: Math.min(env.DOWNLOAD_TIMEOUT_SECONDS, 60) * 1000,
    maxBuffer: 50 * 1024 * 1024,
  });

  const all = await walk(directory);
  const metadata = await metadataFromFiles(all, url);
  const ignored = new Set([".json", ".part", ".txt", ".log"]);
  const files: string[] = [];
  for (const path of all) {
    if (ignored.has(extname(path).toLowerCase())) continue;
    const info = await stat(path);
    if (info.isFile() && info.size > 0) files.push(path);
  }
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) throw new Error("gallery-dl não encontrou imagens ou vídeos");
  return { directory, files: files.slice(0, env.MAX_MEDIA_ITEMS), metadata };
}
