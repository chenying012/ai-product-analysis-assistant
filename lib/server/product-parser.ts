import { load } from "cheerio";
import type { AmazonLink } from "../amazon-url";
import type { Product } from "../contracts";
import { AppError } from "../errors";

const clean = (value: string | undefined | null) => (value || "").replace(/[\u200e\u200f\u202a-\u202e]/g, "").replace(/\s+/g, " ").trim();
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" || typeof value === "number" ? clean(String(value)) : "";

function productNodes(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return [];
  if (Array.isArray(value)) return value.slice(0, 50).flatMap((item) => productNodes(item, depth + 1));
  const node = record(value);
  const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
  return types.includes("Product") ? [node] : productNodes(node["@graph"], depth + 1);
}

/** Reads an embedded JSON object by key without executing page scripts. Returns null when the value is absent or malformed. */
export function readEmbeddedObject(html: string, key: string, limit = 200000): Record<string, unknown> | null {
  const at = html.indexOf(`"${key}"`);
  if (at < 0) return null;
  const start = html.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length && index - start < limit; index++) {
    const char = html[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(html.slice(start, index + 1)) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
      } catch { return null; }
    }
  }
  return null;
}

/** Identifies the selected model of a multi-variant listing. Sibling variants are counted but never used as a price source. */
export function parseVariant(html: string, asin: string): Product["variant"] {
  const data = readEmbeddedObject(html, "dimensionValuesDisplayData");
  if (!data) return null;
  const siblings = Object.keys(data).filter((key) => /^[A-Z0-9]{10}$/i.test(key));
  if (siblings.length < 2) return null;
  const current = data[asin] ?? data[asin.toUpperCase()];
  const name = clean(Array.isArray(current) ? current.map((item) => string(item)).filter(Boolean).join(" / ") : string(current));
  return { name: name && name.length <= 200 ? name : null, total: siblings.length };
}

export function safeImageUrl(value: unknown): string | null {
  try {
    const image = new URL(string(value));
    const hosts = ["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-eu.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com", "images-cn.ssl-images-amazon.com"];
    return image.protocol === "https:" && !image.username && !image.password && !image.port && hosts.includes(image.hostname) ? image.href : null;
  } catch { return null; }
}

export function parseProductHtml(html: string, link: AmazonLink, provider: "direct" | "firecrawl" | "relay"): Product {
  const $ = load(html);
  $("script:not([type='application/ld+json']), style, noscript").remove();
  const nodes: Record<string, unknown>[] = [];
  $("script[type='application/ld+json']").slice(0, 12).each((_, el) => {
    try { nodes.push(...productNodes(JSON.parse($(el).text()))); } catch { /* Malformed optional metadata must not discard visible product fields. */ }
  });
  const matching = nodes.find((node) => string(node.sku).toUpperCase() === link.asin || string(node.url).includes(`/dp/${link.asin}`));
  const json = matching || (nodes.length === 1 ? nodes[0] : {});
  const visibleTitle = clean($("#productTitle, #title #title, h1[itemprop='name']").first().text());
  const title = visibleTitle || string(json.name);
  if (!visibleTitle && /click the button below to continue shopping|enter the characters you see below|sorry, we just need to make sure|robot check|validatecaptcha/i.test($.text())) {
    throw new AppError("SOURCE_BLOCKED", "Amazon 返回了访问确认页，而不是商品详情。请配置可用的商品采集来源后重试；本次不会生成虚假分析。", 502);
  }
  if (!title || title.length < 4 || title.length > 1500) {
    throw new AppError("PRODUCT_NOT_FOUND", "没有识别到有效的商品详情，可能是商品失效、访问受限或页面格式暂不支持。请检查链接。", 422);
  }
  const pageAsin = clean($("#ASIN, input[name='ASIN']").first().attr("value")) || string(json.sku);
  if (/^[A-Z0-9]{10}$/i.test(pageAsin) && pageAsin.toUpperCase() !== link.asin) {
    throw new AppError("PRODUCT_MISMATCH", "页面返回了另一商品或规格，请打开 Amazon 页面后复制最终商品链接。", 422);
  }
  const features = [...new Set($("#feature-bullets li .a-list-item, #feature-bullets li:not(:has(.a-list-item))").toArray()
    .map((el) => clean($(el).text()))
    .filter((value) => value.length > 8 && value.length <= 1000 && !/make sure this fits|see more product details/i.test(value)))].slice(0, 8);
  const specifications: Product["specifications"] = [];
  const addSpec = (name: string, value: string) => {
    const key = clean(name).replace(/[:：]+$/, "").trim();
    if (key && value && key.length < 100 && value.length < 800 && !specifications.some((item) => item.name === key) && specifications.length < 16) {
      specifications.push({ name: key, value });
    }
  };
  $("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #productOverview_feature_div tr, #technicalSpecifications_section_1 tr").each((_, el) => {
    const cells = $(el).find("th, td");
    if (cells.length >= 2) addSpec(cells.first().text(), clean(cells.eq(1).text()));
  });
  $("#detailBullets_feature_div li").each((_, el) => {
    const label = $(el).find(".a-text-bold").first().text();
    if (label) addSpec(label, clean($(el).text().replace(label, "")));
  });
  const description = clean($("#productDescription").text()) || string(json.description);
  if (!features.length && !specifications.length && description.length < 60) {
    throw new AppError("INSUFFICIENT_PRODUCT_DATA", "仅取得商品标题，缺少功能或规格，暂不足以生成可靠分析。请更换链接或采集来源。", 422);
  }
  const brand = clean($("#bylineInfo").text()).replace(/^Visit the (.+) Store$/i, "$1").replace(/^Brand:\s*/i, "") || string(record(json.brand).name) || string(json.brand);
  const category = $("#wayfinding-breadcrumbs_feature_div a").toArray().map((el) => clean($(el).text())).filter(Boolean).slice(-3).join(" / ") || string(json.category);
  const offers = Array.isArray(json.offers) ? record(json.offers[0]) : record(json.offers);
  // Every selector stays inside this listing's own buy box. Recommendation carousels are excluded
  // because a restricted page still renders prices that belong to other products.
  const priceSelectors = [
    "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
    "#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#apex_desktop .a-price:not(.a-text-price) .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#corePriceDisplay_mobile_feature_div .priceToPay .a-offscreen",
    "#corePriceDisplay_mobile_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#apex_mobile .a-price:not(.a-text-price) .a-offscreen",
    "#tp_price_block_total_price_ww .a-offscreen",
    "#newAccordionRow .a-price:not(.a-text-price) .a-offscreen",
    "#priceblock_ourprice", "#priceblock_dealprice", "#price_inside_buybox",
  ];
  const currencyText = string(offers.priceCurrency) || clean($("meta[itemprop='priceCurrency']").attr("content"));
  const currency = /^[A-Z]{3}$/.test(currencyText) ? currencyText : null;
  const visiblePrice = priceSelectors.map((selector) => clean($(selector).first().text())).find(Boolean);
  const jsonPrice = string(offers.price);
  const displayPrice = visiblePrice || (jsonPrice ? `${currency || ""} ${jsonPrice}`.trim() : "");
  const price = displayPrice && displayPrice.length < 100 && /\d/.test(displayPrice) ? { display: displayPrice, currency } : null;
  // Amazon localises amazon.com prices to the visitor's region. A price collected from outside the
  // United States can differ in currency and amount from what a US visitor sees on the same page,
  // so it is labelled instead of being presented as the listing's only price.
  const localisedPrice = Boolean(price) && link.marketplace === "amazon.com" && !/^(?:US)?\$\s?[\d,]/.test(price!.display);
  // A listing that cannot ship to the crawler's region renders no price at all, so the reason is
  // reported instead of leaving an unexplained gap.
  const availabilityText = clean($("#outOfStock, #buybox, #availability, #exports_desktop_qualifiedBuybox_bb_unavailable_feature_div").text()).slice(0, 600);
  const priceUnavailableReason = price ? null
    : /cannot be shipped to your selected delivery location|choose a different delivery location/i.test(availabilityText) ? "region_restricted" as const
    : /currently unavailable|out of stock|temporarily out of stock/i.test(availabilityText) ? "out_of_stock" as const
    : "not_found" as const;
  const variant = parseVariant(html, link.asin);
  const imageEl = $("#landingImage, #imgBlkFront").first();
  let imageUrl = safeImageUrl(imageEl.attr("data-old-hires")) || safeImageUrl(imageEl.attr("src"));
  if (!imageUrl) {
    try {
      const images = record(JSON.parse(imageEl.attr("data-a-dynamic-image") || "{}"));
      imageUrl = Object.keys(images).map(safeImageUrl).find(Boolean) || null;
    } catch { /* A broken optional image field does not invalidate product text. */ }
  }
  const jsonImage = Array.isArray(json.image) ? json.image[0] : json.image;
  imageUrl ||= safeImageUrl(jsonImage) || safeImageUrl(record(jsonImage).url);
  const facts = [
    { label: "商品名称", value: title },
    ...(brand ? [{ label: "品牌", value: brand }] : []),
    ...(category ? [{ label: "品类", value: category }] : []),
    ...(variant?.name ? [{ label: "当前型号", value: variant.name }] : []),
    ...(variant ? [{ label: "可选型号数量", value: `${variant.total} 个` }] : []),
    ...(price ? [{ label: "页面价格", value: price.display }] : []),
    ...features.map((value) => ({ label: "页面功能描述", value })),
    ...specifications.map((item) => ({ label: item.name, value: item.value })),
    ...(description ? [{ label: "页面商品说明", value: description.slice(0, 1600) }] : []),
  ];
  return {
    ...link, title, brand: brand || null, category: category || null, price, priceUnavailableReason, priceLocalised: localisedPrice, variant, imageUrl, imageInsight: null,
    features, specifications, description: description.slice(0, 1600) || null,
    evidence: facts.map((fact, index) => ({ id: `F${index + 1}`, ...fact })),
    source: { provider, fetchedAt: new Date().toISOString() },
    warnings: [
      ...(priceUnavailableReason === "region_restricted"
        ? ["Amazon 判定该商品无法配送到本次采集所在地区，页面中完全没有下发本商品价格；页面上其他金额属于推荐位的其他商品，未采用。可配置 PRODUCT_FETCH_ENDPOINT 或 Firecrawl 从其他地区取回价格，或把服务部署到可配送地区。"] : []),
      ...(priceUnavailableReason === "out_of_stock" ? ["页面显示该商品当前缺货，未展示可确认的价格。"] : []),
      ...(priceUnavailableReason === "not_found" ? ["页面未展示可确认的价格，未使用默认金额补齐。"] : []),
      ...(variant && !price ? [`该商品有 ${variant.total} 个型号或规格${variant.name ? `，本次分析的是「${variant.name}」` : ""}；不同型号价格可能不同，未借用其他型号的价格填充。`] : []),
      ...(variant && price ? [`该商品有 ${variant.total} 个型号或规格${variant.name ? `，以上价格与分析对应「${variant.name}」` : ""}，其他型号可能不同。`] : []),
      ...(localisedPrice ? [`页面价格显示为「${price!.display}」，是 Amazon 按本次采集所在地区本地化后的报价；美国本地访问同一页面通常显示美元价格，金额也可能不同。`] : []),
      ...(!category ? ["页面品类未取得；分析中的适用人群与场景属于模型推断。"] : []),
      "商品功能与规格为页面标称，未进行独立性能验证。",
    ],
  };
}
