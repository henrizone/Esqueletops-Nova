import { describe, expect, it } from "vitest";
import { extractUrls, isAllowedMediaUrl, isAutoMediaUrl, mediaCacheKey, normalizeUrl } from "../src/services/media/urls.js";

describe("media URLs", () => {
  it("extrai links e remove pontuação final", () => {
    expect(extractUrls("Veja https://www.instagram.com/p/abc/?utm_source=x, agora")).toEqual(["https://www.instagram.com/p/abc/?utm_source=x"]);
  });
  it("aceita domínios suportados e rejeita genéricos", () => {
    expect(isAllowedMediaUrl("https://x.com/user/status/1")).toBe(true);
    expect(isAllowedMediaUrl("https://example.com/video")).toBe(false);
  });
  it("normaliza parâmetros de rastreamento para o cache", () => {
    expect(normalizeUrl("https://youtu.be/abc?si=123&utm_source=test")).toBe("https://youtu.be/abc");
    expect(mediaCacheKey("https://youtu.be/abc?si=123", "video")).toBe(mediaCacheKey("https://youtu.be/abc", "video"));
  });
  it("replica o detector do SmudgeLord para YouTube", () => {
    expect(isAutoMediaUrl("https://www.youtube.com/shorts/abc123")).toBe(true);
    expect(isAutoMediaUrl("https://www.youtube.com/watch?v=abc123")).toBe(false);
    expect(isAutoMediaUrl("https://youtu.be/abc123")).toBe(false);
  });
});
