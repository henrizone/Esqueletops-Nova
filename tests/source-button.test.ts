import { describe, expect, it } from "vitest";
import { sourceButtonLabel } from "../src/services/media/source-button.js";
import { cleanLegacyPackTitle } from "../src/modules/stickers.js";

describe("botões de origem", () => {
  it("usa o nome correto da plataforma", () => {
    expect(sourceButtonLabel("https://www.instagram.com/p/abc/")).toBe("Abrir no Instagram");
    expect(sourceButtonLabel("https://x.com/user/status/1")).toBe("Abrir no Twitter/X");
  });
});

describe("títulos de pacotes", () => {
  it("remove sufixos antigos de formato sem alterar o restante", () => {
    expect(cleanLegacyPackTitle("Henry • Nova (vídeo)")).toBe("Henry • Nova");
    expect(cleanLegacyPackTitle("Memes (animated)")).toBe("Memes");
    expect(cleanLegacyPackTitle("Vídeos legais")).toBe("Vídeos legais");
  });
});
