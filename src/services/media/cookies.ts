import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../../config/env.js";

const filePromises = new Map<string, Promise<string>>();

function decodeBase64(value?: string) {
  if (!value) return undefined;
  try {
    const text = Buffer.from(value, "base64").toString("utf8");
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

function normalizedHost(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function cookieBase64ForUrl(rawUrl: string) {
  const host = normalizedHost(rawUrl);
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    return env.YOUTUBE_COOKIES_B64 ?? env.YTDLP_COOKIES_B64;
  }
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    return env.INSTAGRAM_COOKIES_B64 ?? env.YTDLP_COOKIES_B64;
  }
  return env.YTDLP_COOKIES_B64;
}

export async function cookieFileForUrl(rawUrl: string) {
  const b64 = cookieBase64ForUrl(rawUrl);
  if (!b64) return undefined;
  const host = normalizedHost(rawUrl) || "generic";
  const key = `${host}:${b64.length}:${b64.slice(0, 24)}`;
  let promise = filePromises.get(key);
  if (!promise) {
    promise = (async () => {
      const safeHost = host.replace(/[^a-z0-9.-]+/gi, "-");
      const path = join(tmpdir(), `esqueletops-nova-cookies-${safeHost}.txt`);
      const contents = Buffer.from(b64, "base64");
      if (!contents.length) throw new Error(`Cookies inválidos para ${host}`);
      await writeFile(path, contents, { mode: 0o600 });
      return path;
    })();
    filePromises.set(key, promise);
  }
  return promise;
}

export function netscapeCookieHeader(cookieText: string, domain: string) {
  const now = Math.floor(Date.now() / 1000);
  const wanted = domain.toLowerCase().replace(/^\./, "");
  const pairs: string[] = [];
  for (const originalLine of cookieText.split(/\r?\n/)) {
    let line = originalLine.trim();
    if (!line) continue;
    if (line.startsWith("#HttpOnly_")) line = line.slice("#HttpOnly_".length);
    else if (line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [cookieDomain, , , , expiresRaw, name, ...valueParts] = fields;
    if (!cookieDomain || !name) continue;
    const cleanDomain = cookieDomain.toLowerCase().replace(/^\./, "");
    if (!(cleanDomain === wanted || cleanDomain.endsWith(`.${wanted}`) || wanted.endsWith(`.${cleanDomain}`))) continue;
    const expires = Number(expiresRaw);
    if (Number.isFinite(expires) && expires > 0 && expires < now) continue;
    pairs.push(`${name}=${valueParts.join("\t")}`);
  }
  return pairs.length ? pairs.join("; ") : undefined;
}

export function instagramCookieHeader() {
  if (env.INSTAGRAM_COOKIE) return env.INSTAGRAM_COOKIE;
  const text = decodeBase64(env.INSTAGRAM_COOKIES_B64 ?? env.YTDLP_COOKIES_B64);
  return text ? netscapeCookieHeader(text, "instagram.com") : undefined;
}

export function instagramCsrfToken() {
  const header = instagramCookieHeader();
  if (!header) return undefined;
  for (const part of header.split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    if (part.slice(0, index) === "csrftoken") return part.slice(index + 1);
  }
  return undefined;
}

export function cookieConfigurationStatus() {
  return {
    youtube: Boolean(env.YOUTUBE_COOKIES_B64 ?? env.YTDLP_COOKIES_B64),
    instagram: Boolean(env.INSTAGRAM_COOKIE ?? env.INSTAGRAM_COOKIES_B64 ?? env.YTDLP_COOKIES_B64),
    generic: Boolean(env.YTDLP_COOKIES_B64),
  };
}
