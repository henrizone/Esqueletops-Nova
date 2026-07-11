import { escapeHtml, truncate } from "../../utils/html.js";
import type { MediaMetadata } from "./types.js";

export type MediaPlatform =
  | "instagram"
  | "tiktok"
  | "twitter"
  | "threads"
  | "bluesky"
  | "reddit"
  | "pinterest"
  | "youtube"
  | "xiaohongshu"
  | "substack"
  | "generic";

export interface MediaAuthor {
  platform: MediaPlatform;
  displayName: string;
  handle?: string;
  profileUrl?: string;
}

function hostname(raw?: string) {
  if (!raw) return "";
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function detectMediaPlatform(raw?: string): MediaPlatform {
  const host = hostname(raw);
  if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) return "twitter";
  if (host === "threads.net" || host.endsWith(".threads.net") || host === "threads.com" || host.endsWith(".threads.com")) return "threads";
  if (host === "bsky.app" || host.endsWith(".bsky.app")) return "bluesky";
  if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it" || host.endsWith(".redd.it")) return "reddit";
  if (host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it" || host.endsWith(".pin.it")) return "pinterest";
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com")) return "xiaohongshu";
  if (host === "substack.com" || host.endsWith(".substack.com")) return "substack";
  return "generic";
}

function clean(value?: string) {
  return value?.replace(/\s+/g, " ").trim() || undefined;
}

function safeHttpUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanHandle(value?: string) {
  const candidate = clean(value)
    ?.replace(/^@/, "")
    .replace(/^u\//i, "")
    .replace(/^user\//i, "")
    .replace(/[/:?#].*$/, "")
    .trim();
  return candidate || undefined;
}

function looksLikeInternalNumericId(value?: string) {
  return Boolean(value && /^\d{8,}$/.test(value));
}

function looksLikeArtificialTitle(value?: string) {
  return Boolean(value && /^(?:video|photo|reel|post|story)\s+by\s+/i.test(value.trim()));
}

function usableName(value?: string) {
  const candidate = clean(value);
  if (!candidate || looksLikeArtificialTitle(candidate) || looksLikeInternalNumericId(candidate)) return undefined;
  return candidate;
}

function authorFromArtificialTitle(title?: string) {
  const match = clean(title)?.match(/^(?:video|photo|reel|post|story)\s+by\s+(.+?)\s*$/i);
  return cleanHandle(match?.[1]);
}

function profileHandle(platform: MediaPlatform, profileUrl?: string) {
  const safe = safeHttpUrl(profileUrl);
  if (!safe) return undefined;
  const url = new URL(safe);
  const parts = url.pathname.split("/").filter(Boolean).map(decodePath);

  switch (platform) {
    case "instagram": {
      const first = parts[0];
      if (!first || ["p", "reel", "reels", "tv", "stories", "explore"].includes(first.toLowerCase())) return undefined;
      return cleanHandle(first);
    }
    case "tiktok": {
      const segment = parts.find((part) => part.startsWith("@"));
      return cleanHandle(segment);
    }
    case "twitter": {
      const first = parts[0];
      if (!first || ["i", "home", "explore", "search", "intent"].includes(first.toLowerCase())) return undefined;
      return cleanHandle(first);
    }
    case "threads": {
      const segment = parts.find((part) => part.startsWith("@"));
      return cleanHandle(segment);
    }
    case "bluesky": {
      const index = parts.findIndex((part) => part.toLowerCase() === "profile");
      return cleanHandle(index >= 0 ? parts[index + 1] : undefined);
    }
    case "reddit": {
      const index = parts.findIndex((part) => ["u", "user"].includes(part.toLowerCase()));
      return cleanHandle(index >= 0 ? parts[index + 1] : undefined);
    }
    case "pinterest": {
      const first = parts[0];
      if (!first || ["pin", "ideas", "search"].includes(first.toLowerCase())) return undefined;
      return cleanHandle(first);
    }
    case "youtube": {
      const at = parts.find((part) => part.startsWith("@"));
      if (at) return cleanHandle(at);
      const channelIndex = parts.findIndex((part) => ["channel", "user", "c"].includes(part.toLowerCase()));
      return cleanHandle(channelIndex >= 0 ? parts[channelIndex + 1] : undefined);
    }
    default:
      return undefined;
  }
}

function deriveProfileUrl(platform: MediaPlatform, handle?: string, uploaderId?: string) {
  if (!handle && !uploaderId) return undefined;
  const encodedHandle = handle ? encodeURIComponent(handle) : undefined;
  switch (platform) {
    case "instagram": return encodedHandle ? `https://www.instagram.com/${encodedHandle}/` : undefined;
    case "tiktok": return encodedHandle ? `https://www.tiktok.com/@${encodedHandle}` : undefined;
    case "twitter": return encodedHandle ? `https://x.com/${encodedHandle}` : undefined;
    case "threads": return encodedHandle ? `https://www.threads.net/@${encodedHandle}` : undefined;
    case "bluesky": return encodedHandle ? `https://bsky.app/profile/${encodedHandle}` : undefined;
    case "reddit": return encodedHandle ? `https://www.reddit.com/user/${encodedHandle}/` : undefined;
    case "pinterest": return encodedHandle ? `https://www.pinterest.com/${encodedHandle}/` : undefined;
    case "youtube": {
      if (handle) return `https://www.youtube.com/@${encodedHandle}`;
      if (uploaderId?.startsWith("UC")) return `https://www.youtube.com/channel/${encodeURIComponent(uploaderId)}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

function socialHandle(platform: MediaPlatform, metadata: MediaMetadata, explicitProfileUrl?: string, pageUrl?: string) {
  const fromUrl = profileHandle(platform, explicitProfileUrl) ?? profileHandle(platform, pageUrl);
  if (fromUrl && !looksLikeInternalNumericId(fromUrl)) return fromUrl;

  const uploader = cleanHandle(metadata.uploader);
  const uploaderId = cleanHandle(metadata.uploaderId);
  const titleAuthor = authorFromArtificialTitle(metadata.title);

  const choose = (...values: Array<string | undefined>) => values.find((value) => value && !looksLikeInternalNumericId(value));

  switch (platform) {
    case "instagram": return choose(uploaderId, titleAuthor, uploader);
    case "tiktok": return choose(uploaderId, metadata.uploader?.startsWith("@") ? uploader : undefined, uploader, titleAuthor);
    case "twitter": return choose(uploaderId, uploader);
    case "threads": return choose(uploaderId, uploader, titleAuthor);
    case "bluesky": return choose(uploaderId, uploader);
    case "reddit": return choose(uploaderId, uploader);
    case "pinterest": return choose(uploaderId, uploader);
    case "youtube": return choose(
      uploaderId && !uploaderId.startsWith("UC") && !/\s/.test(uploaderId) ? uploaderId : undefined,
      metadata.uploader?.startsWith("@") ? uploader : undefined,
    );
    default: return choose(uploaderId, uploader);
  }
}

function displayName(platform: MediaPlatform, metadata: MediaMetadata, handle?: string) {
  const uploader = usableName(metadata.uploader);
  switch (platform) {
    case "instagram": return handle ?? uploader;
    case "tiktok": return uploader ?? (handle ? `@${handle}` : undefined);
    case "twitter": return uploader ?? (handle ? `@${handle}` : undefined);
    case "threads": return uploader ?? (handle ? `@${handle}` : undefined);
    case "bluesky": return uploader ?? (handle ? `@${handle}` : undefined);
    case "reddit": return handle ? `u/${handle}` : uploader;
    case "youtube": return uploader ?? handle;
    default: return uploader ?? handle;
  }
}

export function resolveMediaAuthor(metadata: MediaMetadata, sourceUrl: string): MediaAuthor | undefined {
  const pageUrl = metadata.webpageUrl ?? sourceUrl;
  const platform = detectMediaPlatform(pageUrl);
  const profileCandidate = safeHttpUrl(metadata.profileUrl);
  const candidateHandle = profileHandle(platform, profileCandidate);
  const explicitProfileUrl = candidateHandle && looksLikeInternalNumericId(candidateHandle)
    ? undefined
    : profileCandidate;
  const handle = socialHandle(platform, metadata, explicitProfileUrl, pageUrl);
  const name = displayName(platform, metadata, handle);
  if (!name) return undefined;

  const profileUrl = explicitProfileUrl ?? deriveProfileUrl(platform, handle, metadata.uploaderId);
  return {
    platform,
    displayName: name,
    handle,
    profileUrl,
  };
}

export function linkedAuthorHtml(author: MediaAuthor, maxLength = 120) {
  const label = escapeHtml(truncate(author.displayName, maxLength));
  const url = safeHttpUrl(author.profileUrl);
  return url ? `<a href="${escapeHtml(url)}">${label}</a>` : `<b>${label}</b>`;
}
