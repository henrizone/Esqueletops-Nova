import { describe, expect, it } from "vitest";
import { buildMediaCaption } from "../src/services/media/caption.js";

describe("legenda do Instagram", () => {
  it("remove o título artificial Video by e não repete o perfil", () => {
    const caption = buildMediaCaption({
      title: "Video by enhypen",
      uploader: "ENHYPEN",
      uploaderId: "enhypen",
      description: "🔥 #JUNGWON #ENHYPEN",
      webpageUrl: "https://www.instagram.com/reel/test/",
    }, "https://www.instagram.com/reel/test/");

    expect(caption).toBe("<b>enhypen</b>\n🔥 #JUNGWON #ENHYPEN");
    expect(caption).not.toContain("Video by");
    expect(caption).not.toContain("👤");
  });
});
