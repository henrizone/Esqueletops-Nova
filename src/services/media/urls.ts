import { createHash } from "node:crypto";
import { env } from "../../config/env.js";

const defaults = [
  "instagram.com",
  "tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "x.com",
  "twitter.com",
  "reddit.com",
  "redd.it",
  "v.redd.it",
  "threads.net",
  "threads.com",
  "bsky.app",
  "pinterest.com",
  "pin.it",
  "substack.com",
  "xiaohongshu.com",
  "xhslink.com",
  "youtube.com",
  "youtu.be",
];
const allowed = new Set([...defaults, ...env.EXTRA_ALLOWED_DOMAINS]);

export function extractUrls(text?: string) {
  if (!text) return [];
  const set = new Set<string>();
  for (const match of text.match(/https?:\/\/[^\s<>"']+/gi) ?? []) {
    try {
      const url = new URL(match.replace(/[),.;!?\]}]+$/g, ""));
      if (["http:", "https:"].includes(url.protocol)) set.add(url.toString());
    } catch {
      // Ignora URL inválida.
    }
  }
  return [...set];
}

export function isAllowedMediaUrl(raw: string) {
  if (env.ALLOW_GENERIC_URLS) return true;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    for (const domain of allowed) {
      const normalized = domain.replace(/^\*\./, "");
      if (host === normalized || host.endsWith(`.${normalized}`)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isYouTubeUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}


export function canonicalYouTubeUrl(raw: string) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  let id = "";
  if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? "";
  else if (host === "youtube.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
    else {
      const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/i);
      id = match?.[1] ?? "";
    }
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw new Error("Link do YouTube inválido ou incompleto");
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

export function isYouTubeShortsUrl(raw: string) {
  try {
    const url = new URL(raw);
    return ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname.toLowerCase())
      && /^\/shorts\/[A-Za-z0-9_-]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Mesma regra do SmudgeLord: vídeos normais do YouTube não são baixados ao
 * colar o link; eles passam pelo /ytdl. Apenas Shorts entram no automático.
 */
export function isAutoMediaUrl(raw: string) {
  return !isYouTubeUrl(raw) || isYouTubeShortsUrl(raw);
}

export function normalizeUrl(raw: string) {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith("utm_") || ["igsh", "igshid", "si", "ref", "source"].includes(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

export const mediaCacheKey = (url: string, mode: string) => createHash("sha256")
  .update(`v8:${mode}:${normalizeUrl(url)}`)
  .digest("hex");
