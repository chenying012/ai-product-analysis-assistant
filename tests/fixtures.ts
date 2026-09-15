import type { Content } from "../lib/contracts";
import { normalizeAmazonUrl } from "../lib/amazon-url";
import { parseProductHtml } from "../lib/server/product-parser";
import { reviewContent } from "../lib/server/quality";

// Synthetic fixtures are used only by tests, never by the application.
export const link = normalizeAmazonUrl("https://www.amazon.com/dp/B000TEST01");
export const html = `<!doctype html><html><head><title>Test product</title></head><body>
<h1 id="productTitle">测试用折叠收纳盒</h1><input id="ASIN" value="B000TEST01" />
<a id="bylineInfo">Brand: TestBrand</a>
<div id="wayfinding-breadcrumbs_feature_div"><a>Home</a><a>Storage</a></div>
<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$29.95</span></span></div>
<img id="landingImage" src="https://m.media-amazon.com/images/I/test.jpg" />
<ul id="feature-bullets"><li><span class="a-list-item">可折叠结构，便于闲置时收纳。</span></li><li><span class="a-list-item">侧边带有提手，方便日常移动。</span></li></ul>
<table id="productDetails_techSpec_section_1"><tr><th>Material</th><td>Fabric</td></tr></table>
<div id="productDescription">仅用于单元测试的虚构商品材料，不对应实际在售商品。</div>
</body></html>`;
export const product = parseProductHtml(html, link, "direct");
export const validContent: Content = {
  audiences: [{ title: "小空间居住者", description: "可能适合希望减少闲置物品占地的人群。", evidenceIds: ["F5"] }],
  scenarios: [{ title: "卧室整理", description: "可用于临时整理和收纳，具体容量应以商品规格为准。", evidenceIds: ["F5"] }],
  painPoints: [{ title: "空盒占地方", description: "不用的时候仍然占地，可折叠结构有助于收起空盒。", evidenceIds: ["F5"] }],
  sellingPoints: [{ title: "可折叠收纳", description: "将可折叠结构转化为闲置时便于收纳的收益。", evidenceIds: ["F5"] }],
  script: { hook: "空收纳盒也很占地方？", body: "看看这种可折叠的收纳盒，不用时可以折起来收好，侧边提手也方便日常移动。如果你正在整理有限的居家空间，可以先对照需要收纳的物品，确认尺寸是否合适。", evidenceIds: ["F5", "F6"] },
};
export const config = { apiKey: "unit-test-key-not-a-real-secret", baseUrl: "https://model.invalid/v1", model: "test-model", source: "direct" as const, firecrawlKey: "", fetchEndpoint: "", visionModel: "" };
export const validQuality = reviewContent(validContent, product);
