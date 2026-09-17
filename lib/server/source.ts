import { lookup } from "node:dns";
import { request } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";
import { normalizeAmazonUrl, type AmazonLink } from "../amazon-url";
import type { Product } from "../contracts";
import { AppError } from "../errors";
import { parseProductHtml } from "./product-parser";
import type { ServerConfig } from "./config";

export const MAX_PAGE_BYTES = 4 * 1024 * 1024;

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

export async function readResponseText(response: Response, maxBytes = MAX_PAGE_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new AppError("RESPONSE_TOO_LARGE", "上游返回的内容过大，本次处理已停止。", 502);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError("RESPONSE_TOO_LARGE", "上游返回的内容过大，本次处理已停止。", 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/**
 * Headers used when reading a public product page.
 *
 * A self-identifying agent string was rejected outright by Amazon, which made the whole tool
 * unusable, so ordinary browser headers are sent instead. This only makes the request look like the
 * normal one a visitor's browser would send for the same public page; nothing about a verification
 * challenge is bypassed. A returned CAPTCHA or interstitial is still reported as SOURCE_BLOCKED
 * rather than worked around.
 */
export const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
} as const;

function readDirect(url: string, signal: AbortSignal): Promise<{ html: string; redirect?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal,
      headers: { ...BROWSER_HEADERS },
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return callback(error, "");
          if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
            return callback(new Error("Non-public destination rejected"), "");
          }
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        });
      },
    }, (res) => {
      const status = res.statusCode || 502;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        return resolve({ html: "", redirect: new URL(res.headers.location, url).href });
      }
      if (status === 403 || status === 429 || status === 503) {
        res.destroy();
        return reject(new AppError("SOURCE_BLOCKED", "Amazon 暂时限制了本次访问。请使用可用的商品采集来源，或稍后重试。", 502, true));
      }
      if (status !== 200) {
        res.destroy();
        return reject(new AppError("SOURCE_HTTP_ERROR", `商品页面返回 ${status}，本次未取得有效详情。`, 502, status >= 500));
      }
      if (!/text\/html|application\/xhtml\+xml/i.test(res.headers["content-type"] || "")) {
        res.destroy();
        return reject(new AppError("INVALID_PAGE", "返回内容不是可处理的商品网页。", 422));
      }
      const encoding = res.headers["content-encoding"];
      const stream = encoding === "gzip" ? res.pipe(createGunzip()) : encoding === "br" ? res.pipe(createBrotliDecompress()) : encoding === "deflate" ? res.pipe(createInflate()) : res;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("error", reject);
      res.on("aborted", () => reject(new AppError("SOURCE_CONNECTION_ERROR", "商品页面连接中断，请重试。", 502, true)));
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_PAGE_BYTES) {
          const error = new AppError("RESPONSE_TOO_LARGE", "商品页面过大，本次处理已停止。", 502);
          reject(error); stream.destroy(); req.destroy(); return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

export async function fetchDirectHtml(link: AmazonLink, signal: AbortSignal): Promise<string> {
  let target = link.url;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const result = await readDirect(target, signal);
    if (!result.redirect) return result.html;
    let next: AmazonLink;
    try { next = normalizeAmazonUrl(result.redirect); } catch {
      throw new AppError("SOURCE_BLOCKED", "商品链接跳转到了访问确认页或不支持的页面。请检查链接或更换采集来源。", 502);
    }
    if (next.asin !== link.asin || next.marketplace !== link.marketplace) {
      throw new AppError("PRODUCT_MISMATCH", "链接跳转到了其他商品或站点，请使用最终商品页面链接。", 422);
    }
    target = result.redirect;
  }
  throw new AppError("SOURCE_REDIRECT_LIMIT", "商品链接重定向次数过多，已停止获取。", 502);
}

async function fetchFirecrawlHtml(link: AmazonLink, key: string, signal: AbortSignal): Promise<string> {
  const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST", signal, redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ url: link.url, formats: ["rawHtml"], onlyMainContent: false, timeout: 25000 }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError("SOURCE_PROVIDER_ERROR", response.status === 401 || response.status === 402 || response.status === 403
      ? "商品采集接口不可用，请检查服务端 Key、权限和额度。"
      : `商品采集服务暂时失败（${response.status}），请稍后重试。`, 502, response.status >= 500 || response.status === 429);
  }
  const payload = JSON.parse(await readResponseText(response)) as { success?: boolean; data?: { rawHtml?: string; metadata?: { sourceURL?: string; statusCode?: number } } };
  if (!payload.success || typeof payload.data?.rawHtml !== "string" || !payload.data.rawHtml.trim()) {
    throw new AppError("SOURCE_EMPTY", "采集服务未返回有效商品 HTML，未继续生成。", 502);
  }
  const meta = payload.data.metadata;
  if (meta?.statusCode && meta.statusCode >= 400) throw new AppError("SOURCE_BLOCKED", "采集服务返回的源页面不可访问，未继续生成。", 502);
  if (meta?.sourceURL) {
    const final = normalizeAmazonUrl(meta.sourceURL);
    if (final.asin !== link.asin || final.marketplace !== link.marketplace) throw new AppError("PRODUCT_MISMATCH", "采集结果与输入商品不一致，已停止分析。", 422);
  }
  return payload.data.rawHtml;
}

/**
 * Fetches the page through an operator-configured relay so the request leaves from another region.
 * Amazon hides the price of a listing it cannot ship to the caller's region, and that price is absent
 * from the HTML entirely, so no parsing change can recover it from a restricted region.
 */
export async function fetchRelayHtml(link: AmazonLink, endpoint: string, signal: AbortSignal): Promise<string> {
  const target = endpoint.replace("{url}", encodeURIComponent(link.url));
  const response = await fetch(target, {
    signal, redirect: "follow",
    headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError("SOURCE_PROVIDER_ERROR", response.status === 401 || response.status === 402 || response.status === 403
      ? "商品页面中转服务拒绝了请求，请检查 PRODUCT_FETCH_ENDPOINT 的权限与额度。"
      : `商品页面中转服务暂时失败（${response.status}）。`, 502, response.status >= 500 || response.status === 429);
  }
  const html = await readResponseText(response);
  if (!html.trim()) throw new AppError("SOURCE_EMPTY", "中转服务未返回商品页面内容。", 502);
  return html;
}

export type HtmlProvider = "direct" | "firecrawl" | "relay";
export type HtmlFetcher = (link: AmazonLink, provider: HtmlProvider, config: ServerConfig, signal: AbortSignal) => Promise<string>;

const fetchHtmlFor: HtmlFetcher = (link, provider, config, signal) => {
  if (provider === "relay") return fetchRelayHtml(link, config.fetchEndpoint, signal);
  if (provider === "firecrawl") return fetchFirecrawlHtml(link, config.firecrawlKey, signal);
  return fetchDirectHtml(link, signal);
};

export async function fetchProduct(link: AmazonLink, config: ServerConfig, parentSignal: AbortSignal, fetchHtml: HtmlFetcher = fetchHtmlFor) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]);
  const primary = config.source === "firecrawl" ? "firecrawl" : "direct";
  let product: Product;
  try {
    product = parseProductHtml(await fetchHtml(link, primary, config, signal), link, primary);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (signal.aborted) throw new AppError("SOURCE_TIMEOUT", "商品信息获取超时，未继续生成。请稍后重试或更换采集来源。", 504, true);
    throw new AppError("SOURCE_CONNECTION_ERROR", "无法连接商品信息来源，请检查网络或接口配置。", 502, true);
  }
  if (product.priceUnavailableReason !== "region_restricted") return product;
  // The primary region cannot see this listing's price. Retry through another region when the operator
  // configured one, and only accept the retry when it really priced the same ASIN.
  const fallbacks = ([config.fetchEndpoint ? "relay" : null, config.firecrawlKey && primary !== "firecrawl" ? "firecrawl" : null]
    .filter(Boolean) as HtmlProvider[]);
  for (const provider of fallbacks) {
    try {
      const retry = parseProductHtml(await fetchHtml(link, provider, config, signal), link, provider);
      if (retry.price && retry.asin === product.asin) {
        return {
          ...retry,
          warnings: [`价格通过 ${provider === "relay" ? "配置的取回中转" : "Firecrawl"} 从其他地区取得，本机直连所在地区不可配送该商品。`, ...retry.warnings],
        };
      }
    } catch { /* A failing fallback must not discard the product facts already collected. */ }
    if (signal.aborted) break;
  }
  return {
    ...product,
    warnings: fallbacks.length
      ? ["已尝试从其他地区取回价格但未成功，因此价格仍为未知，未使用任何替代金额。", ...product.warnings]
      : product.warnings,
  };
}
