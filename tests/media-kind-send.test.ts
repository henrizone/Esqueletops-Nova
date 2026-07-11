import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/types/context.js";
import { sendPreparedMedia } from "../src/services/media/sender.js";

describe("envio por tipo de arquivo", () => {
  it("envia imagem como foto, e não como vídeo", async () => {
    const replyWithPhoto = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: 1 },
      photo: [{ file_id: "photo-id" }],
    });
    const replyWithVideo = vi.fn();
    const ctx = { replyWithPhoto, replyWithVideo } as unknown as BotContext;

    const result = await sendPreparedMedia(ctx, [
      { path: "/tmp/test.jpg", kind: "photo", filename: "test.jpg", size: 100 },
    ], "foto");

    expect(replyWithPhoto).toHaveBeenCalledTimes(1);
    expect(replyWithVideo).not.toHaveBeenCalled();
    expect(result[0]?.kind).toBe("photo");
  });

  it("envia áudio como áudio, e não como vídeo ou documento", async () => {
    const replyWithAudio = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: 1 },
      audio: { file_id: "audio-id" },
    });
    const replyWithVideo = vi.fn();
    const replyWithDocument = vi.fn();
    const ctx = { replyWithAudio, replyWithVideo, replyWithDocument } as unknown as BotContext;

    const result = await sendPreparedMedia(ctx, [
      { path: "/tmp/test.mp3", kind: "audio", filename: "test.mp3", size: 100 },
    ], "áudio");

    expect(replyWithAudio).toHaveBeenCalledTimes(1);
    expect(replyWithVideo).not.toHaveBeenCalled();
    expect(replyWithDocument).not.toHaveBeenCalled();
    expect(result[0]?.kind).toBe("audio");
  });

  it("usa documento somente para arquivos sem tipo de mídia suportado", async () => {
    const replyWithDocument = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: 1 },
      document: { file_id: "document-id" },
    });
    const ctx = { replyWithDocument } as unknown as BotContext;

    const result = await sendPreparedMedia(ctx, [
      { path: "/tmp/test.bin", kind: "document", filename: "test.bin", size: 100 },
    ], "arquivo");

    expect(replyWithDocument).toHaveBeenCalledTimes(1);
    expect(result[0]?.kind).toBe("document");
  });
  it("envia vídeo com largura, altura e duração corretas para o iOS", async () => {
    const replyWithVideo = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: 1 },
      video: { file_id: "video-id" },
    });
    const ctx = { replyWithVideo } as unknown as BotContext;

    await sendPreparedMedia(ctx, [
      {
        path: "/tmp/test.mp4",
        kind: "video",
        filename: "test.mp4",
        size: 100,
        width: 720,
        height: 1280,
        duration: 14.2,
      },
    ], "vídeo");

    expect(replyWithVideo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ width: 720, height: 1280, duration: 14, supports_streaming: true }),
    );
  });

});
