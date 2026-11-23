import { cacheGetJson, cacheSetJson } from "../../cache/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { DownloadedMedia, MediaArticlePart, RemoteMediaItem } from "./types.js";

/* ------------------------------------------------------------------------ */
/* Formatos de origem                                                        */
/* ------------------------------------------------------------------------ */

interface FxAuthor {
  name?: string;
  screen_name?: string;
}

interface FxFormat {
  url?: string;
  bitrate?: number;
  container?: string;
}

interface FxMediaItem {
  url?: string;
  thumbnail_url?: string;
  type?: string;
  width?: number;
  height?: number;
  duration?: number;
  formats?: FxFormat[];
}

interface FxMedia {
  all?: FxMediaItem[];
  photos?: FxMediaItem[];
  videos?: FxMediaItem[];
  gifs?: FxMediaItem[];
}

export interface FxTweet {
  id?: string;
  url?: string;
  text?: string;
  author?: FxAuthor;
  media?: FxMedia | null;
  quote?: FxTweet | null;
}

interface FxResponse {
  code?: number;
  message?: string;
  tweet?: FxTweet;
}

interface GraphVariant {
  bitrate?: number;
  content_type?: string;
  url?: string;
}

interface GraphMedia {
  type?: string;
  media_url_https?: string;
  original_info?: { width?: number; height?: number };
  ext_media_availability?: { status?: string };
  video_info?: {
    duration_millis?: number;
    variants?: GraphVariant[];
  };
}

/* ------------------------------------------------------------------------ */
/* Modelo interno, independente da fonte                                     */
/* ------------------------------------------------------------------------ */

export interface TweetAuthor {
  name: string;
  username: string;
}

export interface ParsedTweet {
  id?: string;
  url?: string;
  text: string;
  author?: TweetAuthor;
  media: RemoteMediaItem[];
  quote?: ParsedTweet;
}

const twitterApiUrl = "https://twitter.com/i/api/graphql/2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId";
const guestTokenUrl = "https://api.twitter.com/1.1/guest/activate.json";
const bearer = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const baseTwitterHeaders: Record<string, string> = {
  authorization: `Bearer ${bearer}`,
  "x-twitter-client-language": "en",
  "x-twitter-active-user": "yes",
  "content-type": "application/json",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
};

/** Orçamento de texto visível: a legenda inteira precisa caber em 1024. */
const MAIN_TEXT_LIMIT = 520;
const QUOTE_TEXT_LIMIT = 248;
const AUTHOR_NAME_LIMIT = 50;

export function isTwitterStatusUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com"))
      && /\/status(?:es)?\/\d+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function statusId(rawUrl: string) {
  const match = new URL(rawUrl).pathname.match(/\/status(?:es)?\/(\d+)/i);
  if (!match?.[1]) throw new Error("ID do tweet não encontrado");
  return match[1];
}

function trimTrailingTrackingUrl(text: string) {
  return text
    .replace(/(?:\s|^)(?:https?:\/\/t\.co\/[A-Za-z0-9]+)\s*$/iu, "")
    .trim();
}

function unescapeEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAuthor(name?: string, username?: string): TweetAuthor | undefined {
  const handle = username?.trim().replace(/^@/, "");
  if (!handle) return undefined;
  return { name: name?.trim() || handle, username: handle };
}

function twitterProfileUrl(username: string) {
  return `https://x.com/${encodeURIComponent(username)}`;
}

function linkedTwitterAuthor(author?: TweetAuthor) {
  if (!author) return "<b>X</b>";
  const label = `${truncate(author.name, AUTHOR_NAME_LIMIT)} (@${author.username})`;
  return `<a href="${escapeHtml(twitterProfileUrl(author.username))}">${escapeHtml(label)}</a>`;
}

function dedupeByUrl(items: RemoteMediaItem[]): RemoteMediaItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

/* ------------------------------------------------------------------------ */
/* Mídia                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Pede a imagem em `name=large` (até 2048 px). O Telegram recomprime toda
 * foto para no máximo 2560 px, então o original de 4096 px (`name=orig`) só
 * deixava o envio mais lento — pesa várias vezes mais e não chega maior ao
 * chat. A URL sem parâmetro (versão menor) fica como alternativa.
 */
function photoUrls(mediaUrl: string): string[] {
  try {
    const url = new URL(mediaUrl);
    if (!url.hostname.endsWith("twimg.com")) return [mediaUrl];
    const plain = new URL(url);
    plain.searchParams.delete("name");
    const large = new URL(plain);
    large.searchParams.set("name", "large");
    return [large.toString(), plain.toString()];
  } catch {
    return [mediaUrl];
  }
}

interface RankedVariant {
  url: string;
  bitrate: number;
}

/**
 * Ordena as variantes MP4 da melhor para a pior, deixando por último as que
 * comprovadamente não cabem no limite de upload. A melhor variante que cabe é
 * sempre a primeira: qualidade máxima sem estourar o limite do Telegram.
 */
function rankVariants(variants: RankedVariant[], durationSeconds: number): { urls: string[]; sizeBytes?: number } {
  const sorted = [...variants].sort((a, b) => b.bitrate - a.bitrate);
  if (!sorted.length) return { urls: [] };
  const estimate = (variant: RankedVariant) => (
    durationSeconds > 0 && variant.bitrate > 0 ? Math.ceil(variant.bitrate * durationSeconds / 8) : undefined
  );
  const fits = (variant: RankedVariant) => {
    const size = estimate(variant);
    return size === undefined || size <= env.MAX_UPLOAD_BYTES * 0.95;
  };
  const ordered = [...sorted.filter(fits), ...sorted.filter((variant) => !fits(variant)).reverse()];
  const urls = ordered.map((variant) => variant.url).filter((url, index, all) => all.indexOf(url) === index);
  return { urls, sizeBytes: ordered[0] ? estimate(ordered[0]) : undefined };
}

function graphMediaItems(media: unknown): RemoteMediaItem[] {
  if (!Array.isArray(media)) return [];
  const output: RemoteMediaItem[] = [];
  for (const item of media as GraphMedia[]) {
    const status = item.ext_media_availability?.status;
    if (status && status !== "Available") continue;
    const type = (item.type ?? "").toLowerCase();
    const width = item.original_info?.width;
    const height = item.original_info?.height;

    if (type === "photo" && item.media_url_https) {
      const [url, ...fallbackUrls] = photoUrls(item.media_url_https);
      output.push({ kind: "photo", url: url!, fallbackUrls, width, height });
      continue;
    }

    if (type === "video" || type === "animated_gif") {
      const durationSeconds = Math.max(0, Number(item.video_info?.duration_millis ?? 0) / 1000);
      const variants = (item.video_info?.variants ?? [])
        .filter((variant) => variant.url && variant.content_type === "video/mp4")
        .map((variant) => ({ url: variant.url!, bitrate: Number(variant.bitrate ?? 0) }));
      const { urls, sizeBytes } = rankVariants(variants, durationSeconds);
      if (!urls.length) continue;
      output.push({
        kind: "video",
        url: urls[0]!,
        fallbackUrls: urls.slice(1),
        thumbnailUrl: item.media_url_https,
        width,
        height,
        duration: durationSeconds || undefined,
        sizeBytes,
      });
    }
  }
  return dedupeByUrl(output).slice(0, env.MAX_MEDIA_ITEMS);
}

function fxMediaItems(media?: FxMedia | null): RemoteMediaItem[] {
  if (!media) return [];
  const candidates = media.all?.length
    ? media.all
    : [...(media.videos ?? []), ...(media.gifs ?? []), ...(media.photos ?? [])];
  const output: RemoteMediaItem[] = [];
  for (const item of candidates) {
    const url = item.url?.trim();
    if (!url) continue;
    const video = ["video", "gif", "animated_gif"].includes((item.type ?? "").toLowerCase());
    if (!video) {
      const [primary, ...fallbackUrls] = photoUrls(url);
      output.push({ kind: "photo", url: primary!, fallbackUrls, width: item.width, height: item.height });
      continue;
    }
    const variants = (item.formats ?? [])
      .filter((format) => format.url && (format.container ?? "mp4").toLowerCase() === "mp4")
      .map((format) => ({ url: format.url!, bitrate: Number(format.bitrate ?? 0) }));
    const ranked = rankVariants(variants, Number(item.duration ?? 0));
    const urls = ranked.urls.length ? ranked.urls : [url];
    output.push({
      kind: "video",
      url: urls[0]!,
      fallbackUrls: urls.slice(1),
      thumbnailUrl: item.thumbnail_url,
      width: item.width,
      height: item.height,
      duration: item.duration || undefined,
      sizeBytes: ranked.sizeBytes,
    });
  }
  return dedupeByUrl(output).slice(0, env.MAX_MEDIA_ITEMS);
}

/* ------------------------------------------------------------------------ */
/* Conversão para o modelo interno                                           */
/* ------------------------------------------------------------------------ */

export function parseFxTweet(tweet: FxTweet, depth = 0): ParsedTweet {
  return {
    id: tweet.id,
    url: tweet.url,
    text: trimTrailingTrackingUrl(tweet.text ?? ""),
    author: parseAuthor(tweet.author?.name, tweet.author?.screen_name),
    media: fxMediaItems(tweet.media),
    quote: tweet.quote && depth === 0 ? parseFxTweet(tweet.quote, depth + 1) : undefined,
  };
}

/** `TweetWithVisibilityResults` embrulha o tweet real em `.tweet`. */
function unwrapGraphResult(result: any): any {
  if (!result || typeof result !== "object") return undefined;
  const tweet = result.tweet ?? result;
  return tweet?.legacy ? tweet : undefined;
}

function graphText(tweet: any): string {
  const note = tweet.note_tweet?.note_tweet_results?.result?.text;
  if (typeof note === "string" && note.trim()) return unescapeEntities(note).trim();

  let text = String(tweet.legacy?.full_text ?? "");
  for (const entity of tweet.legacy?.entities?.urls ?? []) {
    if (entity?.url && entity?.expanded_url) text = text.replaceAll(entity.url, entity.expanded_url);
  }
  return trimTrailingTrackingUrl(unescapeEntities(text));
}

export function parseGraphTweet(result: unknown, depth = 0): ParsedTweet | undefined {
  const tweet = unwrapGraphResult(result);
  if (!tweet) return undefined;
  const user = tweet.core?.user_results?.result;
  const author = parseAuthor(
    user?.legacy?.name ?? user?.core?.name,
    user?.legacy?.screen_name ?? user?.core?.screen_name,
  );
  const id = tweet.rest_id ?? tweet.legacy?.id_str;
  return {
    id,
    url: author && id ? `https://x.com/${author.username}/status/${id}` : undefined,
    text: graphText(tweet),
    author,
    media: graphMediaItems(tweet.legacy?.extended_entities?.media),
    quote: depth === 0 ? parseGraphTweet(tweet.quoted_status_result?.result, depth + 1) : undefined,
  };
}

/**
 * Junta as duas fontes. O GraphQL traz todas as variantes de vídeo (permite
 * escolher a melhor que cabe); o FxTwitter costuma ter o texto mais limpo.
 */
export function mergeTweets(fx?: ParsedTweet, graph?: ParsedTweet): ParsedTweet | undefined {
  if (!fx) return graph;
  if (!graph) return fx;
  return {
    id: fx.id ?? graph.id,
    url: fx.url ?? graph.url,
    text: fx.text || graph.text,
    author: fx.author ?? graph.author,
    media: graph.media.length >= fx.media.length ? graph.media : fx.media,
    quote: mergeTweets(fx.quote, graph.quote),
  };
}

/**
 * Mídias enviadas: primeiro as do tweet principal e, quando o link é de um
 * quote, as do tweet citado em seguida. Cada tweet pode ter até 20 itens; o
 * envio é fatiado em álbuns de 10 pelo sender.
 *
 * As duas listas NÃO são deduplicadas entre si: é comum o tweet principal
 * repostar o mesmo vídeo do tweet citado, e nesse caso o vídeo pertence aos
 * dois (o SmudgeLord também mostra em ambos).
 */
export function tweetRemoteItems(tweet: ParsedTweet): RemoteMediaItem[] {
  return [...tweet.media, ...(tweet.quote?.media ?? [])];
}

/** Limite folgado por tweet; a rich message inteira aceita 32768 caracteres. */
const ARTICLE_TEXT_LIMIT = 6000;

function articleTweetHtml(tweet: ParsedTweet): string {
  const author = tweet.author;
  const header = author
    ? `<p><b><a href="${escapeHtml(twitterProfileUrl(author.username))}">${escapeHtml(author.name)}</a> (<code>@${escapeHtml(author.username)}</code>)</b></p>`
    : "<p><b>X</b></p>";
  if (!tweet.text) return `${header}\n`;
  const text = escapeHtml(truncate(tweet.text, ARTICLE_TEXT_LIMIT)).replace(/\n/g, "<br/>");
  return `${header}\n<p>${text}</p>\n`;
}

/**
 * Monta o tweet com quote no mesmo layout do SmudgeLord: autor e texto do
 * tweet principal, as mídias dele e, dentro de uma citação, o autor, o texto
 * e as mídias do tweet citado. Tweets sem quote continuam como álbum comum.
 */
export function buildTwitterArticle(tweet: ParsedTweet): MediaArticlePart[] | undefined {
  if (!tweet.quote) return undefined;
  const parts: MediaArticlePart[] = [{ html: articleTweetHtml(tweet) }];
  if (tweet.media.length) parts.push({ media: tweet.media });
  parts.push({ html: `<blockquote>\n${articleTweetHtml(tweet.quote)}` });
  if (tweet.quote.media.length) parts.push({ media: tweet.quote.media });
  parts.push({ html: "</blockquote>\n" });
  return parts;
}

export function buildTwitterCaption(tweet: ParsedTweet): string {
  const lines = [`${linkedTwitterAuthor(tweet.author)}:`];
  if (tweet.text) lines.push(escapeHtml(truncate(tweet.text, MAIN_TEXT_LIMIT)));

  if (tweet.quote) {
    const quoteText = truncate(tweet.quote.text, QUOTE_TEXT_LIMIT);
    const body = [`<i>Quoting</i> ${linkedTwitterAuthor(tweet.quote.author)}:`];
    if (quoteText) body.push(escapeHtml(quoteText));
    lines.push(`<blockquote>${body.join("\n")}</blockquote>`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------------ */
/* Rede                                                                      */
/* ------------------------------------------------------------------------ */

async function fetchFxTweet(id: string): Promise<ParsedTweet> {
  const base = env.FXTWITTER_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/status/${id}`, {
    signal: AbortSignal.timeout(env.TWITTER_ATTEMPT_TIMEOUT_MS),
    headers: {
      accept: "application/json",
      "user-agent": "Esqueletops-Nova/1.5 (+Telegram media bot)",
    },
  });
  if (!response.ok) throw new Error(`FxTwitter respondeu HTTP ${response.status}`);
  const payload = await response.json() as FxResponse;
  if (payload.code !== 200 || !payload.tweet) {
    throw new Error(payload.message || "FxTwitter não retornou o tweet");
  }
  return parseFxTweet(payload.tweet);
}

const GUEST_TOKEN_KEY = "twitter:guest-token";

async function guestToken(): Promise<string> {
  const cached = await cacheGetJson<string>(GUEST_TOKEN_KEY).catch(() => null);
  if (cached) return cached;

  const response = await fetch(guestTokenUrl, {
    method: "POST",
    redirect: "follow",
    signal: AbortSignal.timeout(Math.min(env.TWITTER_ATTEMPT_TIMEOUT_MS, 8000)),
    headers: baseTwitterHeaders,
  });
  if (!response.ok) throw new Error(`Twitter guest token HTTP ${response.status}`);
  const payload = await response.json() as { guest_token?: string };
  if (!payload.guest_token) throw new Error("Twitter não retornou guest token");
  await cacheSetJson(GUEST_TOKEN_KEY, payload.guest_token, 3 * 60 * 60).catch(() => undefined);
  return payload.guest_token;
}

const graphFeatures = JSON.stringify({
  creator_subscriptions_tweet_preview_api_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_home_pinned_timelines_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_media_download_video_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
});

async function requestGraphTweet(id: string, token: string): Promise<Response> {
  const query = new URLSearchParams({
    variables: JSON.stringify({
      tweetId: id,
      includePromotedContent: false,
      withCommunity: false,
      withVoice: false,
    }),
    features: graphFeatures,
    fieldToggles: JSON.stringify({ withArticleRichContentState: true }),
  });
  return fetch(`${twitterApiUrl}?${query}`, {
    signal: AbortSignal.timeout(env.TWITTER_ATTEMPT_TIMEOUT_MS),
    headers: {
      ...baseTwitterHeaders,
      "x-guest-token": token,
      cookie: `guest_id=v1:${token};`,
    },
  });
}

async function fetchGraphTweet(id: string): Promise<ParsedTweet> {
  let response = await requestGraphTweet(id, await guestToken());
  if (response.status === 401 || response.status === 403) {
    // Guest token em cache expirou/foi revogado: renova uma vez em vez de
    // ficar 3 horas falhando até o cache vencer.
    await cacheSetJson(GUEST_TOKEN_KEY, "", 1).catch(() => undefined);
    response = await requestGraphTweet(id, await guestToken());
  }
  if (!response.ok) throw new Error(`Twitter GraphQL respondeu HTTP ${response.status}`);
  const payload = await response.json() as any;
  const tweet = parseGraphTweet(payload?.data?.tweetResult?.result);
  if (!tweet) throw new Error("Twitter GraphQL não retornou o tweet");
  return tweet;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: unknown) => ({ ok: false as const, error }),
);

const sleep = (milliseconds: number) => new Promise<undefined>((resolve) => {
  setTimeout(() => resolve(undefined), milliseconds);
});

/**
 * Consulta FxTwitter e GraphQL em paralelo. Assim que a primeira responde com
 * sucesso, a outra ganha só uma pequena tolerância para complementar os dados
 * — antes o envio sempre esperava a mais lenta das duas (até 15 s).
 */
async function fetchTweet(id: string): Promise<{ tweet: ParsedTweet; source: string }> {
  const fx = settle(fetchFxTweet(id));
  const graph = settle(fetchGraphTweet(id));
  const first = await Promise.race([
    fx.then((result) => ({ from: "fx" as const, result })),
    graph.then((result) => ({ from: "graph" as const, result })),
  ]);

  const other = first.from === "fx" ? graph : fx;
  const second = first.result.ok
    ? await Promise.race([other, sleep(env.TWITTER_MERGE_GRACE_MS)])
    : await other;

  const fxResult = first.from === "fx" ? first.result : second;
  const graphResult = first.from === "graph" ? first.result : second;
  const fxTweet = fxResult?.ok ? fxResult.value : undefined;
  const graphTweet = graphResult?.ok ? graphResult.value : undefined;

  const tweet = mergeTweets(fxTweet, graphTweet);
  if (!tweet) {
    const errors = [fxResult, graphResult].flatMap((result) => (result && !result.ok ? [result.error] : []));
    throw new AggregateError(errors, "Não foi possível consultar o tweet");
  }
  if (graphResult && !graphResult.ok) {
    logger.debug({ error: graphResult.error, id }, "Twitter GraphQL indisponível; usando FxTwitter");
  }
  return { tweet, source: graphTweet ? (fxTweet ? "twitter-direct+fx" : "twitter-direct") : "fxtwitter" };
}

export async function downloadTwitterMedia(rawUrl: string): Promise<DownloadedMedia> {
  const id = statusId(rawUrl);
  const { tweet, source } = await fetchTweet(id);
  const remoteItems = tweetRemoteItems(tweet);

  return {
    files: [],
    remoteItems,
    article: buildTwitterArticle(tweet),
    metadata: {
      id,
      uploader: tweet.author?.name,
      uploaderId: tweet.author?.username,
      profileUrl: tweet.author ? twitterProfileUrl(tweet.author.username) : undefined,
      description: tweet.text,
      webpageUrl: tweet.url ?? rawUrl,
      extractor: source,
      captionHtml: buildTwitterCaption(tweet),
    },
  };
}
