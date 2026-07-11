import { describe, expect, it } from "vitest";
import { buildTwitterCaption, selectMainTweetMedia } from "../src/services/media/twitter.js";

describe("Twitter/X quote handling", () => {
  const tweet = {
    text: "Kkkkkkkkkkk https://t.co/abc123",
    author: { name: "xeessa", screen_name: "bilyeoongoyangi" },
    media: { all: [{ type: "video", url: "https://video.twimg.com/main.mp4" }] },
    quote: {
      text: "260709 ICN\n#소희 #SOHEE #라이즈 #RIIZE",
      author: { name: "sarah 🍒", screen_name: "cortisnoonyy" },
      media: { all: [{ type: "photo", url: "https://pbs.twimg.com/quoted.jpg" }] },
    },
  };

  it("seleciona somente a mídia do tweet principal", () => {
    expect(selectMainTweetMedia(tweet)).toEqual([
      { type: "video", url: "https://video.twimg.com/main.mp4" },
    ]);
  });

  it("formata o quote como texto e remove o t.co final", () => {
    const caption = buildTwitterCaption(tweet);
    expect(caption).toContain("<b>xeessa (<code>bilyeoongoyangi</code>):</b>");
    expect(caption).toContain("Kkkkkkkkkkk");
    expect(caption).not.toContain("t.co/abc123");
    expect(caption).toContain("<blockquote><i>Quoting</i>");
    expect(caption).toContain("sarah 🍒");
    expect(caption).not.toContain("quoted.jpg");
  });
});
