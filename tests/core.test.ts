import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAmazonUrl } from "../lib/amazon-url";
import { characterCount, scriptText } from "../lib/contracts";
import { AppError } from "../lib/errors";
import { getServerConfig, getSetupStatus } from "../lib/server/config";
import { validateContent } from "../lib/server/generate";
import { parseProductHtml, safeImageUrl } from "../lib/server/product-parser";
import { isPublicAddress, readResponseText } from "../lib/server/source";
import { RequestGate } from "../lib/server/analyze-handler";
import { html, link, product, validContent } from "./fixtures";

const codeIs = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test("normalizes a long product URL and strips tracking parameters", () => {
  assert.deepEqual(normalizeAmazonUrl(" https://www.amazon.com/Storage-Box/dp/b000test01/ref=sr?tag=test#specs "), link);
});
test("accepts common product paths without merging marketplaces", () => {
  assert.equal(normalizeAmazonUrl("https://amazon.de/gp/product/B000TEST01?psc=1").url, "https://www.amazon.de/dp/B000TEST01");
});
test("rejects lookalike hosts, non-HTTPS, custom ports and URL credentials", () => {
  for (const url of ["https://amazon.com.evil.test/dp/B000TEST01", "https://notamazon.com/dp/B000TEST01", "http://amazon.com/dp/B000TEST01", "https://user:password@amazon.com/dp/B000TEST01", "https://amazon.com:8443/dp/B000TEST01", "file:///etc/hosts"]) assert.throws(() => normalizeAmazonUrl(url), AppError);
});
test("rejects short links and non-product pages with specific errors", () => {
  assert.throws(() => normalizeAmazonUrl("https://amzn.to/abcd"), codeIs("SHORT_URL"));
  assert.throws(() => normalizeAmazonUrl("https://www.amazon.com/s?k=box"), codeIs("NOT_PRODUCT_URL"));
  assert.throws(() => normalizeAmazonUrl("https://www.amazon.com/dp/B000TEST012"), codeIs("NOT_PRODUCT_URL"));
});
test("public address check blocks local, reserved and mapped private IPs", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "192.0.2.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});
test("extracts product details and preserves decimal price", () => {
  assert.equal(product.title, "测试用折叠收纳盒");
  assert.equal(product.price?.display, "$29.95");
  assert.equal(product.price?.currency, null);
  assert.equal(product.features.length, 2);
  assert.deepEqual(product.specifications, [{ name: "Material", value: "Fabric" }]);
  assert.equal(product.brand, "TestBrand");
  assert.equal(product.evidence[4].id, "F5");
});
test("retains missing price as unknown rather than zero", () => {
  const result = parseProductHtml(html.replace("$29.95", ""), link, "direct");
  assert.equal(result.price, null);
  assert.equal(result.priceUnavailableReason, "not_found");
  assert.ok(result.warnings.some((message) => message.includes("价格")));
  assert.ok(!("stars" in result));
});
test("explains a missing price caused by delivery restrictions", () => {
  const restricted = html.replace(
    '<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$29.95</span></span></div>',
    '<div id="outOfStock">This item cannot be shipped to your selected delivery location.</div>'
    + '<div id="similar-items"><span class="a-price"><span class="a-offscreen">$88.00</span></span></div>',
  );
  const result = parseProductHtml(restricted, link, "direct");
  assert.equal(result.price, null, "推荐位价格不得被当作本商品价格");
  assert.equal(result.priceUnavailableReason, "region_restricted");
  assert.ok(result.warnings.some((message) => message.includes("无法配送")));
  assert.ok(!result.evidence.some((fact) => fact.value.includes("88.00")));
});
test("reports an out-of-stock listing separately from an unparsed price", () => {
  const soldOut = html.replace(
    '<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$29.95</span></span></div>',
    '<div id="outOfStock">Currently unavailable.</div>',
  );
  assert.equal(parseProductHtml(soldOut, link, "direct").priceUnavailableReason, "out_of_stock");
});
test("identifies the selected model of a multi-variant listing", () => {
  const variants = { [link.asin]: ["2pack Olive Green"], B0CXT78M9H: ["1pack Blue"], B0CXT9C72K: ["1pack Red"] };
  const result = parseProductHtml(
    html.replace("</body>", `<script>var data = {"dimensionValuesDisplayData":${JSON.stringify(variants)},"other":1};</script></body>`),
    link, "direct",
  );
  assert.deepEqual(result.variant, { name: "2pack Olive Green", total: 3 });
  assert.ok(result.evidence.some((fact) => fact.label === "当前型号" && fact.value === "2pack Olive Green"));
  assert.ok(result.evidence.some((fact) => fact.label === "可选型号数量" && fact.value === "3 个"));
  assert.ok(result.warnings.some((message) => message.includes("3 个型号")));
});
test("keeps variant null when the listing has no sibling models", () => {
  assert.equal(product.variant, null);
  const single = parseProductHtml(
    html.replace("</body>", `<script>var d = {"dimensionValuesDisplayData":{"${link.asin}":["Only"]}};</script></body>`),
    link, "direct",
  );
  assert.equal(single.variant, null);
});
test("ignores malformed variant metadata instead of failing the parse", () => {
  const result = parseProductHtml(html.replace("</body>", '<script>var d = {"dimensionValuesDisplayData":{oops};</script></body>'), link, "direct");
  assert.equal(result.variant, null);
  assert.equal(result.price?.display, "$29.95");
});
test("preserves locale price text without inventing a currency", () => {
  const result = parseProductHtml(html.replace("$29.95", "29,95 €"), { ...link, marketplace: "amazon.de" }, "direct");
  assert.equal(result.price?.display, "29,95 €");
});
test("marks an amazon.com price that was localised away from USD", () => {
  assert.equal(parseProductHtml(html, link, "direct").priceLocalised, false, "美元价不应被标记");
  for (const shown of ["US$29.95", "$1,299.00"]) {
    assert.equal(parseProductHtml(html.replace("$29.95", shown), link, "direct").priceLocalised, false, shown);
  }
  for (const shown of ["S$76.20", "HKD469.83", "A$89.00"]) {
    const result = parseProductHtml(html.replace("$29.95", shown), link, "direct");
    assert.equal(result.priceLocalised, true, shown);
    assert.ok(result.warnings.some((message) => message.includes("本地化") && message.includes(shown)), shown);
  }
  // Non-US marketplaces legitimately price in their own currency, so they are not flagged.
  assert.equal(parseProductHtml(html.replace("$29.95", "29,95 €"), { ...link, marketplace: "amazon.de" }, "direct").priceLocalised, false);
  // A missing price cannot be localised.
  assert.equal(parseProductHtml(html.replace("$29.95", ""), link, "direct").priceLocalised, false);
});
test("supports Product JSON-LD when visible DOM fields are absent", () => {
  const data = { "@graph": [{ "@type": "Product", sku: link.asin, name: "测试商品的结构化描述", description: "可供测试的详细说明。".repeat(12), offers: { price: "19.90", priceCurrency: "EUR" }, brand: { name: "SampleBrand" } }] };
  const result = parseProductHtml(`<script type="application/ld+json">${JSON.stringify(data)}</script>`, link, "firecrawl");
  assert.equal(result.price?.display, "EUR 19.90");
  assert.equal(result.brand, "SampleBrand");
});
test("malformed JSON-LD does not break valid visible fields", () => {
  assert.equal(parseProductHtml(html + '<script type="application/ld+json">{broken</script>', link, "direct").title, product.title);
});
test("HTTP 200 shopping interstitial is not a successful product", () => {
  assert.throws(() => parseProductHtml("<title>Amazon.com</title><p>Click the button below to continue shopping</p>", link, "direct"), codeIs("SOURCE_BLOCKED"));
});
test("rejects mismatched ASIN and insufficient material", () => {
  assert.throws(() => parseProductHtml(html.replace('value="B000TEST01"', 'value="B000TEST02"'), link, "direct"), codeIs("PRODUCT_MISMATCH"));
  assert.throws(() => parseProductHtml('<h1 id="productTitle">只有商品标题的测试页面</h1>', link, "direct"), codeIs("INSUFFICIENT_PRODUCT_DATA"));
});
test("only accepts expected HTTPS Amazon image hosts", () => {
  assert.ok(safeImageUrl("https://m.media-amazon.com/images/I/test.jpg"));
  for (const value of ["javascript:alert(1)", "http://m.media-amazon.com/a.jpg", "https://m.media-amazon.com.evil.test/a.jpg", "https://127.0.0.1/a.jpg"]) assert.equal(safeImageUrl(value), null);
});
test("validates structured Chinese content with existing evidence", () => {
  assert.deepEqual(validateContent(validContent, product), validContent);
  assert.ok(characterCount(scriptText(validContent.script)) <= 150);
});
test("uses Unicode code points and counts internal whitespace", () => {
  assert.equal(characterCount(" 一🙂 二 "), 4);
  assert.equal(characterCount("一\n二"), 3);
});
test("accepts exactly 150 characters but rejects 151", () => {
  const content = structuredClone(validContent);
  content.script.hook = "看看这个好物";
  content.script.body = "好".repeat(150 - characterCount(content.script.hook) - 1);
  assert.equal(characterCount(scriptText(content.script)), 150);
  assert.doesNotThrow(() => validateContent(content, product));
  content.script.body += "好";
  assert.throws(() => validateContent(content, product), /150/);
});
test("rejects unsupported evidence, long hook, English output and wrong schema", () => {
  const unknown = structuredClone(validContent); unknown.script.evidenceIds = ["F999"];
  assert.throws(() => validateContent(unknown, product), /evidenceId/);
  const long = structuredClone(validContent); long.script.hook = "字".repeat(21);
  assert.throws(() => validateContent(long, product), /20/);
  const english = structuredClone(validContent); english.script.body = "A product description.";
  assert.throws(() => validateContent(english, product), /中文/);
  assert.throws(() => validateContent({ invented: true }, product), /结构/);
});
test("setup state exposes booleans, never model or scraping secrets", () => {
  const state = getSetupStatus({ OPENAI_API_KEY: "secret-a", OPENAI_MODEL: "model", FIRECRAWL_API_KEY: "secret-b", APP_ACCESS_TOKEN: "private-token" });
  assert.deepEqual(state, { modelConfigured: true, sourceConfigured: true, source: "direct", accessProtected: true, regionFallbackConfigured: true, imageAnalysisConfigured: false, accountsEnabled: false, signupBonus: 10, analysisCost: 1 });
  assert.ok(!JSON.stringify(state).includes("secret"));
  assert.equal(getSetupStatus({ OPENAI_VISION_MODEL: "vision-model" }).imageAnalysisConfigured, true);
  const bare = getSetupStatus({ OPENAI_API_KEY: "k", OPENAI_MODEL: "m" });
  assert.equal(bare.regionFallbackConfigured, false);
  assert.equal(getSetupStatus({ PRODUCT_FETCH_ENDPOINT: "https://relay.example/?url={url}" }).regionFallbackConfigured, true);
});
test("account mode is reported without leaking the database location", () => {
  assert.equal(getSetupStatus({}).accountsEnabled, false);
  assert.equal(getSetupStatus({ ACCOUNTS_DB: "off" }).accountsEnabled, false);
  assert.equal(getSetupStatus({ ACCOUNTS_DB: "   " }).accountsEnabled, false);
  assert.equal(getSetupStatus({ ACCOUNTS_DB: "on" }).accountsEnabled, true);
  const custom = getSetupStatus({ ACCOUNTS_DB: "/srv/private/accounts.db" });
  assert.equal(custom.accountsEnabled, true);
  assert.ok(!JSON.stringify(custom).includes("/srv/private"), "不得对外暴露数据库路径");
});
test("requires explicit model configuration and validates provider settings", () => {
  assert.throws(() => getServerConfig({}), codeIs("MODEL_NOT_CONFIGURED"));
  const env = { OPENAI_API_KEY: "test-only", OPENAI_MODEL: "model" };
  assert.throws(() => getServerConfig({ ...env, PRODUCT_SOURCE: "firecrawl" }), codeIs("SOURCE_NOT_CONFIGURED"));
  assert.throws(() => getServerConfig({ ...env, OPENAI_BASE_URL: "https://x:y@example.com/v1" }), codeIs("MODEL_NOT_CONFIGURED"));
  assert.throws(() => getServerConfig({ ...env, PRODUCT_SOURCE: "unknown" }), codeIs("SOURCE_NOT_CONFIGURED"));
  assert.equal(getServerConfig(env).baseUrl, "https://api.openai.com/v1");
});
test("response reader limits bytes and correctly decodes split Chinese text", async () => {
  const encoded = new TextEncoder().encode("中文材料");
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
  assert.equal(await readResponseText(response), "中文材料");
  await assert.rejects(() => readResponseText(new Response("12345"), 4), codeIs("RESPONSE_TOO_LARGE"));
});
test("request gate caps concurrent and per-minute requests, releases once", () => {
  const gate = new RequestGate();
  const a = gate.acquire("user-1", 1000); const b = gate.acquire("user-1", 1000);
  assert.throws(() => gate.acquire("user-1", 1000), codeIs("RATE_LIMITED"));
  a(); a(); b();
  for (let i = 0; i < 8; i++) gate.acquire("user-1", 1000)();
  assert.throws(() => gate.acquire("user-1", 1000), codeIs("RATE_LIMITED"));
  assert.doesNotThrow(() => gate.acquire("user-1", 62000)());
});
test("request gate counts each account separately", () => {
  // A busy account must not consume the allowance of everyone else.
  const gate = new RequestGate();
  for (let i = 0; i < 10; i++) gate.acquire("busy", 1000)();
  assert.throws(() => gate.acquire("busy", 1000), codeIs("RATE_LIMITED"));
  assert.doesNotThrow(() => gate.acquire("quiet", 1000)());
});
