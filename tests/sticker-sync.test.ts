import { describe, expect, it } from "vitest";
import { isStickerSetInvalidError } from "../src/services/stickers.js";

describe("sincronização de pacotes apagados", () => {
  it("detecta GrammyError serializado", () => {
    expect(isStickerSetInvalidError({
      error_code: 400,
      description: "Bad Request: STICKERSET_INVALID",
    })).toBe(true);
  });

  it("detecta erro encapsulado", () => {
    expect(isStickerSetInvalidError({
      cause: { message: "Bad Request: sticker set not found" },
    })).toBe(true);
  });

  it("não classifica erro de rede como pacote inexistente", () => {
    expect(isStickerSetInvalidError(new Error("fetch failed: ECONNRESET"))).toBe(false);
  });
});
