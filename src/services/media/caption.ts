import { env } from "../../config/env.js";
import { escapeHtml, truncate } from "../../utils/html.js";
import { detectMediaPlatform, linkedAuthorHtml, resolveMediaAuthor } from "./profile.js";
import type { MediaMetadata } from "./types.js";

function cleanDescription(value?: string, preserveLines = true) {
  if (!value) return "";
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return preserveLines ? normalized : normalized.replace(/\s+/g, " ").trim();
}

function isArtificialSocialTitle(value?: string) {
  return Boolean(value && /^(?:video|photo|reel|post|story)\s+by\s+/i.test(value.trim()));
}

function distinctTitle(metadata: MediaMetadata) {
  const title = metadata.title?.trim();
  if (!title || isArtificialSocialTitle(title)) return "";
  const description = cleanDescription(metadata.description, false);
  return title === description ? "" : title;
}

function appendAuthor(lines: string[], metadata: MediaMetadata, url: string) {
  const author = resolveMediaAuthor(metadata, url);
  if (author) lines.push(linkedAuthorHtml(author));
  return author;
}

export function buildMediaCaption(metadata: MediaMetadata, url: string) {
  if (metadata.captionHtml?.trim()) return truncate(metadata.captionHtml.trim(), 1000);

  const lines: string[] = [];
  const pageUrl = metadata.webpageUrl ?? url;
  const platform = detectMediaPlatform(pageUrl);
  const description = cleanDescription(metadata.description, true);
  const title = distinctTitle(metadata);

  if (platform === "instagram") {
    // Instagram: perfil clicável na primeira linha e legenda original abaixo.
    // IDs numéricos internos não são exibidos; quando necessário, o handle é
    // recuperado de títulos artificiais como "Video by enhypen".
    appendAuthor(lines, metadata, url);
    if (description) lines.push(escapeHtml(truncate(description, 860)));
  } else if (["tiktok", "threads", "bluesky"].includes(platform)) {
    // Redes de vídeos/posts curtos seguem a mesma apresentação do Instagram.
    appendAuthor(lines, metadata, url);
    const body = description || title;
    if (body) lines.push(escapeHtml(truncate(body, 860)));
  } else if (["reddit", "pinterest", "xiaohongshu", "substack"].includes(platform)) {
    appendAuthor(lines, metadata, url);
    if (title) lines.push(`<b>${escapeHtml(truncate(title, 260))}</b>`);
    if (description) lines.push(escapeHtml(truncate(description, 650)));
  } else if (platform === "youtube") {
    const author = appendAuthor(lines, metadata, url);
    if (!author && metadata.uploader) lines.push(`<b>${escapeHtml(truncate(metadata.uploader, 120))}</b>`);
    if (metadata.title) lines.push(`<b>${escapeHtml(truncate(metadata.title, 300))}</b>`);
    if (description && description !== metadata.title) lines.push(escapeHtml(truncate(description, 500)));
  } else {
    const author = resolveMediaAuthor(metadata, url);
    if (metadata.title) lines.push(`<b>${escapeHtml(truncate(metadata.title, 250))}</b>`);
    if (author) lines.push(`👤 ${linkedAuthorHtml(author)}`);
    else if (metadata.uploader) lines.push(`👤 ${escapeHtml(truncate(metadata.uploader, 120))}`);
    if (description && description !== metadata.title) lines.push(escapeHtml(truncate(description, 450)));
  }

  if (env.MEDIA_INCLUDE_SOURCE_LINK && !env.MEDIA_SOURCE_BUTTON) {
    lines.push(`<a href="${escapeHtml(pageUrl)}">🔗 Abrir publicação original</a>`);
  }
  return truncate(lines.filter(Boolean).join("\n"), 1000);
}
