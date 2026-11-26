import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { parseEvolutionWebhook } from "../src/services/whatsapp/handler.js";
import {
  ANIMATED_STICKER_MAX_BYTES,
  buildWhatsAppSticker,
  parseFigCommand,
  STATIC_STICKER_MAX_BYTES,
  stickerName,
  withStickerMetadata,
} from "../src/services/whatsapp/sticker.js";

function exifJson(webp: Buffer) {
  const start = webp.indexOf(Buffer.from("EXIF", "latin1"));
  expect(start).toBeGreaterThan(0);
  const size = webp.readUInt32LE(start + 4);
  const exif = webp.subarray(start + 8, start + 8 + size);
  return JSON.parse(exif.subarray(22).toString("utf8")) as Record<string, unknown>;
}

describe("/fig: comando", () => {
  it("aceita /fig com e sem nome, e outros prefixos", () => {
    expect(parseFigCommand("/fig")).toEqual({ name: "", explicit: true, audio: false });
    expect(parseFigCommand("/fig figurinha do henry")).toEqual({ name: "figurinha do henry", explicit: true, audio: false });
    expect(parseFigCommand("  !FIG   gato   bravo ")).toEqual({ name: "gato bravo", explicit: true, audio: false });
    expect(parseFigCommand("/sticker")).toEqual({ name: "", explicit: true, audio: false });
  });

  it("reconhece figurinha com áudio em /audio e /fig audio", () => {
    expect(parseFigCommand("/audio")).toEqual({ name: "", explicit: true, audio: true });
    expect(parseFigCommand("/audio risada do henry")).toEqual({ name: "risada do henry", explicit: true, audio: true });
    expect(parseFigCommand("/fig audio")).toEqual({ name: "", explicit: true, audio: true });
    expect(parseFigCommand("/fig áudio meme")).toEqual({ name: "meme", explicit: true, audio: true });
    expect(parseFigCommand("fig audio")).toEqual({ name: "", explicit: false, audio: true });
    // "audio" sem barra é conversa, não comando; "/fig audiovisual" é só um nome.
    expect(parseFigCommand("audio")).toBeUndefined();
    expect(parseFigCommand("audio ficou baixo")).toBeUndefined();
    expect(parseFigCommand("/fig audiovisual")).toEqual({ name: "audiovisual", explicit: true, audio: false });
  });

  it("aceita 'fig' sem barra, mas não captura conversa comum", () => {
    expect(parseFigCommand("fig")).toEqual({ name: "", explicit: false, audio: false });
    expect(parseFigCommand("Fig do henry")).toEqual({ name: "do henry", explicit: false, audio: false });
    expect(parseFigCommand("figurinha boa essa")).toBeUndefined();
    expect(parseFigCommand("sticker")).toBeUndefined();
    expect(parseFigCommand("que fig legal")).toBeUndefined();
    expect(parseFigCommand("/figueira")).toBeUndefined();
  });

  it("usa o nome pedido ou 'sticker de <pessoa>'", () => {
    expect(stickerName("figurinha do henry", "Henry")).toBe("figurinha do henry");
    expect(stickerName("", "Henry")).toBe("sticker de Henry");
    expect(stickerName("", undefined)).toBe("sticker");
    expect(stickerName("x".repeat(200), "Henry")).toHaveLength(60);
  });
});

describe("/fig: figurinha", () => {
  it("gera WebP 512x512 dentro do limite, com o nome gravado", async () => {
    const photo = await sharp({
      create: { width: 1600, height: 900, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } },
    }).jpeg({ quality: 95 }).toBuffer();

    const sticker = await buildWhatsAppSticker(photo, "image/jpeg", { name: "figurinha do henry", author: "bot de figurinhas" });
    expect(sticker.animated).toBe(false);
    expect(sticker.webp.length).toBeLessThanOrEqual(STATIC_STICKER_MAX_BYTES);
    expect(ANIMATED_STICKER_MAX_BYTES).toBe(500 * 1024);

    const metadata = await sharp(sticker.webp).metadata();
    expect(metadata.format).toBe("webp");
    expect([metadata.width, metadata.height]).toEqual([512, 512]);

    const exif = exifJson(sticker.webp);
    expect(exif["sticker-pack-name"]).toBe("figurinha do henry");
    expect(exif["sticker-pack-publisher"]).toBe("bot de figurinhas");
    expect(sticker.webp.readUInt32LE(4)).toBe(sticker.webp.length - 8);
  });

  it("estica a imagem para preencher o quadrado inteiro, sem bordas", async () => {
    // Metade esquerda vermelha, metade direita azul, em 16:9.
    const half = { width: 800, height: 900, channels: 3 as const };
    const wide = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .composite([{ input: await sharp({ create: { ...half, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer(), left: 0, top: 0 }])
      .png().toBuffer();

    const sticker = await buildWhatsAppSticker(wide, "image/png", { name: "x", author: "" });
    const { data, info } = await sharp(sticker.webp).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([512, 512]);
    const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    // Os quatro cantos têm imagem (nada de faixa transparente em cima/embaixo).
    for (const [x, y] of [[4, 4], [507, 4], [4, 507], [507, 507]] as const) expect(pixel(x, y)[3]).toBe(255);
    expect(pixel(4, 4)[0]).toBeGreaterThan(200);
    expect(pixel(507, 507)[2]).toBeGreaterThan(200);
  });

  it("substitui metadados antigos em vez de duplicar", async () => {
    const base = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .webp().toBuffer();
    const canvas = { width: 512, height: 512, hasAlpha: true };
    const first = withStickerMetadata(base, { name: "um", author: "a" }, canvas);
    const second = withStickerMetadata(first, { name: "dois", author: "b" }, canvas);
    expect(second.toString("latin1").split("EXIF").length - 1).toBe(1);
    expect(exifJson(second)["sticker-pack-name"]).toBe("dois");
    expect((await sharp(second).metadata()).width).toBe(512);
    expect(() => withStickerMetadata(Buffer.from("não é webp"), { name: "x", author: "y" }, canvas)).toThrow();
  });
});

describe("/fig: origem da mídia no webhook", () => {
  const base = { id: "A1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false };

  it("usa a mídia da própria mensagem (foto com legenda /fig)", () => {
    const [message] = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: base,
        pushName: "Henry",
        message: { imageMessage: { caption: "/fig", mediaKey: "abc", fileLength: "12345" } },
      },
    });
    expect(message?.senderName).toBe("Henry");
    expect(message?.stickerSource).toMatchObject({ kind: "image", bytes: 12345 });
    expect(message?.stickerSource?.raw.key).toEqual(base);
    expect(message?.stickerSource?.raw.message).toHaveProperty("imageMessage");
  });

  it("usa a mídia da mensagem respondida", () => {
    const [message] = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { ...base, remoteJid: "123@g.us", participant: "5511888888888@s.whatsapp.net" },
        message: { extendedTextMessage: { text: "/fig gato" } },
        contextInfo: {
          stanzaId: "QUOTED1",
          participant: "5511777777777@s.whatsapp.net",
          quotedMessage: { videoMessage: { seconds: 4, mediaKey: "xyz" } },
        },
      },
    });
    expect(message?.stickerSource).toMatchObject({ kind: "video", seconds: 4 });
    expect(message?.stickerSource?.raw.key).toEqual({
      id: "QUOTED1",
      remoteJid: "123@g.us",
      fromMe: false,
      participant: "5511777777777@s.whatsapp.net",
    });
  });

  it("não inventa mídia quando a mensagem é só texto", () => {
    const [message] = parseEvolutionWebhook({
      event: "messages.upsert",
      data: { key: base, message: { conversation: "/fig" } },
    });
    expect(message?.stickerSource).toBeUndefined();
  });
});
