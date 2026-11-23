import { truncate } from "../../utils/html.js";

/** Limite prático para legendas de mídia no WhatsApp. */
export const WHATSAPP_CAPTION_LIMIT = 1000;

function decodeEntities(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * O WhatsApp só formata quando o marcador encosta no texto e não há quebra de
 * linha no meio. Marcadores iguais dentro do trecho também quebram o efeito.
 */
function wrap(marker: string, inner: string) {
  const text = inner.replace(/\s*\n\s*/g, " ").trim().replaceAll(marker, "");
  return text ? `${marker}${text}${marker}` : "";
}

/**
 * Converte as legendas HTML usadas no Telegram para a marcação do WhatsApp:
 * *negrito*, _itálico_, `código` e citação com "> ". O WhatsApp não tem links
 * com rótulo, então o link do perfil vira o nome em negrito.
 */
export function htmlToWhatsApp(html: string): string {
  let text = html.replace(/\r\n?/g, "\n");

  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner: string) => {
    const quoted = inner.trim().split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    return `\n${quoted}\n`;
  });
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_match, inner: string) => wrap("*", inner.replace(/<[^>]+>/g, "")));
  text = text.replace(/<(?:b|strong)>([\s\S]*?)<\/(?:b|strong)>/gi, (_match, inner: string) => wrap("*", inner));
  text = text.replace(/<(?:i|em)>([\s\S]*?)<\/(?:i|em)>/gi, (_match, inner: string) => wrap("_", inner));
  text = text.replace(/<(?:s|strike|del)>([\s\S]*?)<\/(?:s|strike|del)>/gi, (_match, inner: string) => wrap("~", inner));
  text = text.replace(/<code>([\s\S]*?)<\/code>/gi, (_match, inner: string) => wrap("`", inner));
  text = text.replace(/<[^>]+>/g, "");

  return decodeEntities(text)
    // "**Nome**" aparece quando um link já estava dentro de <b>.
    .replace(/\*{2,}/g, "*")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Legenda final: texto convertido, aviso de mídias omitidas e o link da
 * publicação original (no WhatsApp não há botão, então o link vai no texto).
 */
export function buildWhatsAppCaption(input: {
  captionHtml: string;
  sourceUrl?: string;
  omittedMedia?: number;
}): string {
  const footer: string[] = [];
  if (input.omittedMedia && input.omittedMedia > 0) {
    footer.push(`_+${input.omittedMedia} ${input.omittedMedia === 1 ? "mídia" : "mídias"} na publicação original_`);
  }
  if (input.sourceUrl) footer.push(`🔗 ${input.sourceUrl}`);
  const footerText = footer.join("\n");
  const budget = Math.max(0, WHATSAPP_CAPTION_LIMIT - footerText.length - 2);
  const body = truncate(htmlToWhatsApp(input.captionHtml), budget);
  return [body, footerText].filter(Boolean).join("\n\n");
}
