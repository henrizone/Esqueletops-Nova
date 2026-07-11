import { describe, expect, it } from "vitest";
import {
  extractInstagramSingleImage,
  instagramNodeRemoteItems,
  instagramPageExpectsVideo,
} from "../src/services/media/instagram.js";
import { instagramRemoteItemsFromInfo } from "../src/services/media/ytdlp.js";

describe("Instagram compatível com o fluxo do SmudgeLord", () => {
  it("extrai imagem única do HTML do embed quando não há gql_data", () => {
    const html = `
      <div data-media-type="GraphImage">
        <div class="Content Foo"><img src="https://cdninstagram.com/photo.jpg?x=1&amp;y=2"></div>
        <div class="Caption"><a class="CaptionUsername" data-log-event="captionProfileClick" target="_blank">tbzuyeon</a>
        legenda da foto<div></div>
      </div>`;
    const result = extractInstagramSingleImage(html);
    expect(result?.node.display_url).toBe("https://cdninstagram.com/photo.jpg?x=1&y=2");
    expect(result?.node.owner?.username).toBe("tbzuyeon");
  });


  it("não aceita thumbnail de Reel como se fosse foto da publicação", () => {
    const html = `
      <meta property="og:title" content="Video by artista">
      <meta property="og:image" content="https://cdninstagram.com/reel-cover.jpg">
    `;
    expect(instagramPageExpectsVideo("https://www.instagram.com/reel/ABC123/", html)).toBe(true);
    expect(extractInstagramSingleImage(html)?.node.display_url).toBe("https://cdninstagram.com/reel-cover.jpg");
  });

  it("reconhece vídeo publicado em /p/ por sinais fortes do HTML", () => {
    const html = `
      <meta property="og:type" content="video.other">
      <meta property="og:image" content="https://cdninstagram.com/video-cover.jpg">
    `;
    expect(instagramPageExpectsVideo("https://www.instagram.com/p/ABC123/", html)).toBe(true);
  });

  it("mantém foto real como foto", () => {
    const html = `
      <meta property="og:title" content="Photo by artista">
      <meta property="og:image" content="https://cdninstagram.com/photo.jpg">
      <div data-media-type="GraphImage"></div>
    `;
    expect(instagramPageExpectsVideo("https://www.instagram.com/p/ABC123/", html)).toBe(false);
  });

  it("mantém fotos e vídeos de um carrossel na ordem", () => {
    const items = instagramNodeRemoteItems({
      __typename: "GraphSidecar",
      edge_sidecar_to_children: {
        edges: [
          { node: { __typename: "GraphImage", display_url: "https://cdn/photo.jpg" } },
          { node: { __typename: "GraphVideo", is_video: true, video_url: "https://cdn/video.mp4", display_url: "https://cdn/thumb.jpg" } },
        ],
      },
    });
    expect(items.map((item) => item.kind)).toEqual(["photo", "video"]);
    expect(items[1]?.thumbnailUrl).toBe("https://cdn/thumb.jpg");
  });

  it("recupera imagens do JSON do yt-dlp mesmo com No video formats found", () => {
    const items = instagramRemoteItemsFromInfo({
      entries: [
        { id: "one", ext: "jpg", thumbnail: "https://cdn/one.jpg" },
        { id: "two", thumbnails: [{ url: "https://cdn/two-small.jpg", width: 320, height: 320 }, { url: "https://cdn/two.jpg", width: 1080, height: 1080 }] },
      ],
    });
    expect(items).toEqual([
      { kind: "photo", url: "https://cdn/one.jpg", width: undefined, height: undefined },
      { kind: "photo", url: "https://cdn/two.jpg", width: undefined, height: undefined },
    ]);
  });

  it("recupera álbum misto do JSON do yt-dlp", () => {
    const items = instagramRemoteItemsFromInfo({
      entries: [
        { id: "photo", thumbnail: "https://cdn/photo.jpg" },
        {
          id: "video",
          duration: 12,
          thumbnail: "https://cdn/thumb.jpg",
          formats: [
            { url: "https://cdn/video-720.mp4", ext: "mp4", vcodec: "h264", height: 720, width: 720, tbr: 1000 },
            { url: "https://cdn/video-360.mp4", ext: "mp4", vcodec: "h264", height: 360, width: 360, tbr: 500 },
          ],
        },
      ],
    });
    expect(items[0]).toMatchObject({ kind: "photo", url: "https://cdn/photo.jpg" });
    expect(items[1]).toMatchObject({
      kind: "video",
      url: "https://cdn/video-720.mp4",
      fallbackUrls: ["https://cdn/video-360.mp4"],
      duration: 12,
    });
  });
});
