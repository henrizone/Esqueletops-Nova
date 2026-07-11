import { env } from "../../config/env.js";
import { browserHeaders } from "./direct.js";
import type { DownloadedMedia, MediaMetadata, RemoteMediaItem } from "./types.js";
import { instagramCookieHeader, instagramCsrfToken } from "./cookies.js";

interface InstagramNode {
  __typename?: string;
  id?: string;
  shortcode?: string;
  dimensions?: { width?: number; height?: number };
  is_video?: boolean;
  video_url?: string;
  display_url?: string;
  display_resources?: Array<{ src?: string; config_width?: number; config_height?: number }>;
  owner?: { username?: string };
  coauthor_producers?: Array<{ username?: string }>;
  edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
  edge_sidecar_to_children?: { edges?: Array<{ node?: InstagramNode }> };
}

interface InstagramEnvelope {
  shortcode_media?: InstagramNode;
  data?: { xdt_shortcode_media?: InstagramNode };
  xdt_shortcode_media?: InstagramNode;
  status?: string;
}

const instagramHeaders: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

function requestHeaders(extra: Record<string, string> = {}) {
  const cookie = instagramCookieHeader();
  return {
    ...instagramHeaders,
    "x-ig-app-id": env.INSTAGRAM_X_IG_APP_ID,
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

export function isInstagramPostUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (host === "instagram.com" || host.endsWith(".instagram.com"))
      && /\/(?:p|reel|reels)\/[A-Za-z0-9_-]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function shortcode(rawUrl: string) {
  const match = new URL(rawUrl).pathname.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (!match?.[1]) throw new Error("Código da publicação do Instagram não encontrado");
  return match[1];
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function decodeInstagramEscapes(value: string) {
  return decodeHtml(value)
    .replace(/\\+u0026/gi, "&")
    .replace(/\\+u003c/gi, "<")
    .replace(/\\+u003e/gi, ">")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
}

function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function looksLikeMediaNode(value: unknown): value is InstagramNode {
  if (!value || typeof value !== "object") return false;
  const node = value as InstagramNode;
  return Boolean(
    node.video_url
    || node.display_url
    || node.display_resources?.some((item) => item.src)
    || node.edge_sidecar_to_children?.edges?.length,
  );
}

function deepFindMediaNode(value: unknown, depth = 0): InstagramNode | undefined {
  if (depth > 14 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["shortcode_media", "xdt_shortcode_media"]) {
    const candidate = record[key];
    if (looksLikeMediaNode(candidate)) return candidate;
  }
  if (looksLikeMediaNode(value)) return value;
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = deepFindMediaNode(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = deepFindMediaNode(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function parseJsonCandidate(raw: string): InstagramNode | undefined {
  const variants = [raw, decodeInstagramEscapes(raw)];
  for (const candidate of variants) {
    for (const suffix of ["", "}"]) {
      try {
        const parsed = JSON.parse(candidate + suffix) as InstagramEnvelope | InstagramNode;
        const envelope = parsed as InstagramEnvelope;
        const node = envelope.shortcode_media
          ?? envelope.data?.xdt_shortcode_media
          ?? envelope.xdt_shortcode_media
          ?? deepFindMediaNode(parsed);
        if (node) return node;
      } catch {
        // Tenta a próxima variante.
      }
    }
  }
  return undefined;
}

/**
 * Porta o mesmo caminho usado pelo SmudgeLord: primeiro procura o gql_data
 * serializado no HTML do /embed/captioned e depois tenta os objetos modernos.
 */
export function extractInstagramGqlData(html: string): InstagramNode | undefined {
  // Regex equivalente à usada no SmudgeLord original.
  const smudgeMatch = html.match(/\\\"gql_data\\\":([\s\S]*)\}\"\}/);
  if (smudgeMatch?.[1]) {
    const node = parseJsonCandidate(smudgeMatch[1]);
    if (node) return node;
  }

  const normalized = decodeInstagramEscapes(html);
  for (const key of ['"gql_data":', '"shortcode_media":', '"xdt_shortcode_media":']) {
    let cursor = 0;
    while (cursor < normalized.length) {
      const keyIndex = normalized.indexOf(key, cursor);
      if (keyIndex < 0) break;
      const objectStart = normalized.indexOf("{", keyIndex + key.length);
      if (objectStart < 0) break;
      const raw = balancedObject(normalized, objectStart);
      cursor = objectStart + 1;
      if (!raw) continue;
      const node = parseJsonCandidate(raw);
      if (node) return node;
    }
  }

  // O Instagram também coloca o payload em scripts application/json.
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRegex)) {
    const script = decodeHtml(match[1] ?? "").trim();
    if (!script || (!script.includes("shortcode_media") && !script.includes("xdt_shortcode_media") && !script.includes("gql_data"))) continue;
    const direct = parseJsonCandidate(script);
    if (direct) return direct;
    const firstObject = script.indexOf("{");
    if (firstObject >= 0) {
      const raw = balancedObject(script, firstObject);
      if (raw) {
        const node = parseJsonCandidate(raw);
        if (node) return node;
      }
    }
  }

  return undefined;
}

/** Fallback de imagem única portado do SmudgeLord. */
export function extractInstagramSingleImage(html: string): { node: InstagramNode; title?: string } | undefined {
  const mediaType = html.match(/data-media-type=["']([^"']+)["']/i)?.[1];
  if (mediaType && !/GraphImage|XDTGraphImage/i.test(mediaType)) return undefined;

  const contentMatch = html.match(/class=["'][^"']*Content[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i)
    ?? html.match(/class=["']Content[^"']*["'][\s\S]*?src=["']([^"']+)["']/i);
  const ogImage = metaContent(html, "og:image");
  const imageUrl = decodeHtml(contentMatch?.[1] ?? ogImage ?? "").replace(/amp;/g, "");
  if (!imageUrl) return undefined;

  const captionBlock = html.match(/class=["'][^"']*Caption[^"']*["'][\s\S]*?class=["'][^"']*CaptionUsername[^"']*["'][\s\S]*?>([^<]+)<\/a>([\s\S]*?)<div/i);
  const owner = captionBlock?.[1]?.trim();
  const caption = captionBlock?.[2]
    ? decodeHtml(captionBlock[2].replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "")).trim()
    : undefined;

  return {
    node: {
      __typename: "GraphImage",
      display_url: imageUrl.startsWith("//") ? `https:${imageUrl}` : imageUrl,
      owner: owner ? { username: owner } : undefined,
      edge_media_to_caption: caption ? { edges: [{ node: { text: caption } }] } : undefined,
    },
    title: metaContent(html, "og:title"),
  };
}

function metaContent(html: string, property: string) {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapedProperty}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escapedProperty}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return undefined;
}

function bestImage(node: InstagramNode) {
  const resources = [...(node.display_resources ?? [])]
    .filter((item) => item.src)
    .sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0));
  return resources[0]?.src ?? node.display_url;
}

export function instagramNodeRemoteItems(node: InstagramNode): RemoteMediaItem[] {
  const children = node.edge_sidecar_to_children?.edges
    ?.map((edge) => edge.node)
    .filter((child): child is InstagramNode => Boolean(child));
  const nodes = children?.length ? children : [node];
  const items: RemoteMediaItem[] = [];
  const seen = new Set<string>();
  for (const child of nodes) {
    const video = Boolean(child.is_video || child.video_url || /Video/i.test(child.__typename ?? ""));
    const url = (video ? child.video_url : bestImage(child))
      ?.replace(/\\u0026/gi, "&")
      .replace(/&amp;/gi, "&");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      kind: video ? "video" : "photo",
      url,
      width: child.dimensions?.width,
      height: child.dimensions?.height,
      thumbnailUrl: video ? bestImage(child) : undefined,
    });
  }
  return items.slice(0, env.MAX_MEDIA_ITEMS);
}

function fallbackFromMeta(html: string): { items: RemoteMediaItem[]; metadata: MediaMetadata } {
  const video = metaContent(html, "og:video") ?? metaContent(html, "og:video:url");
  const image = metaContent(html, "og:image");
  const items: RemoteMediaItem[] = video
    ? [{ url: video, kind: "video" }]
    : image
      ? [{ url: image, kind: "photo" }]
      : [];
  const description = metaContent(html, "og:description");
  const title = metaContent(html, "og:title");
  return { items, metadata: { title, description, extractor: "instagram-embed" } };
}

async function fetchEmbed(code: string): Promise<{ html: string; node?: InstagramNode }> {
  const embedUrl = `https://www.instagram.com/p/${code}/embed/captioned/`;
  const response = await fetch(embedUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
    headers: requestHeaders({ referer: "https://www.instagram.com/" }),
  });
  if (!response.ok) throw new Error(`Embed do Instagram respondeu HTTP ${response.status}`);
  const html = await response.text();
  return { html, node: extractInstagramGqlData(html) ?? extractInstagramSingleImage(html)?.node };
}

async function fetchPublicPage(code: string): Promise<{ html: string; node?: InstagramNode }> {
  const response = await fetch(`https://www.instagram.com/p/${code}/`, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
    headers: requestHeaders({ referer: "https://www.instagram.com/" }),
  });
  if (!response.ok) throw new Error(`Página do Instagram respondeu HTTP ${response.status}`);
  const html = await response.text();
  return { html, node: extractInstagramGqlData(html) ?? extractInstagramSingleImage(html)?.node };
}

async function fetchScraper(code: string): Promise<InstagramNode | undefined> {
  if (!env.INSTAGRAM_SCRAPER_URL) return undefined;
  const endpoint = new URL(env.INSTAGRAM_SCRAPER_URL);
  endpoint.searchParams.set("id", code);
  const response = await fetch(endpoint, {
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
    headers: requestHeaders({ accept: "application/json" }),
  });
  if (!response.ok) throw new Error(`Scraper do Instagram respondeu HTTP ${response.status}`);
  const payload = await response.json() as InstagramEnvelope;
  return payload.shortcode_media
    ?? payload.data?.xdt_shortcode_media
    ?? payload.xdt_shortcode_media
    ?? deepFindMediaNode(payload);
}

async function fetchGraphQl(code: string): Promise<InstagramNode | undefined> {
  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode: code,
      fetch_comment_count: 0,
      fetch_related_profile_media_count: 0,
      parent_comment_count: null,
    }),
    doc_id: "8845758582119845",
  });
  const response = await fetch("https://www.instagram.com/graphql/query", {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: requestHeaders({
      "content-type": "application/x-www-form-urlencoded",
      "x-csrftoken": instagramCsrfToken() ?? "",
      "x-fb-lsd": "AVqBX1zadbA",
      "sec-fetch-site": "same-origin",
      origin: "https://www.instagram.com",
      referer: `https://www.instagram.com/p/${code}/`,
    }),
    body,
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as InstagramEnvelope;
  return payload.data?.xdt_shortcode_media
    ?? payload.xdt_shortcode_media
    ?? payload.shortcode_media
    ?? deepFindMediaNode(payload);
}

export async function downloadInstagramMedia(rawUrl: string): Promise<DownloadedMedia> {
  const code = shortcode(rawUrl);
  let html = "";
  let node: InstagramNode | undefined;

  // Mesma ordem conceitual do SmudgeLord: embed -> GraphQL. A página pública
  // entra entre os dois para capturar payloads modernos do Instagram.
  try {
    const embed = await fetchEmbed(code);
    html = embed.html;
    node = embed.node;
  } catch {
    // Continua para os outros caminhos.
  }

  if (!node && env.INSTAGRAM_SCRAPER_URL) {
    node = await fetchScraper(code).catch(() => undefined);
  }

  if (!node) {
    try {
      const page = await fetchPublicPage(code);
      if (!html) html = page.html;
      node = page.node;
    } catch {
      // Continua para GraphQL.
    }
  }

  if (!node) node = await fetchGraphQl(code).catch(() => undefined);

  const fallback = html
    ? fallbackFromMeta(html)
    : { items: [] as RemoteMediaItem[], metadata: {} as MediaMetadata };
  const remoteItems = node ? instagramNodeRemoteItems(node) : fallback.items;
  if (!remoteItems.length) throw new Error("Instagram não retornou fotos ou vídeos");

  const caption = node?.edge_media_to_caption?.edges?.[0]?.node?.text;
  return {
    files: [],
    remoteItems,
    metadata: {
      id: node?.id ?? code,
      title: fallback.metadata.title,
      description: caption ?? fallback.metadata.description,
      uploader: node?.owner?.username,
      uploaderId: node?.owner?.username,
      webpageUrl: rawUrl,
      extractor: node ? "instagram-smudge-direct" : "instagram-meta",
    },
  };
}
