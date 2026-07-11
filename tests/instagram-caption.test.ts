import { describe, expect, it } from "vitest";
import { buildMediaCaption } from "../src/services/media/caption.js";

describe("legenda do Instagram", () => {
  it("remove o título artificial e deixa o perfil clicável", () => {
    const caption = buildMediaCaption({
      title: "Video by enhypen",
      uploader: "ENHYPEN",
      uploaderId: "enhypen",
      description: "🔥 #JUNGWON #ENHYPEN",
      webpageUrl: "https://www.instagram.com/reel/test/",
    }, "https://www.instagram.com/reel/test/");

    expect(caption).toBe('<a href="https://www.instagram.com/enhypen/">enhypen</a>\n🔥 #JUNGWON #ENHYPEN');
    expect(caption).not.toContain("Video by");
    expect(caption).not.toContain("👤");
  });

  it("não mostra ID numérico interno e recupera o handle do título", () => {
    const caption = buildMediaCaption({
      title: "Video by enhypen",
      uploader: "39673499275",
      uploaderId: "39673499275",
      description: "🔥 #JUNGWON #ENHYPEN",
      webpageUrl: "https://www.instagram.com/reels/DaiNhsfJWCB/",
    }, "https://www.instagram.com/reels/DaiNhsfJWCB/");

    expect(caption).toContain('<a href="https://www.instagram.com/enhypen/">enhypen</a>');
    expect(caption).not.toContain("39673499275");
  });
});
