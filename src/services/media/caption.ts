import { env } from "../../config/env.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import type { MediaMetadata } from "./types.js";

export function buildMediaCaption(metadata: MediaMetadata, url: string) {
  if (metadata.captionHtml?.trim()) return truncate(metadata.captionHtml.trim(), 1000);

  const lines: string[] = [];
  if (metadata.title) lines.push(`<b>${escapeHtml(truncate(metadata.title, 250))}</b>`);
  if (metadata.uploader) lines.push(`👤 ${escapeHtml(truncate(metadata.uploader, 120))}`);
  if (metadata.description) {
    const description = truncate(metadata.description.replace(/\s+/g, " ").trim(), 450);
    if (description && description !== metadata.title) lines.push(escapeHtml(description));
  }
  if (env.MEDIA_INCLUDE_SOURCE_LINK && !env.MEDIA_SOURCE_BUTTON) {
    lines.push(`<a href="${escapeHtml(metadata.webpageUrl ?? url)}">🔗 Abrir publicação original</a>`);
  }
  return truncate(lines.join("\n"), 1000);
}
