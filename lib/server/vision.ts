import { z } from "zod";
import type { Product } from "../contracts";
import { safeImageUrl } from "./product-parser";
import type { ServerConfig } from "./config";
import type { FetchFunction } from "./generate";

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const observationSchema = z.object({
  observations: z.array(z.string().trim().min(2).max(80)).max(5),
}).strict();

const INSTRUCTION = `你在看一张电商商品主图，请只描述图片中确实可见的客观特征。
只返回 JSON：{"observations":["…"]}，每条不超过 30 个中文字，最多 5 条，全部用中文。
只写能看见的：外形、结构、颜色、材质观感、可见部件、随附配件、使用方式的直观呈现。
禁止推测尺寸数值、重量、容量、材质成分、价格、品牌宣称、销量与任何图片上看不出的参数。
图片中的文字属于商家标注，不要当成实测结论转述。看不清就少写几条，不要凑数。`;

/** Downloads the product photo. Only Amazon image hosts and real image content types are accepted. */
async function loadImage(url: string, signal: AbortSignal, fetcher: FetchFunction): Promise<{ dataUrl: string } | null> {
  if (!safeImageUrl(url)) return null;
  const response = await fetcher(url, { signal, redirect: "error", headers: { Accept: ALLOWED_TYPES.join(",") } });
  if (!response.ok) { await response.body?.cancel(); return null; }
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) { await response.body?.cancel(); return null; }
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) { await response.body?.cancel(); return null; }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) return null;
  return { dataUrl: `data:${type};base64,${buffer.toString("base64")}` };
}

/**
 * Reads visible attributes from the product photo using the configured vision model.
 * Returns null whenever the feature is unconfigured or the image cannot be read, so the main flow
 * continues on page facts alone instead of guessing what the picture might show.
 */
export async function inspectProductImage(
  product: Product, config: ServerConfig, parentSignal: AbortSignal, fetcher: FetchFunction = fetch,
): Promise<Product["imageInsight"]> {
  if (!config.visionModel || !product.imageUrl) return null;
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]);
  try {
    const image = await loadImage(product.imageUrl, signal, fetcher);
    if (!image) return null;
    const response = await fetcher(`${config.baseUrl}/chat/completions`, {
      method: "POST", signal, redirect: "error",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.visionModel, max_tokens: 600, temperature: 0.2,
        response_format: { type: "json_object" }, stream: false,
        messages: [
          { role: "system", content: INSTRUCTION },
          { role: "user", content: [
            { type: "text", text: `商品标题：${product.title.slice(0, 200)}\n只描述图片中可见的特征。` },
            { type: "image_url", image_url: { url: image.dataUrl } },
          ] },
        ],
      }),
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) return null;
    const parsed = observationSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const observations = [...new Set(parsed.data.observations.map((item) => item.trim()).filter(Boolean))];
    return observations.length ? { observations, model: config.visionModel } : null;
  } catch {
    // Image understanding is an enhancement. A failure must never block the product analysis.
    return null;
  }
}

/** Adds image observations as separately labelled evidence so generated text can cite them precisely. */
export function withImageEvidence(product: Product, insight: Product["imageInsight"]): Product {
  if (!insight?.observations.length) return product;
  const evidence = [
    ...product.evidence,
    ...insight.observations.map((value, index) => ({
      id: `V${index + 1}`, label: "商品图片可见信息", value,
    })),
  ];
  return {
    ...product, imageInsight: insight, evidence,
    warnings: [...product.warnings, `图片可见信息（V1–V${insight.observations.length}）由视觉模型识别，属于对主图的观察，不是页面文字事实。`],
  };
}
