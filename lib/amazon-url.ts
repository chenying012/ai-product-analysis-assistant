import { AppError } from "./errors";

export const marketplaces = [
  "amazon.com", "amazon.co.uk", "amazon.ca", "amazon.de", "amazon.fr",
  "amazon.it", "amazon.es", "amazon.co.jp", "amazon.in", "amazon.com.au",
  "amazon.com.mx", "amazon.com.br", "amazon.nl", "amazon.se", "amazon.pl",
  "amazon.com.be", "amazon.ie", "amazon.sg", "amazon.ae", "amazon.sa",
] as const;

export type AmazonLink = { url: string; asin: string; marketplace: string };

export function normalizeAmazonUrl(input: string): AmazonLink {
  let url: URL;
  try { url = new URL(input.trim()); } catch {
    throw new AppError("INVALID_URL", "请输入完整的 Amazon 商品链接，例如 https://www.amazon.com/dp/商品编号。", 400);
  }
  if (url.hostname === "amzn.to" || url.hostname === "a.co") {
    throw new AppError("SHORT_URL", "请先在浏览器展开短链接，再粘贴 Amazon 商品详情页的完整链接。", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new AppError("INVALID_URL", "请使用不含账号信息或自定义端口的 HTTPS 商品链接。", 400);
  }
  const market = marketplaces.find((domain) =>
    [domain, `www.${domain}`, `m.${domain}`].includes(url.hostname),
  );
  if (!market) {
    throw new AppError("UNSUPPORTED_MARKETPLACE", "暂不支持这个站点，请使用支持的公开 Amazon 商品详情链接。", 400);
  }
  const match = url.pathname.match(/\/(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i);
  if (!match) {
    throw new AppError("NOT_PRODUCT_URL", "这不是可识别的商品详情链接，请使用包含 /dp/ 或 /gp/product/ 的链接。", 400);
  }
  const asin = match[1].toUpperCase();
  return { asin, marketplace: market, url: `https://www.${market}/dp/${asin}` };
}
