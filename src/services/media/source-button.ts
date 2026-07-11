import { InlineKeyboard } from "grammy";
import { escapeHtml } from "../../utils/html.js";

const serviceLabels: Array<[string, string]> = [
  ["instagram.com", "Abrir no Instagram"],
  ["tiktok.com", "Abrir no TikTok"],
  ["x.com", "Abrir no Twitter/X"],
  ["twitter.com", "Abrir no Twitter/X"],
  ["reddit.com", "Abrir no Reddit"],
  ["redd.it", "Abrir no Reddit"],
  ["threads.net", "Abrir no Threads"],
  ["threads.com", "Abrir no Threads"],
  ["bsky.app", "Abrir no Bluesky"],
  ["pinterest.com", "Abrir no Pinterest"],
  ["pin.it", "Abrir no Pinterest"],
  ["substack.com", "Abrir no Substack"],
  ["xiaohongshu.com", "Abrir no Xiaohongshu"],
  ["xhslink.com", "Abrir no Xiaohongshu"],
  ["youtube.com", "Abrir no YouTube"],
  ["youtu.be", "Abrir no YouTube"],
];

export function sourceButtonLabel(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return serviceLabels.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1]
      ?? "Abrir publicação original";
  } catch {
    return "Abrir publicação original";
  }
}

export function sourceKeyboard(rawUrl: string): InlineKeyboard | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return new InlineKeyboard().url(sourceButtonLabel(url.toString()), url.toString());
  } catch {
    return undefined;
  }
}

/**
 * Álbuns do Telegram não suportam teclado inline. O SmudgeLord resolve isso
 * colocando o acesso à publicação como link clicável na própria legenda.
 */
export function sourceCaptionLink(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return `<a href="${escapeHtml(url.toString())}">🔗 ${escapeHtml(sourceButtonLabel(url.toString()))}</a>`;
  } catch {
    return "";
  }
}
