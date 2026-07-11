import { describe, expect, it } from "vitest";
import { extractInstagramGqlData } from "../src/services/media/instagram.js";

describe("Instagram embed", () => {
  it("extrai gql_data serializado do embed", () => {
    const html = String.raw`<script>{\"gql_data\":{\"shortcode_media\":{\"__typename\":\"GraphImage\",\"id\":\"1\",\"display_url\":\"https:\/\/cdninstagram.com\/photo.jpg?x=1\\u0026y=2\",\"owner\":{\"username\":\"teste\"}}}}</script>`;
    const media = extractInstagramGqlData(html);
    expect(media?.__typename).toBe("GraphImage");
    expect(media?.owner?.username).toBe("teste");
    expect(media?.display_url).toContain("cdninstagram.com/photo.jpg");
  });
});
