import { describe, expect, it } from "vitest";
import {
  buildTwitterCaption,
  mergeTweets,
  parseFxTweet,
  parseGraphTweet,
  tweetRemoteItems,
} from "../src/services/media/twitter.js";

const fxQuoteTweet = {
  text: "Kkkkkkkkkkk https://t.co/abc123",
  author: { name: "xeessa", screen_name: "bilyeoongoyangi" },
  media: { all: [{ type: "video", url: "https://video.twimg.com/main.mp4" }] },
  quote: {
    text: "260709 ICN\n#소희 #SOHEE #라이즈 #RIIZE",
    author: { name: "sarah 🍒", screen_name: "cortisnoonyy" },
    media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/quoted.jpg" }] },
  },
};

function graphMedia(index: number) {
  return {
    type: "photo",
    media_url_https: `https://pbs.twimg.com/media/photo${index}.jpg`,
    original_info: { width: 1200, height: 900 },
  };
}

function graphTweet(options: { id: string; name: string; handle: string; text: string; media?: unknown[]; quote?: unknown }) {
  return {
    __typename: "Tweet",
    rest_id: options.id,
    core: { user_results: { result: { legacy: { name: options.name, screen_name: options.handle } } } },
    legacy: {
      full_text: options.text,
      extended_entities: options.media ? { media: options.media } : undefined,
    },
    quoted_status_result: options.quote ? { result: options.quote } : undefined,
  };
}

describe("Twitter/X quote handling", () => {
  it("envia a mídia do tweet principal seguida da mídia do tweet citado", () => {
    const items = tweetRemoteItems(parseFxTweet(fxQuoteTweet));
    expect(items.map((item) => [item.kind, item.url])).toEqual([
      ["video", "https://video.twimg.com/main.mp4"],
      ["photo", "https://pbs.twimg.com/media/quoted.jpg?name=orig"],
    ]);
  });

  it("usa a mídia do quote quando o tweet principal não tem mídia", () => {
    const items = tweetRemoteItems(parseFxTweet({
      text: "comentário",
      author: { name: "autor", screen_name: "autor" },
      media: null,
      quote: {
        text: "tweet citado",
        author: { name: "citado", screen_name: "citado" },
        media: { photos: [{ type: "photo", url: "https://pbs.twimg.com/media/quoted.jpg" }] },
      },
    }));
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("photo");
  });

  it("formata o quote como citação e remove o t.co final", () => {
    const caption = buildTwitterCaption(parseFxTweet(fxQuoteTweet));
    expect(caption).toContain('<a href="https://x.com/bilyeoongoyangi">xeessa (@bilyeoongoyangi)</a>:');
    expect(caption).toContain("Kkkkkkkkkkk");
    expect(caption).not.toContain("t.co/abc123");
    expect(caption).toContain("<blockquote><i>Quoting</i>");
    expect(caption).toContain('<a href="https://x.com/cortisnoonyy">sarah 🍒 (@cortisnoonyy)</a>');
    expect(caption).toContain("#RIIZE</blockquote>");
    expect(caption).not.toContain("quoted.jpg");
  });

  it("lê autor, texto, mídias e quote direto do GraphQL", () => {
    const parsed = parseGraphTweet({
      __typename: "TweetWithVisibilityResults",
      tweet: graphTweet({
        id: "2",
        name: "Autora",
        handle: "autora",
        text: "olha isso &amp; aquilo https://t.co/zzz",
        quote: graphTweet({
          id: "1",
          name: "Citado",
          handle: "citado",
          text: "original",
          media: [graphMedia(1), {
            type: "video",
            media_url_https: "https://pbs.twimg.com/thumb.jpg",
            original_info: { width: 1080, height: 1920 },
            video_info: {
              duration_millis: 10_000,
              variants: [
                { content_type: "application/x-mpegURL", url: "https://video.twimg.com/pl.m3u8" },
                { content_type: "video/mp4", bitrate: 832_000, url: "https://video.twimg.com/low.mp4" },
                { content_type: "video/mp4", bitrate: 2_176_000, url: "https://video.twimg.com/high.mp4" },
              ],
            },
          }],
        }),
      }),
    })!;

    expect(parsed.author).toEqual({ name: "Autora", username: "autora" });
    expect(parsed.text).toBe("olha isso & aquilo");
    expect(parsed.media).toEqual([]);
    expect(parsed.quote?.author?.username).toBe("citado");

    const items = tweetRemoteItems(parsed);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "photo",
      url: "https://pbs.twimg.com/media/photo1.jpg?name=orig",
      fallbackUrls: ["https://pbs.twimg.com/media/photo1.jpg"],
    });
    expect(items[1]).toMatchObject({
      kind: "video",
      url: "https://video.twimg.com/high.mp4",
      fallbackUrls: ["https://video.twimg.com/low.mp4"],
      duration: 10,
    });

    const caption = buildTwitterCaption(parsed);
    expect(caption).toContain("olha isso &amp; aquilo");
    expect(caption).toContain('<a href="https://x.com/citado">Citado (@citado)</a>');
  });

  it("mantém as 20 mídias de um tweet", () => {
    const parsed = parseGraphTweet(graphTweet({
      id: "3",
      name: "Fotos",
      handle: "fotos",
      text: "vinte",
      media: Array.from({ length: 20 }, (_, index) => graphMedia(index + 1)),
    }))!;
    expect(tweetRemoteItems(parsed)).toHaveLength(20);
  });

  it("deixa por último a variante de vídeo que não cabe no limite de upload", () => {
    const parsed = parseGraphTweet(graphTweet({
      id: "4",
      name: "Longo",
      handle: "longo",
      text: "vídeo longo",
      media: [{
        type: "video",
        media_url_https: "https://pbs.twimg.com/thumb.jpg",
        video_info: {
          duration_millis: 600_000,
          variants: [
            { content_type: "video/mp4", bitrate: 10_000_000, url: "https://video.twimg.com/huge.mp4" },
            { content_type: "video/mp4", bitrate: 500_000, url: "https://video.twimg.com/fits.mp4" },
          ],
        },
      }],
    }))!;
    expect(parsed.media[0]?.url).toBe("https://video.twimg.com/fits.mp4");
    expect(parsed.media[0]?.fallbackUrls).toEqual(["https://video.twimg.com/huge.mp4"]);
  });

  it("combina FxTwitter (texto) com GraphQL (variantes de mídia)", () => {
    const fx = parseFxTweet({
      text: "texto do fx",
      author: { name: "A", screen_name: "a" },
      media: { all: [{ type: "photo", url: "https://pbs.twimg.com/media/photo1.jpg?name=orig" }] },
    });
    const graph = parseGraphTweet(graphTweet({
      id: "5",
      name: "A",
      handle: "a",
      text: "texto do graph",
      media: [graphMedia(1), graphMedia(2)],
    }));
    const merged = mergeTweets(fx, graph)!;
    expect(merged.text).toBe("texto do fx");
    expect(merged.media).toHaveLength(2);
    expect(mergeTweets(undefined, graph)).toBe(graph);
    expect(mergeTweets(fx, undefined)).toBe(fx);
  });
});
