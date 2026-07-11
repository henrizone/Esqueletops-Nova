import { describe, expect, it } from "vitest";
import { youtubeChoiceMeta } from "../src/services/media/youtube.js";

describe("YouTube dedicado", () => {
  it("separa estimativa de vídeo e áudio", () => {
    const result = youtubeChoiceMeta({
      id: "abc",
      title: "Teste",
      duration: 125,
      formats: [
        { ext: "mp4", vcodec: "h264", acodec: "none", height: 720, filesize: 10 * 1024 * 1024 },
        { ext: "m4a", vcodec: "none", acodec: "aac", abr: 128, filesize: 2 * 1024 * 1024 },
      ],
    });
    expect(result.duration).toBe("2:05");
    expect(result.videoSize).toBe("12.0 MB");
    expect(result.audioSize).toBe("2.0 MB");
  });
});
