import { describe, expect, it } from "vitest";
import { buildMediaCaption } from "../src/services/media/caption.js";

describe("perfis clicáveis nas redes sociais", () => {
  it("formata TikTok com o nome clicável e a legenda", () => {
    const caption = buildMediaCaption({
      uploader: "ENHYPEN",
      uploaderId: "enhypen",
      profileUrl: "https://www.tiktok.com/@enhypen",
      description: "Dance challenge ✨",
      webpageUrl: "https://www.tiktok.com/@enhypen/video/123456789",
    }, "https://www.tiktok.com/@enhypen/video/123456789");

    expect(caption).toBe('<a href="https://www.tiktok.com/@enhypen">ENHYPEN</a>\nDance challenge ✨');
  });

  it("formata Reddit com autor clicável e título preservado", () => {
    const caption = buildMediaCaption({
      uploader: "example_user",
      uploaderId: "example_user",
      title: "Título do post",
      description: "Texto do post",
      webpageUrl: "https://www.reddit.com/r/test/comments/abc/title/",
    }, "https://www.reddit.com/r/test/comments/abc/title/");

    expect(caption).toContain('<a href="https://www.reddit.com/user/example_user/">u/example_user</a>');
    expect(caption).toContain("<b>Título do post</b>");
  });
});
