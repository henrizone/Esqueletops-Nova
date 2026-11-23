import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { DownloadedMedia, MediaMetadata, RemoteMediaItem } from "./types.js";
import { instagramCookieHeader, instagramCsrfToken } from "./cookies.js";

interface InstagramNode {
  __typename?: string;
  id?: string;
  shortcode?: string;
  dimensions?: { width?: number; height?: number };
  is_video?: boolean;
  video_url?: string;
  video_duration?: number;
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

/** Token usado pelo SmudgeLord quando não há cookie de sessão configurado. */
const ANONYMOUS_CSRF_TOKEN = "JKA19cNYckTn_Dr6bcTO5F";

function requestHeaders(extra: Record<string, string> = {}) {
  const cookie = instagramCookieHeader();
  return {
    ...instagramHeaders,
    "x-ig-app-id": env.INSTAGRAM_X_IG_APP_ID,
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

const POST_PATH = /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
const SHARE_PATH = /^\/share\/(?:(?:p|reel|reels|tv)\/)?[A-Za-z0-9_-]+/i;

function instagramUrl(rawUrl: string): URL | undefined {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return host === "instagram.com" || host.endsWith(".instagram.com") ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Links "compartilhar" (/share/...) não carregam o shortcode: precisam ser resolvidos. */
export function isInstagramShareUrl(rawUrl: string) {
  const url = instagramUrl(rawUrl);
  return Boolean(url && SHARE_PATH.test(url.pathname));
}

export function isInstagramPostUrl(rawUrl: string) {
  const url = instagramUrl(rawUrl);
  return Boolean(url && (SHARE_PATH.test(url.pathname) || POST_PATH.test(url.pathname)));
}

export function isInstagramReelUrl(rawUrl: string) {
  try {
    return /\/(?:reel|reels|tv)\/[A-Za-z0-9_-]+/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

export function instagramShortcode(rawUrl: string) {
  const url = new URL(rawUrl);
  const match = SHARE_PATH.test(url.pathname) ? null : url.pathname.match(POST_PATH);
  if (!match?.[1]) throw new Error("Código da publicação do Instagram não encontrado");
  return match[1];
}

/**
 * Segue o redirecionamento de um link /share/ até a URL canônica (/p/ ou
 * /reel/). Quando o Instagram devolve a tela de login, o destino real vem no
 * parâmetro `next`.
 */
export async function resolveInstagramShareUrl(rawUrl: string): Promise<string> {
  if (!isInstagramShareUrl(rawUrl)) return rawUrl;
  const response = await fetch(rawUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(env.INSTAGRAM_ATTEMPT_TIMEOUT_MS * 2),
    headers: requestHeaders({ referer: "https://www.instagram.com/" }),
  });
  await response.body?.cancel().catch(() => undefined);
  const candidates = [response.url];
  try {
    const next = new URL(response.url).searchParams.get("next");
    if (next) candidates.push(new URL(next, "https://www.instagram.com").toString());
  } catch {
    // URL final inválida: tratada abaixo.
  }
  for (const candidate of candidates) {
    const url = instagramUrl(candidate);
    const match = url && !SHARE_PATH.test(url.pathname) ? url.pathname.match(POST_PATH) : null;
    if (match?.[0]) return `https://www.instagram.com${match[0]}/`;
  }
  throw new Error("Não foi possível resolver o link de compartilhamento do Instagram");
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

function nodeFromEnvelope(payload: unknown): InstagramNode | undefined {
  const envelope = payload as InstagramEnvelope;
  return envelope?.shortcode_media
    ?? envelope?.data?.xdt_shortcode_media
    ?? envelope?.xdt_shortcode_media
    ?? deepFindMediaNode(payload);
}

function parseJsonCandidate(raw: string): InstagramNode | undefined {
  const variants = [raw, decodeInstagramEscapes(raw)];
  for (const candidate of variants) {
    for (const suffix of ["", "}"]) {
      try {
        const node = nodeFromEnvelope(JSON.parse(candidate + suffix));
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

/**
 * Detecta somente sinais fortes de que a publicação é vídeo. Não usamos
 * ocorrências genéricas de "video_url" em scripts globais, pois isso pode
 * transformar uma foto normal em falso positivo.
 */
export function instagramPageExpectsVideo(rawUrl: string, html: string) {
  if (isInstagramReelUrl(rawUrl)) return true;
  const ogType = metaContent(html, "og:type") ?? "";
  const ogTitle = metaContent(html, "og:title") ?? "";
  return Boolean(
    metaContent(html, "og:video")
    || metaContent(html, "og:video:url")
    || /^video(?:\.|$)/i.test(ogType)
    || /^video by\b/i.test(ogTitle.trim())
    || /data-media-type=["'](?:GraphVideo|XDTGraphVideo)["']/i.test(html)
    || /<video\b/i.test(html)
  );
}

function bestImage(node: InstagramNode) {
  const resources = [...(node.display_resources ?? [])]
    .filter((item) => item.src)
    .sort((a, b) => (b.config_width ?? 0) - (a.config_width ?? 0));
  return resources[0]?.src ?? node.display_url;
}

function mediaNodes(node: InstagramNode): InstagramNode[] {
  const children = node.edge_sidecar_to_children?.edges
    ?.map((edge) => edge.node)
    .filter((child): child is InstagramNode => Boolean(child));
  return children?.length ? children : [node];
}

function nodeIsVideo(node: InstagramNode) {
  return Boolean(node.is_video || node.video_url || /Video/i.test(node.__typename ?? ""));
}

function cleanCdnUrl(url?: string) {
  return url?.replace(/\\u0026/gi, "&").replace(/&amp;/gi, "&");
}

/**
 * Um nó só é aceito quando TODAS as mídias têm URL utilizável. O embed às
 * vezes devolve vídeos sem `video_url`; antes esses itens eram descartados em
 * silêncio e o carrossel chegava incompleto. Agora o nó incompleto é rejeitado
 * para que a próxima fonte (GraphQL, yt-dlp...) entregue a publicação inteira.
 */
export function instagramNodeIsComplete(node: InstagramNode): boolean {
  const nodes = mediaNodes(node);
  return nodes.length > 0
    && nodes.every((child) => Boolean(nodeIsVideo(child) ? child.video_url : bestImage(child)));
}

export function instagramNodeRemoteItems(node: InstagramNode): RemoteMediaItem[] {
  const items: RemoteMediaItem[] = [];
  const seen = new Set<string>();
  for (const child of mediaNodes(node)) {
    const video = nodeIsVideo(child);
    const url = cleanCdnUrl(video ? child.video_url : bestImage(child));
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      kind: video ? "video" : "photo",
      url,
      width: child.dimensions?.width,
      height: child.dimensions?.height,
      duration: video && child.video_duration ? child.video_duration : undefined,
      thumbnailUrl: video ? cleanCdnUrl(bestImage(child)) : undefined,
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

async function fetchHtml(url: string, label: string): Promise<{ html: string; node?: InstagramNode }> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(env.INSTAGRAM_ATTEMPT_TIMEOUT_MS),
    headers: requestHeaders({ referer: "https://www.instagram.com/" }),
  });
  if (!response.ok) throw new Error(`${label} do Instagram respondeu HTTP ${response.status}`);
  const html = await response.text();
  return { html, node: extractInstagramGqlData(html) };
}

const fetchEmbed = (code: string) => fetchHtml(`https://www.instagram.com/p/${code}/embed/captioned/`, "Embed");
const fetchPublicPage = (code: string) => fetchHtml(`https://www.instagram.com/p/${code}/`, "Página");

async function fetchScraper(code: string): Promise<InstagramNode | undefined> {
  if (!env.INSTAGRAM_SCRAPER_URL) return undefined;
  const endpoint = new URL(env.INSTAGRAM_SCRAPER_URL);
  endpoint.searchParams.set("id", code);
  const response = await fetch(endpoint, {
    redirect: "follow",
    signal: AbortSignal.timeout(Math.round(env.INSTAGRAM_ATTEMPT_TIMEOUT_MS * 1.5)),
    headers: requestHeaders({ accept: "application/json" }),
  });
  if (!response.ok) throw new Error(`Scraper do Instagram respondeu HTTP ${response.status}`);
  return nodeFromEnvelope(await response.json());
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
    signal: AbortSignal.timeout(Math.round(env.INSTAGRAM_ATTEMPT_TIMEOUT_MS * 1.5)),
    headers: requestHeaders({
      "content-type": "application/x-www-form-urlencoded",
      // Sem cookie de sessão o Instagram exige um CSRF qualquer não vazio;
      // antes era enviado em branco e a consulta anônima era recusada.
      "x-csrftoken": instagramCsrfToken() ?? ANONYMOUS_CSRF_TOKEN,
      "x-fb-lsd": "AVqBX1zadbA",
      "sec-fetch-site": "same-origin",
      origin: "https://www.instagram.com",
      referer: `https://www.instagram.com/p/${code}/`,
    }),
    body,
  });
  if (!response.ok) throw new Error(`GraphQL do Instagram respondeu HTTP ${response.status}`);
  return nodeFromEnvelope(await response.json());
}

type NodeAttempt = () => Promise<InstagramNode | undefined>;

/**
 * Requisições "hedged": a primeira fonte começa na hora; se ela demorar mais
 * que `delayMs` (ou falhar), a próxima já é disparada em paralelo. Vence a
 * primeira que devolver um nó completo. Isso elimina a espera em série de
 * vários timeouts sem dobrar o número de requisições no caso comum.
 */
export async function firstCompleteNode(attempts: NodeAttempt[], delayMs: number): Promise<InstagramNode | undefined> {
  if (!attempts.length) return undefined;
  return new Promise((resolve) => {
    let next = 0;
    let pending = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (node?: InstagramNode) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(node);
    };

    const launch = () => {
      if (done || next >= attempts.length) return;
      const attempt = attempts[next]!;
      next += 1;
      pending += 1;
      if (timer) clearTimeout(timer);
      if (next < attempts.length) timer = setTimeout(launch, delayMs);
      attempt()
        .then((node) => (node && instagramNodeIsComplete(node) ? node : undefined), () => undefined)
        .then((node) => {
          pending -= 1;
          if (node) finish(node);
          else if (next < attempts.length) launch();
          else if (pending === 0) finish();
        });
    };

    launch();
  });
}

export async function downloadInstagramMedia(rawUrl: string): Promise<DownloadedMedia> {
  const code = instagramShortcode(rawUrl);
  let html = "";

  // Mesma ordem do SmudgeLord (embed -> GraphQL), mas sem esperar o timeout de
  // uma fonte para começar a outra. A página pública fica por último.
  const attempts: NodeAttempt[] = [
    async () => {
      const embed = await fetchEmbed(code);
      html = embed.html;
      return embed.node;
    },
    () => fetchGraphQl(code),
  ];
  if (env.INSTAGRAM_SCRAPER_URL) attempts.push(() => fetchScraper(code));
  attempts.push(async () => {
    const page = await fetchPublicPage(code);
    if (!html) html = page.html;
    return page.node;
  });

  const node = await firstCompleteNode(attempts, env.INSTAGRAM_HEDGE_DELAY_MS);

  let remoteItems = node ? instagramNodeRemoteItems(node) : [];
  let selectedNode = node;
  let extractor = "instagram-smudge-direct";
  let fallback: { items: RemoteMediaItem[]; metadata: MediaMetadata } = { items: [], metadata: {} };
  let singleImageTitle: string | undefined;

  if (!node) {
    // Sem JSON estruturado só é seguro usar o HTML quando a publicação é de
    // mídia única. Em carrossel, og:image traz apenas o primeiro slide: enviar
    // isso seria entregar a publicação pela metade. Melhor falhar aqui e
    // deixar o yt-dlp/gallery-dl buscarem o álbum completo.
    if (/data-media-type=["'](?:GraphSidecar|XDTGraphSidecar)["']/i.test(html)) {
      throw new Error("Embed do Instagram não trouxe os itens do carrossel");
    }
    const expectsVideo = html ? instagramPageExpectsVideo(rawUrl, html) : isInstagramReelUrl(rawUrl);
    if (html) fallback = fallbackFromMeta(html);
    remoteItems = fallback.items;
    extractor = "instagram-meta";

    // O embed de Reel costuma trazer somente og:image/thumbnail. Quando a URL
    // ou o HTML indicam vídeo, uma resposta contendo apenas fotos é rejeitada
    // para que o fluxo avance ao yt-dlp e obtenha o MP4 real.
    if (expectsVideo && !remoteItems.some((item) => item.kind === "video")) {
      throw new Error("Instagram retornou apenas a capa de uma publicação em vídeo");
    }

    // Parser visual do SmudgeLord: último recurso para uma foto verdadeira.
    if (!remoteItems.length && html) {
      const singleImage = extractInstagramSingleImage(html);
      if (singleImage) {
        selectedNode = singleImage.node;
        singleImageTitle = singleImage.title;
        remoteItems = instagramNodeRemoteItems(singleImage.node);
        extractor = "instagram-smudge-image-fallback";
      }
    }
  }

  if (!remoteItems.length) throw new Error("Instagram não retornou fotos ou vídeos");

  const caption = selectedNode?.edge_media_to_caption?.edges?.[0]?.node?.text;
  const username = selectedNode?.owner?.username;
  logger.debug({ url: rawUrl, extractor, items: remoteItems.length }, "Instagram resolvido");
  return {
    files: [],
    remoteItems,
    metadata: {
      id: selectedNode?.id ?? code,
      title: fallback.metadata.title ?? singleImageTitle,
      description: caption ?? fallback.metadata.description,
      uploader: username ?? fallback.metadata.uploader,
      uploaderId: username ?? fallback.metadata.uploaderId,
      profileUrl: username
        ? `https://www.instagram.com/${encodeURIComponent(username)}/`
        : fallback.metadata.profileUrl,
      webpageUrl: rawUrl,
      extractor,
    },
  };
}
