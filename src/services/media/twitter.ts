import { cleanupDirectory, createMediaTempDirectory, downloadDirectFile } from "./direct.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { DownloadedMedia, MediaMetadata } from "./types.js";
import { env } from "../../config/env.js";

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
}

interface FxMedia {
  all?: FxMediaItem[];
  photos?: FxMediaItem[];
  videos?: FxMediaItem[];
  gifs?: FxMediaItem[];
}

interface FxTweet {
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
  // Deliberadamente não usa tweet.quote.media. O quote entra apenas como texto.
  return selected.slice(0, env.MAX_MEDIA_ITEMS);
}

async function fetchTweet(rawUrl: string): Promise<FxTweet> {
  const id = statusId(rawUrl);
  const base = env.FXTWITTER_API_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/status/${id}`, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: "application/json",
      "user-agent": "Esqueletops-Nova/1.3 (+Telegram media bot)",
    },
  });
  if (!response.ok) throw new Error(`FxTwitter respondeu HTTP ${response.status}`);
  const payload = await response.json() as FxResponse;
  if (payload.code !== 200 || !payload.tweet) {
    throw new Error(payload.message || "FxTwitter não retornou o tweet");
  }
  return payload.tweet;
}

export async function downloadTwitterMedia(rawUrl: string): Promise<DownloadedMedia> {
  const tweet = await fetchTweet(rawUrl);
  const items = selectMainTweetMedia(tweet);
  const directory = await createMediaTempDirectory("esqueletops-nova-twitter-");
  const id = statusId(rawUrl);
  const author = displayAuthor(tweet.author);
  try {
    const files: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const video = ["video", "gif", "animated_gif"].includes((item.type ?? "").toLowerCase());
      files.push(await downloadDirectFile({
        url: item.url!,
        directory,
        index,
        basename: `Twitter_${author.username}_${id}`,
        fallbackExtension: video ? ".mp4" : ".jpg",
        referer: rawUrl,
      }));
    }
    const metadata: MediaMetadata = {
      id,
      uploader: author.name,
      uploaderId: author.username,
      description: tweet.text,
      webpageUrl: tweet.url ?? rawUrl,
      extractor: "fxtwitter",
      captionHtml: buildTwitterCaption(tweet),
    };
    return { directory, files, metadata };
  } catch (error) {
    await cleanupDirectory(directory);
    throw error;
  }
}
