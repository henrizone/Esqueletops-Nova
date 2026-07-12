import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { escapeHtml } from "../../utils/html.js";
import { browserHeaders } from "./direct.js";
import type { DownloadedMedia, RemoteMediaItem } from "./types.js";

/**
 * Extrator dedicado de TikTok.
 *
 * Antes, todo link de TikTok caía no yt-dlp (subprocesso), que é lento: sobe um
 * processo, resolve e baixa. Aqui usamos a API pública do tikwm, que devolve em
 * JSON a URL DIRETA do MP4 (sem marca d'água) e, para posts de fotos, a lista de
 * imagens. Com a URL direta, o envio segue o mesmo caminho rápido do Twitter: o
 * próprio Telegram baixa do CDN, sem o arquivo passar pela nossa máquina.
 *
 * Se a API falhar, o chamador (downloadMedia) cai automaticamente no yt-dlp, que
 * continua como rede de segurança.
 */

interface TikwmAuthor {
  id?: string;
  unique_id?: string;
  nickname?: string;
}

interface TikwmImagePost {
  images?: string[];
}

interface TikwmData {
  id?: string;
  title?: string;
  duration?: number;
  // URLs de vídeo sem marca d'água (a melhor primeiro).
  play?: string;
  wmplay?: string;
  hdplay?: string;
  cover?: string;
  origin_cover?: string;
  author?: TikwmAuthor;
  images?: string[];
  image_post_info?: TikwmImagePost;
}

interface TikwmResponse {
  code?: number;
  msg?: string;
  data?: TikwmData | null;
}

const TIKTOK_HOSTS = [
  "tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "m.tiktok.com",
];

export function isTikTokUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return TIKTOK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

function tiktokProfileUrl(uniqueId?: string): string | undefined {
  if (!uniqueId) return undefined;
  return `https://www.tiktok.com/@${encodeURIComponent(uniqueId)}`;
}

function displayAuthor(author?: TikwmAuthor) {
  return {
    name: author?.nickname?.trim() || author?.unique_id?.trim() || "TikTok",
    username: author?.unique_id?.trim().replace(/^@/, "") || undefined,
  };
}

function buildTikTokCaption(data: TikwmData): string | undefined {
  const author = displayAuthor(data.author);
  const profile = tiktokProfileUrl(author.username);
  const namePart = profile
    ? `<a href="${escapeHtml(profile)}">${escapeHtml(author.name)}</a>`
    : escapeHtml(author.name);
  const title = data.title?.trim();
  const titlePart = title ? `\n\n${escapeHtml(title)}` : "";
  return `${namePart}${titlePart}`;
}

/** Deduplica preservando a ordem (melhor -> pior). */
function unique(urls: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function remoteItemsFromData(data: TikwmData): RemoteMediaItem[] {
  // Post de fotos (carrossel de imagens).
  const images = data.image_post_info?.images ?? data.images ?? [];
  if (images.length) {
    return images
      .filter((url): url is string => Boolean(url))
      .map((url) => ({ url, kind: "photo" as const }));
  }

  // Vídeo sem marca d'água. Preferimos `play` (qualidade padrão, JÁ pronto no
  // tikwm = rápido) em vez de `hdplay` (HD gerado sob demanda = mais lento).
  // O SmudgeLord também prioriza velocidade aqui. `hdplay` fica como fallback
  // (melhor qualidade se o play falhar) e `wmplay` (com marca) como último caso.
  const videoUrls = unique([data.play, data.hdplay, data.wmplay]);
  if (!videoUrls.length) return [];

  const [primary, ...fallbacks] = videoUrls;
  return [
    {
      url: primary!,
      kind: "video",
      thumbnailUrl: data.origin_cover || data.cover,
      duration: data.duration,
      fallbackUrls: fallbacks.length ? fallbacks : undefined,
    },
  ];
}

async function fetchTikwm(rawUrl: string): Promise<TikwmData> {
  const endpoint = new URL(env.TIKTOK_API_URL);
  endpoint.searchParams.set("url", rawUrl);
  // Sem hd=1: pedir HD faz o tikwm gerar o arquivo sob demanda (lento). Como
  // priorizamos o `play` (já pronto), a resposta vem bem mais rápido.

  const response = await fetch(endpoint.toString(), {
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(env.DOWNLOAD_TIMEOUT_SECONDS * 1000, 20_000)),
    headers: {
      ...browserHeaders,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`API do TikTok respondeu HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TikwmResponse;
  if (payload.code !== 0 || !payload.data) {
    throw new Error(`API do TikTok não retornou mídia: ${payload.msg ?? "resposta vazia"}`);
  }
  return payload.data;
}

export async function downloadTikTokMedia(rawUrl: string): Promise<DownloadedMedia> {
  const data = await fetchTikwm(rawUrl);
  const remoteItems = remoteItemsFromData(data);

  if (!remoteItems.length) {
    throw new Error("TikTok não retornou vídeo nem fotos");
  }

  const author = displayAuthor(data.author);
  logger.debug({ url: rawUrl, items: remoteItems.length }, "TikTok resolvido via tikwm");

  return {
    files: [],
    remoteItems,
    metadata: {
      id: data.id,
      title: data.title,
      description: data.title,
      uploader: author.name,
      uploaderId: author.username,
      profileUrl: tiktokProfileUrl(author.username),
      duration: data.duration,
      thumbnail: data.origin_cover || data.cover,
      webpageUrl: rawUrl,
      extractor: "tiktok-tikwm",
      captionHtml: buildTikTokCaption(data),
    },
  };
}