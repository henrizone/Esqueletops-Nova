import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { execa } from "execa";
import { InputFile } from "grammy";
import type { InputSticker, Message } from "grammy/types";
import sharp from "sharp";
import { env } from "../config/env.js";
import type { BotContext } from "../types/context.js";
import type { StickerFormat } from "../database/repositories.js";

export interface PreparedSticker {
  format: StickerFormat;
  input: InputFile | string;
  emoji: string;
  cleanup?: () => Promise<void>;
}

function sourceMessage(ctx: BotContext): Message | undefined {
  return ctx.message?.reply_to_message ?? ctx.message;
}

async function downloadTelegramFile(ctx: BotContext, fileId: string, extension = "bin") {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram não retornou o caminho do arquivo");
  const directory = await mkdtemp(join(tmpdir(), "esqueletops-nova-sticker-"));
  const path = join(directory, `source.${extension.replace(/^\./, "")}`);
  const root = env.BOT_API_URL.replace(/\/$/, "");
  const url = `${root}/file/bot${env.TELEGRAM_TOKEN}/${file.file_path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Falha ao baixar arquivo do Telegram: HTTP ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { directory, path };
}

async function toStaticSticker(input: string, output: string) {
  for (const size of [512, 480, 448, 416, 384, 352]) {
    for (const quality of [90, 80, 70, 60, 50]) {
      await sharp(input).rotate().resize({ width: size, height: size, fit: "inside", withoutEnlargement: false })
        .webp({ quality, effort: 6, alphaQuality: quality }).toFile(output);
      if ((await stat(output)).size <= 512 * 1024) return;
    }
  }
  throw new Error("A figurinha estática não pôde ser reduzida para 512 KB");
}

async function toVideoSticker(input: string, output: string) {
  await execa(env.FFMPEG_BINARY, [
    "-y", "-i", input, "-t", "3", "-an", "-vf",
    "fps=30,scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)':force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p",
    "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "4", "-b:v", "0", "-crf", "38", "-row-mt", "1", "-auto-alt-ref", "0", output,
  ], { timeout: 120_000 });
  if ((await stat(output)).size > 256 * 1024) {
    await execa(env.FFMPEG_BINARY, [
      "-y", "-i", input, "-t", "3", "-an", "-vf",
      "fps=24,scale='if(gt(iw,ih),384,-2)':'if(gt(iw,ih),-2,384)':force_original_aspect_ratio=decrease,pad=384:384:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p",
      "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", "5", "-b:v", "0", "-crf", "46", "-row-mt", "1", "-auto-alt-ref", "0", output,
    ], { timeout: 120_000 });
  }
  if ((await stat(output)).size > 256 * 1024) throw new Error("A figurinha de vídeo excede 256 KB");
}

export async function prepareStickerFromMessage(ctx: BotContext, emoji = "✨"): Promise<PreparedSticker> {
  const message = sourceMessage(ctx);
  if (!message) throw new Error("Mídia não encontrada");
  if (message.sticker) {
    const sticker = message.sticker;
    return { format: sticker.is_video ? "video" : sticker.is_animated ? "animated" : "static", input: sticker.file_id, emoji: emoji || sticker.emoji || "✨" };
  }

  let fileId: string | undefined;
  let extension = "bin";
  let format: StickerFormat = "static";
  if (message.photo?.length) { fileId = message.photo.at(-1)?.file_id; extension = "jpg"; }
  else if (message.document?.file_id && message.document.mime_type?.startsWith("image/")) { fileId = message.document.file_id; extension = extname(message.document.file_name ?? "image.png") || "png"; }
  else if (message.video?.file_id) { fileId = message.video.file_id; extension = "mp4"; format = "video"; }
  else if (message.animation?.file_id) { fileId = message.animation.file_id; extension = extname(message.animation.file_name ?? "animation.mp4") || "mp4"; format = "video"; }
  if (!fileId) throw new Error("UNSUPPORTED_STICKER_SOURCE");

  const downloaded = await downloadTelegramFile(ctx, fileId, extension);
  const output = join(downloaded.directory, format === "video" ? "sticker.webm" : "sticker.webp");
  if (format === "video") await toVideoSticker(downloaded.path, output); else await toStaticSticker(downloaded.path, output);
  return { format, input: new InputFile(output), emoji: emoji || "✨", cleanup: () => rm(downloaded.directory, { recursive: true, force: true }) };
}

export function stickerInput(prepared: PreparedSticker): InputSticker {
  return { sticker: prepared.input, format: prepared.format, emoji_list: [prepared.emoji] };
}

export async function createPackWithSticker(ctx: BotContext, userId: number, name: string, title: string, prepared: PreparedSticker) {
  await ctx.api.createNewStickerSet(userId, name, title.slice(0, 64), [stickerInput(prepared)]);
}

export async function addStickerToPack(ctx: BotContext, userId: number, name: string, prepared: PreparedSticker) {
  await ctx.api.addStickerToSet(userId, name, stickerInput(prepared));
}

export async function getPackSize(ctx: BotContext, name: string) {
  return (await ctx.api.getStickerSet(name)).stickers.length;
}

export async function deleteTelegramStickerPack(ctx: BotContext, name: string) {
  await ctx.api.deleteStickerSet(name);
}

export async function exportSticker(ctx: BotContext): Promise<{ input: InputFile; filename: string; cleanup: () => Promise<void> }> {
  const sticker = sourceMessage(ctx)?.sticker;
  if (!sticker) throw new Error("STICKER_REQUIRED");
  const extension = sticker.is_animated ? "tgs" : sticker.is_video ? "webm" : "webp";
  const downloaded = await downloadTelegramFile(ctx, sticker.file_id, extension);
  if (sticker.is_animated || sticker.is_video) {
    return { input: new InputFile(downloaded.path, `sticker.${extension}`), filename: `sticker.${extension}`, cleanup: () => rm(downloaded.directory, { recursive: true, force: true }) };
  }
  const png = join(downloaded.directory, "sticker.png");
  await sharp(await readFile(downloaded.path)).png().toFile(png);
  return { input: new InputFile(png, "sticker.png"), filename: "sticker.png", cleanup: () => rm(downloaded.directory, { recursive: true, force: true }) };
}
