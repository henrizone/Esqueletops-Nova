import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectMediaKind,
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

  it("preserva vídeo vertical sem forçar quadrado", () => {
    expect(targetVideoDimensions({ width: 1080, height: 1920, sample_aspect_ratio: "1:1" }))
      .toEqual({ width: 720, height: 1280 });
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
    })).toEqual({ width: 720, height: 1280 });
  });

  it("usa 30 fps, pixels quadrados e dimensões explícitas", () => {
    const filter = telegramVideoFilter({ width: 720, height: 1280 });
    expect(filter).toContain("scale=720:1280");
    expect(filter).toContain("setsar=1");
    expect(filter).toContain("fps=30");
    expect(filter).toContain("format=yuv420p");
  });

  it("limita Reel 720p a bitrate próximo do SmudgeLord", () => {
    expect(targetVideoBitrate(720, 1280, 14)).toBe(2_000_000);
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
