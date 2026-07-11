import { describe, expect, it } from "vitest";
import { netscapeCookieHeader } from "../src/services/media/cookies.js";

describe("cookies Netscape", () => {
  it("converte somente cookies do domínio solicitado", () => {
    const text = [
      "# Netscape HTTP Cookie File",
      ".instagram.com\tTRUE\t/\tTRUE\t4102444800\tcsrftoken\ttoken123",
      ".instagram.com\tTRUE\t/\tTRUE\t4102444800\tsessionid\tsession456",
      ".youtube.com\tTRUE\t/\tTRUE\t4102444800\tSID\tyoutube-secret",
    ].join("\n");
    const header = netscapeCookieHeader(text, "instagram.com");
    expect(header).toContain("csrftoken=token123");
    expect(header).toContain("sessionid=session456");
    expect(header).not.toContain("youtube-secret");
  });

  it("ignora cookies expirados", () => {
    const text = ".instagram.com\tTRUE\t/\tTRUE\t1\tsessionid\texpired";
    expect(netscapeCookieHeader(text, "instagram.com")).toBeUndefined();
  });
});
