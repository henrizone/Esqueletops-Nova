import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/types/context.js";
import { sendPreparedMedia } from "../src/services/media/sender.js";
import { telegramVideoFilter } from "../src/services/media/convert.js";

describe("álbuns de mídia", () => {
  it("agrupa fotos e vídeos mesmo com botão de origem ativado", async () => {
    const replyWithMediaGroup = vi.fn().mockResolvedValue([
      {
        message_id: 101,
        chat: { id: 123 },
        photo: [{ file_id: "photo-file" }],
      },
      {
        message_id: 102,
        chat: { id: 123 },
        video: { file_id: "video-file" },
      },
    ]);
    const ctx = { replyWithMediaGroup } as unknown as BotContext;

    const cached = await sendPreparedMedia(ctx, [
      { path: "/tmp/photo.jpg", kind: "photo", filename: "photo.jpg", size: 10 },
      { path: "/tmp/video.mp4", kind: "video", filename: "video.mp4", size: 20 },
    ], "Legenda", 99, "https://x.com/test/status/1");

    expect(replyWithMediaGroup).toHaveBeenCalledTimes(1);
    const group = replyWithMediaGroup.mock.calls[0]![0] as Array<{ caption?: string }>;
    expect(group[0]?.caption).toContain("Legenda");
    expect(group[0]?.caption).toContain("Abrir no Twitter/X");
    expect(cached).toEqual([
      { kind: "photo", fileId: "photo-file", filename: "photo.jpg" },
      { kind: "video", fileId: "video-file", filename: "video.mp4" },
    ]);
  });
});

describe("conversão de vídeo", () => {
  it("força dimensões pares e pixels quadrados sem esticar no iOS", () => {
    expect(telegramVideoFilter).toContain("trunc(iw/2)*2");
    expect(telegramVideoFilter).toContain("trunc(ih/2)*2");
    expect(telegramVideoFilter).toContain("iw*sar");
    expect(telegramVideoFilter).toContain("setsar=1");
  });
});
