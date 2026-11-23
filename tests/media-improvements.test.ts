import { describe, expect, it, vi } from "vitest";
import type { BotContext } from "../src/types/context.js";
import { buildMediaCaption, fitCaption } from "../src/services/media/caption.js";
import {
  firstCompleteNode,
  instagramNodeIsComplete,
  instagramNodeRemoteItems,
  instagramShortcode,
  isInstagramPostUrl,
  isInstagramReelUrl,
  isInstagramShareUrl,
} from "../src/services/media/instagram.js";
import { PartialSendError, remoteSendPlans, sendRemoteMedia } from "../src/services/media/sender.js";
import type { RemoteMediaItem } from "../src/services/media/types.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("Instagram: links e completude", () => {
  it("reconhece posts, reels, IGTV e links de compartilhamento", () => {
    expect(isInstagramPostUrl("https://www.instagram.com/p/ABC123/")).toBe(true);
    expect(isInstagramPostUrl("https://www.instagram.com/usuario/reel/ABC123/")).toBe(true);
    expect(isInstagramPostUrl("https://www.instagram.com/tv/ABC123/")).toBe(true);
    expect(isInstagramPostUrl("https://www.instagram.com/share/reel/BAxyz_1")).toBe(true);
    expect(isInstagramPostUrl("https://www.instagram.com/usuario/")).toBe(false);
    expect(isInstagramReelUrl("https://www.instagram.com/share/reel/BAxyz_1")).toBe(true);
  });

  it("não confunde o código de um link /share/ com o shortcode", () => {
    expect(isInstagramShareUrl("https://www.instagram.com/share/p/BAxyz_1")).toBe(true);
    expect(isInstagramShareUrl("https://www.instagram.com/p/ABC123/")).toBe(false);
    expect(() => instagramShortcode("https://www.instagram.com/share/reel/BAxyz_1")).toThrow();
    expect(instagramShortcode("https://www.instagram.com/usuario/p/ABC123/?img_index=2")).toBe("ABC123");
  });

  it("rejeita carrossel em que um vídeo veio sem URL", () => {
    const node = {
      __typename: "GraphSidecar",
      edge_sidecar_to_children: {
        edges: [
          { node: { __typename: "GraphImage", display_url: "https://cdn/photo.jpg" } },
          { node: { __typename: "GraphVideo", is_video: true, display_url: "https://cdn/thumb.jpg" } },
        ],
      },
    };
    expect(instagramNodeIsComplete(node)).toBe(false);
    node.edge_sidecar_to_children.edges[1]!.node = {
      __typename: "GraphVideo",
      is_video: true,
      display_url: "https://cdn/thumb.jpg",
      video_url: "https://cdn/video.mp4",
    } as never;
    expect(instagramNodeIsComplete(node)).toBe(true);
  });

  it("mantém os 20 itens de um carrossel", () => {
    const items = instagramNodeRemoteItems({
      __typename: "GraphSidecar",
      edge_sidecar_to_children: {
        edges: Array.from({ length: 20 }, (_, index) => ({
          node: { __typename: "GraphImage", display_url: `https://cdn/photo-${index}.jpg` },
        })),
      },
    });
    expect(items).toHaveLength(20);
  });

  it("dispara a próxima fonte sem esperar a primeira terminar", async () => {
    const complete = { __typename: "GraphImage", display_url: "https://cdn/ok.jpg" };
    const slow = vi.fn(async () => { await sleep(300); return complete; });
    const fast = vi.fn(async () => ({ ...complete, id: "fast" }));
    const startedAt = Date.now();
    const node = await firstCompleteNode([slow, fast], 20);
    expect(node?.id).toBe("fast");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("pula fontes que falham ou voltam incompletas", async () => {
    const node = await firstCompleteNode([
      async () => { throw new Error("HTTP 401"); },
      async () => ({ __typename: "GraphVideo", is_video: true, display_url: "https://cdn/capa.jpg" }),
      async () => ({ __typename: "GraphVideo", is_video: true, video_url: "https://cdn/v.mp4" }),
    ], 1000);
    expect(node?.video_url).toBe("https://cdn/v.mp4");
    expect(await firstCompleteNode([async () => undefined], 10)).toBeUndefined();
  });
});

describe("envio remoto: qualidade e álbuns", () => {
  const photo = (index: number): RemoteMediaItem => ({ kind: "photo", url: `https://pbs.twimg.com/media/${index}.jpg` });

  it("tenta a melhor variante por URL e depois por streaming antes de reduzir a qualidade", () => {
    const plans = remoteSendPlans({
      kind: "video",
      url: "https://video.twimg.com/high.mp4",
      fallbackUrls: ["https://video.twimg.com/low.mp4"],
    });
    expect(plans).toEqual([
      { url: "https://video.twimg.com/high.mp4", direct: true },
      { url: "https://video.twimg.com/high.mp4", direct: false },
      { url: "https://video.twimg.com/low.mp4", direct: true },
      { url: "https://video.twimg.com/low.mp4", direct: false },
    ]);
  });

  it("não entrega ao Telegram por URL um vídeo acima de 20 MB nem CDN desconhecido", () => {
    expect(remoteSendPlans({
      kind: "video",
      url: "https://video.twimg.com/big.mp4",
      sizeBytes: 40 * 1024 * 1024,
    })).toEqual([{ url: "https://video.twimg.com/big.mp4", direct: false }]);
    expect(remoteSendPlans({ kind: "photo", url: "https://twimg.com.exemplo.net/a.jpg" }))
      .toEqual([{ url: "https://twimg.com.exemplo.net/a.jpg", direct: false }]);
  });

  it("divide 20 mídias em dois álbuns de 10, com legenda só no primeiro", async () => {
    const replyWithMediaGroup = vi.fn(async (group: unknown[]) => group.map((_, index) => ({
      message_id: index,
      chat: { id: 1 },
      photo: [{ file_id: `file-${index}` }],
    })));
    const ctx = { replyWithMediaGroup } as unknown as BotContext;

    const cached = await sendRemoteMedia(
      ctx,
      Array.from({ length: 20 }, (_, index) => photo(index)),
      "Legenda",
      7,
      "https://x.com/u/status/1",
    );

    expect(cached).toHaveLength(20);
    expect(replyWithMediaGroup).toHaveBeenCalledTimes(2);
    const [first, second] = replyWithMediaGroup.mock.calls.map((call) => call[0] as Array<{ caption?: string }>);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(first![0]?.caption).toContain("Legenda");
    expect(second!.every((item) => !item.caption)).toBe(true);
  });

  it("informa o que já foi enviado quando o segundo álbum falha", async () => {
    let call = 0;
    const replyWithMediaGroup = vi.fn(async (group: unknown[]) => {
      call += 1;
      if (call > 1) throw new Error("Bad Request: PHOTO_INVALID_DIMENSIONS");
      return group.map((_, index) => ({ message_id: index, chat: { id: 1 }, photo: [{ file_id: `file-${index}` }] }));
    });
    const ctx = { replyWithMediaGroup } as unknown as BotContext;

    const error = await sendRemoteMedia(ctx, Array.from({ length: 12 }, (_, index) => photo(index)), "Legenda")
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PartialSendError);
    expect((error as PartialSendError).sentCount).toBe(10);
    expect((error as PartialSendError).sent).toHaveLength(10);
  });
});

describe("legendas", () => {
  it("não corta HTML no meio de uma tag", () => {
    const html = `<a href="https://x.com/${"a".repeat(1200)}">autor</a>:\ntexto curto`;
    expect(fitCaption(html)).toBe(html);
  });

  it("vira texto simples truncado quando o texto visível não cabe", () => {
    const fitted = fitCaption(`<b>${"x".repeat(1500)}</b> &amp; fim`);
    expect(fitted).not.toContain("<b>");
    expect(fitted.length).toBeLessThanOrEqual(980);
  });

  it("mantém a legenda pronta do extrator intacta", () => {
    const captionHtml = '<a href="https://x.com/a">A (@a)</a>:\noi\n<blockquote><i>Quoting</i> B:\ntchau</blockquote>';
    expect(buildMediaCaption({ captionHtml }, "https://x.com/a/status/1")).toBe(captionHtml);
  });
});
