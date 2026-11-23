import { describe, expect, it } from "vitest";
import { buildWhatsAppCaption, htmlToWhatsApp, WHATSAPP_CAPTION_LIMIT } from "../src/services/whatsapp/format.js";
import { edgeForSizeBudget, targetVideoBitrate } from "../src/services/media/convert.js";
import { firstSupportedUrl, parseEvolutionWebhook, whatsAppMediaType } from "../src/services/whatsapp/handler.js";

describe("WhatsApp: formatação", () => {
  it("converte a legenda de um tweet com quote para a marcação do WhatsApp", () => {
    const html = '<a href="https://x.com/a">Ana &amp; Bia (@a)</a>:\nolha <b>isso</b>\n'
      + '<blockquote><i>Quoting</i> <a href="https://x.com/b">Beto (@b)</a>:\nlinha 1\nlinha 2</blockquote>';
    expect(htmlToWhatsApp(html)).toBe(
      "*Ana & Bia (@a)*:\nolha *isso*\n\n> _Quoting_ *Beto (@b)*:\n> linha 1\n> linha 2",
    );
  });

  it("não deixa sobrar tags nem entidades HTML", () => {
    const text = htmlToWhatsApp('<b><a href="https://x.com/a">Nome</a></b> &lt;3 <code>@a</code><br/>fim');
    expect(text).toBe("*Nome* <3 `@a`\nfim");
  });

  it("inclui o link original e o aviso de mídias omitidas dentro do limite", () => {
    const caption = buildWhatsAppCaption({
      captionHtml: `<b>Autor</b>\n${"x".repeat(3000)}`,
      sourceUrl: "https://x.com/a/status/1",
      omittedMedia: 16,
    });
    expect(caption.length).toBeLessThanOrEqual(WHATSAPP_CAPTION_LIMIT);
    expect(caption).toContain("_+16 mídias na publicação original_");
    expect(caption.endsWith("🔗 https://x.com/a/status/1")).toBe(true);
  });
});

describe("WhatsApp: tipo de mídia", () => {
  it("envia vídeo como vídeo e foto como imagem, nunca como arquivo", () => {
    expect(whatsAppMediaType({ kind: "video" })).toBe("video");
    expect(whatsAppMediaType({ kind: "photo" })).toBe("image");
    expect(whatsAppMediaType({ kind: "audio" })).toBe("document");
  });

  it("reduz a resolução quando o vídeo precisa caber em 16 MB", () => {
    const limit = 16 * 1024 * 1024;
    expect(edgeForSizeBudget(limit, 20)).toBe(1920);
    expect(edgeForSizeBudget(limit, 75)).toBe(1280);
    expect(edgeForSizeBudget(limit, 150)).toBe(854);
    expect(edgeForSizeBudget(limit, 300)).toBe(640);
    expect(targetVideoBitrate(720, 1280, 75, limit)).toBeLessThan(limit * 8 / 75);
  });
});

describe("WhatsApp: webhook da Evolution", () => {
  const event = (data: unknown, name = "messages.upsert") => ({ event: name, data });

  it("lê texto simples, texto estendido e legenda de mídia", () => {
    const parsed = parseEvolutionWebhook(event([
      { key: { id: "1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }, message: { conversation: "oi https://x.com/a/status/1" }, messageTimestamp: 100 },
      { key: { id: "2", remoteJid: "123@g.us", participant: "5511888888888@s.whatsapp.net", fromMe: false }, message: { extendedTextMessage: { text: "link" } } },
      { key: { id: "3", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }, message: { imageMessage: { caption: "legenda" } } },
    ]));
    expect(parsed.map((message) => message.text)).toEqual(["oi https://x.com/a/status/1", "link", "legenda"]);
    expect(parsed[1]).toMatchObject({ isGroup: true, sender: "5511888888888@s.whatsapp.net" });
    expect(parsed[0]?.timestamp).toBe(100);
  });

  it("aceita o nome do evento em maiúsculas e o dado como objeto único", () => {
    const parsed = parseEvolutionWebhook(event(
      { key: { id: "1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }, message: { conversation: "x" } },
      "MESSAGES_UPSERT",
    ));
    expect(parsed).toHaveLength(1);
  });

  it("ignora mensagens próprias, status, canais e outros eventos", () => {
    const own = { key: { id: "1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: true }, message: { conversation: "x" } };
    const status = { key: { id: "2", remoteJid: "status@broadcast", fromMe: false }, message: { conversation: "x" } };
    const channel = { key: { id: "3", remoteJid: "120363@newsletter", fromMe: false }, message: { conversation: "x" } };
    const empty = { key: { id: "4", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false }, message: { reactionMessage: {} } };
    expect(parseEvolutionWebhook(event([own, status, channel, empty]))).toEqual([]);
    expect(parseEvolutionWebhook(event([{ key: { id: "5", remoteJid: "a@s.whatsapp.net" }, message: { conversation: "x" } }], "connection.update"))).toEqual([]);
    expect(parseEvolutionWebhook(undefined)).toEqual([]);
  });

  it("atende só o primeiro link suportado e ignora vídeo normal do YouTube", () => {
    expect(firstSupportedUrl("https://exemplo.com/a https://x.com/a/status/1 https://www.instagram.com/p/ABC/"))
      .toBe("https://x.com/a/status/1");
    expect(firstSupportedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeUndefined();
    expect(firstSupportedUrl("sem link")).toBeUndefined();
  });
});
