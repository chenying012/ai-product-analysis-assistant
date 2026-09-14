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

export function safeImageUrl(value: unknown): string | null {
  try {
    const image = new URL(string(value));
    const hosts = ["m.media-amazon.com", "images-na.ssl-images-amazon.com", "images-eu.ssl-images-amazon.com", "images-fe.ssl-images-amazon.com", "images-cn.ssl-images-amazon.com"];
    return image.protocol === "https:" && !image.username && !image.password && !image.port && hosts.includes(image.hostname) ? image.href : null;
  } catch { return null; }
}

export function parseProductHtml(html: string, link: AmazonLink, provider: "direct" | "firecrawl"): Product {
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
  const priceSelectors = [
    "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
    "#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#apex_desktop .a-price:not(.a-text-price) .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen",
    "#priceblock_ourprice", "#priceblock_dealprice", "#price_inside_buybox",
  ];
  const currencyText = string(offers.priceCurrency) || clean($("meta[itemprop='priceCurrency']").attr("content"));
  const currency = /^[A-Z]{3}$/.test(currencyText) ? currencyText : null;
  const visiblePrice = priceSelectors.map((selector) => clean($(selector).first().text())).find(Boolean);
  const jsonPrice = string(offers.price);
  const displayPrice = visiblePrice || (jsonPrice ? `${currency || ""} ${jsonPrice}`.trim() : "");
  const price = displayPrice && displayPrice.length < 100 && /\d/.test(displayPrice) ? { display: displayPrice, currency } : null;
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
    ...(price ? [{ label: "页面价格", value: price.display }] : []),
    ...features.map((value) => ({ label: "页面功能描述", value })),
    ...specifications.map((item) => ({ label: item.name, value: item.value })),
    ...(description ? [{ label: "页面商品说明", value: description.slice(0, 1600) }] : []),
  ];
  return {
    ...link, title, brand: brand || null, category: category || null, price, imageUrl,
    features, specifications, description: description.slice(0, 1600) || null,
    evidence: facts.map((fact, index) => ({ id: `F${index + 1}`, ...fact })),
    source: { provider, fetchedAt: new Date().toISOString() },
    warnings: [
      ...(!price ? ["页面未展示可确认的价格，未使用默认金额补齐。"] : []),
      ...(!category ? ["页面品类未取得；分析中的适用人群与场景属于模型推断。"] : []),
      "商品功能与规格为页面标称，未进行独立性能验证。",
    ],
  };
}
