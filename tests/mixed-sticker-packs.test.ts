import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("pacotes mistos", () => {
  it("mantém apenas um pacote padrão por usuário", async () => {
    const migrations = await readFile(new URL("../src/database/migrations.ts", import.meta.url), "utf8");
    expect(migrations).toContain("sticker_packs_default_per_user");
    expect(migrations).toContain("DROP INDEX IF EXISTS sticker_packs_default_per_format");
  });

  it("usa limite de 120 para qualquer formato", async () => {
    const module = await readFile(new URL("../src/modules/stickers.ts", import.meta.url), "utf8");
    expect(module).toContain("const limit = 120");
    expect(module).not.toContain("prepared.format === \"static\"");
  });
});
