import { cacheGetJson, cacheSetJson } from "../../cache/redis.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { DownloadedMedia, RemoteMediaItem } from "./types.js";

interface FxAuthor {
  name?: string;
  screen_name?: string;
}

interface FxMediaItem {
  url?: string;
  thumbnail_url?: string;
  type?: string;
  width?: number;
  height?: number;
  duration?: number;
}

interface FxMedia {
  all?: FxMediaItem[];
  photos?: FxMediaItem[];
  videos?: FxMediaItem[];
  gifs?: FxMediaItem[];
}

interface FxTweet {
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
  video_info?: {
    duration_millis?: number;
    variants?: GraphVariant[];
  };
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

export function isTwitterStatusUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (host === "x.com" || host === "twitter.com" || host.endsWith(".x.com") || host.endsWith(".twitter.com"))
      && /\/status\/\d+/i.test(url.pathname);
  } catch {
    return false;
  }
}

function statusId(rawUrl: string) {
  const match = new URL(rawUrl).pathname.match(/\/status\/(\d+)/i);
  if (!match?.[1]) throw new Error("ID do tweet não encontrado");
  return match[1];
}

function trimTrailingTrackingUrl(text: string) {
  return text
    .replace(/(?:\s|^)(?:https?:\/\/t\.co\/[A-Za-z0-9]+)\s*$/iu, "")
    .trim();
}

function displayAuthor(author?: FxAuthor) {
  return {
    name: author?.name?.trim() || "X",
    username: author?.screen_name?.trim().replace(/^@/, "") || "usuario",
  };
}

export function buildTwitterCaption(tweet: FxTweet): string {
  const author = displayAuthor(tweet.author);
  const rootText = trimTrailingTrackingUrl(tweet.text ?? "");
  const lines = [
    `<b>${escapeHtml(author.name)} (<code>${escapeHtml(author.username)}</code>):</b>`,
    escapeHtml(truncate(rootText, 520)),
  ];

  if (tweet.quote) {
    const quoteAuthor = displayAuthor(tweet.quote.author);
    const quoteText = truncate(trimTrailingTrackingUrl(tweet.quote.text ?? ""), 248);
    if (quoteText || tweet.quote.author) {
      lines.push(
        `<blockquote><i>Quoting</i> <b>${escapeHtml(quoteAuthor.name)} (<code>${escapeHtml(quoteAuthor.username)}</code>):</b>\n${escapeHtml(quoteText)}</blockquote>`,
      );
    }
  }
  return lines.filter((line) => line.trim()).join("\n");
}

export function selectMainTweetMedia(tweet: FxTweet): FxMediaItem[] {
  const media = tweet.media;
  if (!media) return [];
  const candidates = media.all?.length
    ? media.all
    : [...(media.videos ?? []), ...(media.gifs ?? []), ...(media.photos ?? [])];
  const seen = new Set<string>();
  const selected: FxMediaItem[] = [];
  for (const item of candidates) {
    const url = item.url?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    selected.push(item);
  }
  // Nunca usa tweet.quote.media. O quote entra somente como texto.
  return selected.slice(0, env.MAX_MEDIA_ITEMS);
}

async function fetchFxTweet(rawUrl: string): Promise<FxTweet> {
  const id = statusId(rawUrl);
  const base = env.FXTWITTER_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/status/${id}`, {
    signal: AbortSignal.timeout(15_000),
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
  return payload.tweet;
}

async function guestToken(): Promise<string> {
  const cached = await cacheGetJson<string>("twitter:guest-token").catch(() => null);
  if (cached) return cached;

  const response = await fetch(guestTokenUrl, {
    method: "POST",
    redirect: "follow",
    signal: AbortSignal.timeout(10_000),
    headers: baseTwitterHeaders,
  });
  if (!response.ok) throw new Error(`Twitter guest token HTTP ${response.status}`);
  const payload = await response.json() as { guest_token?: string };
  if (!payload.guest_token) throw new Error("Twitter não retornou guest token");
  await cacheSetJson("twitter:guest-token", payload.guest_token, 3 * 60 * 60).catch(() => undefined);
  return payload.guest_token;
}

function mainLegacy(result: any): any {
  if (!result) return undefined;
  if (result.tweet?.legacy) return result.tweet.legacy;
  if (result.legacy) return result.legacy;
  return undefined;
}

async function fetchGraphMedia(rawUrl: string): Promise<GraphMedia[]> {
  const id = statusId(rawUrl);
  const token = await guestToken();
  const variables = {
    tweetId: id,
    includePromotedContent: false,
    withCommunity: false,
    withVoice: false,
  };
  const features = {
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
  };
  const fieldToggles = { withArticleRichContentState: true };
  const query = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
    fieldToggles: JSON.stringify(fieldToggles),
  });
  const response = await fetch(`${twitterApiUrl}?${query}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...baseTwitterHeaders,
      "x-guest-token": token,
      cookie: `guest_id=v1:${token};`,
    },
  });
  if (!response.ok) throw new Error(`Twitter GraphQL respondeu HTTP ${response.status}`);
  const payload = await response.json() as any;
  const result = payload?.data?.tweetResult?.result;
  const legacy = mainLegacy(result);
  const media = legacy?.extended_entities?.media;
  return Array.isArray(media) ? media : [];
}

function orderedVideoUrls(media: GraphMedia): string[] {
  const durationSeconds = Math.max(0, Number(media.video_info?.duration_millis ?? 0) / 1000);
  const variants = (media.video_info?.variants ?? [])
    .filter((variant) => variant.url && variant.content_type === "video/mp4")
    .map((variant) => ({ url: variant.url!, bitrate: Number(variant.bitrate ?? 0) }))
    .sort((a, b) => b.bitrate - a.bitrate);

  if (!variants.length) return [];
  const safeLimit = env.MAX_UPLOAD_BYTES * 0.90;
  const safe = variants.filter((variant) => {
    if (durationSeconds > 0 && variant.bitrate > 0) {
      return (variant.bitrate * durationSeconds / 8) <= safeLimit;
    }
    return variant.bitrate > 0 && variant.bitrate <= 3_500_000;
  });
  const selected = safe.length ? safe : [...variants].reverse();
  const remaining = variants.filter((variant) => !selected.some((item) => item.url === variant.url));
  return [...selected, ...remaining].map((variant) => variant.url);
}

function graphRemoteItems(media: GraphMedia[]): RemoteMediaItem[] {
  const output: RemoteMediaItem[] = [];
  for (const item of media.slice(0, env.MAX_MEDIA_ITEMS)) {
    const type = (item.type ?? "").toLowerCase();
    if (type === "photo" && item.media_url_https) {
      output.push({
        kind: "photo",
        url: item.media_url_https,
        width: item.original_info?.width,
        height: item.original_info?.height,
      });
      continue;
    }
    if (type === "video" || type === "animated_gif") {
      const urls = orderedVideoUrls(item);
      if (!urls.length) continue;
      output.push({
        kind: "video",
        url: urls[0]!,
        fallbackUrls: urls.slice(1),
        thumbnailUrl: item.media_url_https,
        width: item.original_info?.width,
        height: item.original_info?.height,
        duration: Number(item.video_info?.duration_millis ?? 0) / 1000 || undefined,
      });
    }
  }
  return output;
}

function fxRemoteItems(tweet: FxTweet): RemoteMediaItem[] {
  return selectMainTweetMedia(tweet).map((item) => {
    const video = ["video", "gif", "animated_gif"].includes((item.type ?? "").toLowerCase());
    return {
      kind: video ? "video" : "photo",
      url: item.url!,
      thumbnailUrl: item.thumbnail_url,
      width: item.width,
      height: item.height,
      duration: item.duration,
    } satisfies RemoteMediaItem;
  });
}

export async function downloadTwitterMedia(rawUrl: string): Promise<DownloadedMedia> {
  const [fxResult, graphResult] = await Promise.allSettled([
    fetchFxTweet(rawUrl),
    fetchGraphMedia(rawUrl),
  ]);

  if (fxResult.status === "rejected" && graphResult.status === "rejected") {
    throw new AggregateError([fxResult.reason, graphResult.reason], "Não foi possível consultar o tweet");
  }

  const tweet = fxResult.status === "fulfilled" ? fxResult.value : undefined;
  const graphItems = graphResult.status === "fulfilled" ? graphRemoteItems(graphResult.value) : [];
  const remoteItems = graphItems.length ? graphItems : tweet ? fxRemoteItems(tweet) : [];
  if (graphResult.status === "rejected") {
    logger.debug({ error: graphResult.reason, url: rawUrl }, "Twitter GraphQL indisponível; usando FxTwitter");
  }

  const author = displayAuthor(tweet?.author);
  const id = statusId(rawUrl);
  return {
    files: [],
    remoteItems,
    metadata: {
      id,
      uploader: author.name,
      uploaderId: author.username,
      description: tweet?.text,
      webpageUrl: tweet?.url ?? rawUrl,
      extractor: graphItems.length ? "twitter-direct" : "fxtwitter",
      captionHtml: tweet ? buildTwitterCaption(tweet) : undefined,
    },
  };
}
