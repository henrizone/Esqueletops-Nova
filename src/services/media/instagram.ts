import { env } from "../../config/env.js";
import { browserHeaders } from "./direct.js";
import type { DownloadedMedia, MediaMetadata, RemoteMediaItem } from "./types.js";

interface InstagramNode {
  __typename?: string;
  id?: string;
  shortcode?: string;
  is_video?: boolean;
  video_url?: string;
  display_url?: string;
  display_resources?: Array<{ src?: string; config_width?: number }>;
  owner?: { username?: string };
  coauthor_producers?: Array<{ username?: string }>;
  edge_media_to_caption?: { edges?: Array<{ node?: { text?: string } }> };
  edge_sidecar_to_children?: { edges?: Array<{ node?: InstagramNode }> };
}

interface InstagramEnvelope {
  shortcode_media?: InstagramNode;
  data?: { xdt_shortcode_media?: InstagramNode };
  xdt_shortcode_media?: InstagramNode;
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

export function extractInstagramGqlData(html: string): InstagramNode | undefined {
  const normalized = html
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\+u0026/gi, "&")
    .replace(/\\&/g, "&");
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
      try {
        const parsed = JSON.parse(raw) as InstagramEnvelope | InstagramNode;
        if (key === '"shortcode_media":' || key === '"xdt_shortcode_media":') return parsed as InstagramNode;
        const envelope = parsed as InstagramEnvelope;
        const node = envelope.shortcode_media ?? envelope.data?.xdt_shortcode_media ?? envelope.xdt_shortcode_media;
        if (node) return node;
      } catch {
        // Tenta a próxima ocorrência.
      }
    }
  }
  return undefined;
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

function nodeRemoteItems(node: InstagramNode): RemoteMediaItem[] {
  const children = node.edge_sidecar_to_children?.edges
    ?.map((edge) => edge.node)
    .filter((child): child is InstagramNode => Boolean(child));
  const nodes = children?.length ? children : [node];
  const items: RemoteMediaItem[] = [];
  const seen = new Set<string>();
  for (const child of nodes) {
    const video = Boolean(child.is_video || child.video_url || /Video/i.test(child.__typename ?? ""));
    const url = (video ? child.video_url : bestImage(child))?.replace(/\\u0026/gi, "&");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({ kind: video ? "video" : "photo", url });
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
    headers: { ...browserHeaders, referer: "https://www.instagram.com/" },
  });
  if (!response.ok) throw new Error(`Embed do Instagram respondeu HTTP ${response.status}`);
  const html = await response.text();
  return { html, node: extractInstagramGqlData(html) };
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
    headers: {
      ...browserHeaders,
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded",
      "x-ig-app-id": "936619743392459",
      "x-fb-lsd": "AVqBX1zadbA",
      "sec-fetch-site": "same-origin",
      origin: "https://www.instagram.com",
      referer: `https://www.instagram.com/p/${code}/`,
    },
    body,
  });
  if (!response.ok) return undefined;
  const payload = await response.json() as InstagramEnvelope;
  return payload.data?.xdt_shortcode_media ?? payload.xdt_shortcode_media ?? payload.shortcode_media;
}

export async function downloadInstagramMedia(rawUrl: string): Promise<DownloadedMedia> {
  const code = shortcode(rawUrl);
  let html = "";
  let node: InstagramNode | undefined;

  try {
    const embed = await fetchEmbed(code);
    html = embed.html;
    node = embed.node;
  } catch {
    // O GraphQL abaixo ainda pode funcionar quando o embed é bloqueado.
  }

  if (!node) node = await fetchGraphQl(code).catch(() => undefined);
  const fallback = html ? fallbackFromMeta(html) : { items: [] as RemoteMediaItem[], metadata: {} as MediaMetadata };
  const remoteItems = node ? nodeRemoteItems(node) : fallback.items;
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
      extractor: node ? "instagram-direct" : "instagram-meta",
    },
  };
}
