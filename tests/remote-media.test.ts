import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/types/context.js";
import { sendRemoteMedia } from "../src/services/media/sender.js";

describe("envio remoto rápido", () => {
  it("envia foto e vídeo juntos como um media group", async () => {
    const replyWithMediaGroup = vi.fn().mockResolvedValue([
      { message_id: 1, chat: { id: 10 }, photo: [{ file_id: "p" }] },
      { message_id: 2, chat: { id: 10 }, video: { file_id: "v" } },
    ]);
    const ctx = { replyWithMediaGroup } as unknown as BotContext;

    const cached = await sendRemoteMedia(ctx, [
      { kind: "photo", url: "https://example.com/a.jpg" },
      { kind: "video", url: "https://example.com/b.mp4", fallbackUrls: ["https://example.com/b-small.mp4"] },
    ], "Tweet", 50, "https://x.com/u/status/1");

    expect(replyWithMediaGroup).toHaveBeenCalledTimes(1);
    const group = replyWithMediaGroup.mock.calls[0]![0] as Array<{ caption?: string }>;
    expect(group).toHaveLength(2);
    expect(group[0]?.caption).toContain("Tweet");
    expect(group[0]?.caption).toContain("Abrir no Twitter/X");
    expect(cached).toEqual([
      { kind: "photo", fileId: "p" },
      { kind: "video", fileId: "v" },
    ]);
  });
});
