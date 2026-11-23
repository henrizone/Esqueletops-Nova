import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectMediaKind,
  isFastStartMp4,
  photoWidthWithinTelegramLimits,
  prepareMediaFiles,
  targetVideoBitrate,
  targetVideoDimensions,
  telegramVideoFilter,
  TELEGRAM_PHOTO_EXTENSION,
  TELEGRAM_VIDEO_EXTENSION,
  TELEGRAM_VIDEO_FPS,
} from "../src/services/media/convert.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("normalização única de mídia", () => {
  it("define JPEG para fotos e MP4 para vídeos", () => {
    expect(TELEGRAM_PHOTO_EXTENSION).toBe(".jpg");
    expect(TELEGRAM_VIDEO_EXTENSION).toBe(".mp4");
    expect(TELEGRAM_VIDEO_FPS).toBe(30);
  });

  it("converte PNG para JPEG sem alterar as dimensões", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esqueletops-photo-test-"));
    directories.push(directory);
    const input = join(directory, "imagem.png");
    await sharp({
      create: { width: 123, height: 77, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } },
    }).png().toFile(input);

    const [prepared] = await prepareMediaFiles([input]);
    expect(prepared?.kind).toBe("photo");
    expect(extname(prepared?.path ?? "")).toBe(".jpg");
    const metadata = await sharp(prepared!.path).metadata();
    expect(metadata.width).toBe(123);
    expect(metadata.height).toBe(77);
  });

  it("preserva vídeo vertical 1080p sem reduzir nem forçar quadrado", () => {
    expect(targetVideoDimensions({ width: 1080, height: 1920, sample_aspect_ratio: "1:1" }))
      .toEqual({ width: 1080, height: 1920 });
  });

  it("reduz apenas o que passa da borda máxima, mantendo a proporção", () => {
    expect(targetVideoDimensions({ width: 2160, height: 3840, sample_aspect_ratio: "1:1" }))
      .toEqual({ width: 1080, height: 1920 });
  });

  it("corrige vídeo anamórfico sem achatar", () => {
    expect(targetVideoDimensions({
      width: 720,
      height: 576,
      sample_aspect_ratio: "16:15",
      display_aspect_ratio: "4:3",
    })).toEqual({ width: 768, height: 576 });
  });

  it("considera rotação antes de definir as dimensões finais", () => {
    expect(targetVideoDimensions({
      width: 1920,
      height: 1080,
      sample_aspect_ratio: "1:1",
      side_data_list: [{ rotation: 90 }],
    })).toEqual({ width: 1080, height: 1920 });
  });

  it("usa 30 fps, pixels quadrados e dimensões explícitas", () => {
    const filter = telegramVideoFilter({ width: 720, height: 1280 });
    expect(filter).toContain("scale=720:1280");
    expect(filter).toContain("setsar=1");
    expect(filter).toContain("fps=30");
    expect(filter).toContain("format=yuv420p");
  });

  it("usa o bitrate máximo configurado quando o vídeo curto precisa ser recodificado", () => {
    expect(targetVideoBitrate(720, 1280, 14)).toBe(6_000_000);
  });

  it("reduz o bitrate de vídeos longos para caber no limite de upload", () => {
    expect(targetVideoBitrate(720, 1280, 600)).toBeLessThan(700_000);
  });

  it("mantém JPEG compatível sem recomprimir", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esqueletops-jpeg-test-"));
    directories.push(directory);
    const input = join(directory, "foto.jpg");
    await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 30, b: 90 } },
    }).jpeg({ quality: 97 }).toFile(input);
    const original = await readFile(input);

    const [prepared] = await prepareMediaFiles([input]);
    expect(prepared?.kind).toBe("photo");
    expect((await readFile(prepared!.path)).equals(original)).toBe(true);
  });

  it("reduz foto que excede o limite de dimensões do Telegram", async () => {
    expect(photoWidthWithinTelegramLimits(1080, 1350)).toBeUndefined();
    const width = photoWidthWithinTelegramLimits(2000, 12000)!;
    expect(width + Math.round(width * 6)).toBeLessThanOrEqual(10_000);

    const directory = await mkdtemp(join(tmpdir(), "esqueletops-tall-test-"));
    directories.push(directory);
    const input = join(directory, "alta.jpg");
    await sharp({
      create: { width: 1000, height: 11000, channels: 3, background: { r: 10, g: 10, b: 10 } },
    }).jpeg().toFile(input);

    const [prepared] = await prepareMediaFiles([input]);
    const metadata = await sharp(prepared!.path).metadata();
    expect((metadata.width ?? 0) + (metadata.height ?? 0)).toBeLessThanOrEqual(10_000);
  });

  it("reconhece MP4 faststart pela ordem dos átomos", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esqueletops-mp4-test-"));
    directories.push(directory);
    const box = (type: string, payload = 0) => {
      const buffer = Buffer.alloc(8 + payload);
      buffer.writeUInt32BE(8 + payload, 0);
      buffer.write(type, 4, "latin1");
      return buffer;
    };
    const fast = join(directory, "fast.mp4");
    const slow = join(directory, "slow.mp4");
    await writeFile(fast, Buffer.concat([box("ftyp", 8), box("moov", 16), box("mdat", 32)]));
    await writeFile(slow, Buffer.concat([box("ftyp", 8), box("mdat", 32), box("moov", 16)]));
    expect(await isFastStartMp4(fast)).toBe(true);
    expect(await isFastStartMp4(slow)).toBe(false);
  });

  it("classifica GIF como vídeo antes do envio", async () => {
    const directory = await mkdtemp(join(tmpdir(), "esqueletops-gif-test-"));
    directories.push(directory);
    const input = join(directory, "animacao.gif");
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
    await writeFile(input, gif);
    expect(await detectMediaKind(input)).toBe("video");
    expect((await readFile(input)).length).toBeGreaterThan(0);
  });
});
