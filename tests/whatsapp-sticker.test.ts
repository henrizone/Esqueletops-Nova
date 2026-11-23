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
    expect(parseFigCommand("/fig")).toEqual({ name: "", explicit: true });
    expect(parseFigCommand("/fig figurinha do henry")).toEqual({ name: "figurinha do henry", explicit: true });
    expect(parseFigCommand("  !FIG   gato   bravo ")).toEqual({ name: "gato bravo", explicit: true });
    expect(parseFigCommand("/sticker")).toEqual({ name: "", explicit: true });
  });

  it("aceita 'fig' sem barra, mas não captura conversa comum", () => {
    expect(parseFigCommand("fig")).toEqual({ name: "", explicit: false });
    expect(parseFigCommand("Fig do henry")).toEqual({ name: "do henry", explicit: false });
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

    const sticker = await buildWhatsAppSticker(photo, "image/jpeg", { name: "figurinha do henry", author: "Esqueletops • Nova" });
    expect(sticker.animated).toBe(false);
    expect(sticker.webp.length).toBeLessThanOrEqual(STATIC_STICKER_MAX_BYTES);
    expect(ANIMATED_STICKER_MAX_BYTES).toBe(500 * 1024);

    const metadata = await sharp(sticker.webp).metadata();
    expect(metadata.format).toBe("webp");
    expect([metadata.width, metadata.height]).toEqual([512, 512]);
    expect(metadata.hasAlpha).toBe(true);

    const exif = exifJson(sticker.webp);
    expect(exif["sticker-pack-name"]).toBe("figurinha do henry");
    expect(exif["sticker-pack-publisher"]).toBe("Esqueletops • Nova");
    expect(sticker.webp.readUInt32LE(4)).toBe(sticker.webp.length - 8);
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
