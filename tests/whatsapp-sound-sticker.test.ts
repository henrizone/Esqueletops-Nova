import { describe, expect, it } from "vitest";
import { renderConnectionPage } from "../src/services/whatsapp/soundSticker.js";

describe("figurinhas com áudio: página de conexão", () => {
  it("mostra o QR code válido e ignora conteúdo estranho", () => {
    const qr = "data:image/png;base64,iVBORw0KGgo=";
    expect(renderConnectionPage({ loggedIn: false, qrcode: qr })).toContain(`src="${qr}"`);
    const hostile = renderConnectionPage({ loggedIn: false, qrcode: '"><script>alert(1)</script>' });
    expect(hostile).not.toContain("<script>");
    expect(hostile).toContain("Gerando o QR code");
  });

  it("mostra conectado e escapa o nome do perfil e os erros", () => {
    const page = renderConnectionPage({ loggedIn: true, name: "<b>Henry</b>" });
    expect(page).toContain("Número conectado");
    expect(page).toContain("&lt;b&gt;Henry&lt;/b&gt;");
    expect(renderConnectionPage({ error: "<x>" })).toContain("&lt;x&gt;");
  });
});
