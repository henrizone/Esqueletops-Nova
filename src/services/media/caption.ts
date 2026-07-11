import { env } from "../../config/env.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { MediaMetadata } from "./types.js";

function isInstagramUrl(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

function cleanInstagramDescription(value?: string) {
  if (!value) return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildMediaCaption(metadata: MediaMetadata, url: string) {
  if (metadata.captionHtml?.trim()) return truncate(metadata.captionHtml.trim(), 1000);

  const lines: string[] = [];

  if (isInstagramUrl(metadata.webpageUrl ?? url)) {
    // O yt-dlp cria títulos artificiais como "Video by enhypen". O SmudgeLord
    // não mostra essa linha nem repete o nome da conta com um ícone.
    const handle = (metadata.uploaderId ?? metadata.uploader ?? "").replace(/^@/, "").trim();
    if (handle) lines.push(`<b>${escapeHtml(truncate(handle, 120))}</b>`);

    const description = cleanInstagramDescription(metadata.description);
    if (description) lines.push(escapeHtml(truncate(description, 820)));
  } else {
    if (metadata.title) lines.push(`<b>${escapeHtml(truncate(metadata.title, 250))}</b>`);
    if (metadata.uploader) lines.push(`👤 ${escapeHtml(truncate(metadata.uploader, 120))}`);
    if (metadata.description) {
      const description = truncate(metadata.description.replace(/\s+/g, " ").trim(), 450);
      if (description && description !== metadata.title) lines.push(escapeHtml(description));
    }
  }

  if (env.MEDIA_INCLUDE_SOURCE_LINK && !env.MEDIA_SOURCE_BUTTON) {
    lines.push(`<a href="${escapeHtml(metadata.webpageUrl ?? url)}">🔗 Abrir publicação original</a>`);
  }
  return truncate(lines.join("\n"), 1000);
}
