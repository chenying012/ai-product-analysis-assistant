import { createHash, timingSafeEqual } from "node:crypto";
import { normalizeAmazonUrl } from "../amazon-url";
import { requestSchema, type AnalysisEvent, type Product } from "../contracts";
import { AppError, publicError } from "../errors";
import { getServerConfig, type ServerConfig } from "./config";
import { generateContent, type GenerationResult } from "./generate";
import { inspectProductImage, withImageEvidence } from "./vision";
import { fetchProduct, readResponseText } from "./source";

export class RequestGate {
  private active = 0;
  private starts: number[] = [];
  acquire(now = Date.now()): () => void {
    this.starts = this.starts.filter((time) => now - time < 60000);
    if (this.active >= 2 || this.starts.length >= 10) throw new AppError("RATE_LIMITED", "当前请求较多，请稍后重试。", 429, true);
    this.active++;
    this.starts.push(now);
    let released = false;
    return () => { if (!released) { this.active--; released = true; } };
  }
}

const gate = new RequestGate();

type Dependencies = {
  config: () => ServerConfig;
  product: typeof fetchProduct;
  generate: (product: Product, config: ServerConfig, signal: AbortSignal) => Promise<GenerationResult>;
  inspectImage: (product: Product, config: ServerConfig, signal: AbortSignal) => Promise<Product["imageInsight"]>;
  accessToken: () => string;
  gate: RequestGate;
};

const defaults: Dependencies = {
  config: getServerConfig,
  product: fetchProduct,
  generate: generateContent,
  inspectImage: inspectProductImage,
  accessToken: () => process.env.APP_ACCESS_TOKEN?.trim() || "",
  gate,
};

export function createAnalyzeHandler(dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  return async function POST(request: Request): Promise<Response> {
    let release: (() => void) | undefined;
    try {
      const expected = deps.accessToken();
      if (expected) {
        const supplied = request.headers.get("x-app-access-token") || "";
        const hash = (value: string) => createHash("sha256").update(value).digest();
        if (!timingSafeEqual(hash(expected), hash(supplied))) throw new AppError("ACCESS_DENIED", "访问口令不正确，请向网站维护者获取口令。", 401);
      }
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new AppError("INVALID_REQUEST", "请求格式不正确。", 400);
      const raw = await readResponseText(new Response(request.body, { headers: request.headers }), 4096).catch((error: unknown) => {
        if (error instanceof AppError && error.code === "RESPONSE_TOO_LARGE") throw new AppError("REQUEST_TOO_LARGE", "请求内容过大，请只提交商品链接。", 413);
        throw error;
      });
      let body: unknown;
      try { body = JSON.parse(raw); } catch { throw new AppError("INVALID_REQUEST", "请输入有效商品链接。", 400); }
      const input = requestSchema.safeParse(body);
      if (!input.success) throw new AppError("INVALID_REQUEST", "请输入长度不超过2048字符的完整商品链接。", 400);
      const link = normalizeAmazonUrl(input.data.url);
      const config = deps.config();
      release = deps.gate.acquire();
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new DOMException("Request timed out", "TimeoutError")), 90000);
      const signal = AbortSignal.any([request.signal, abort.signal]);
      const encoder = new TextEncoder();
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: AnalysisEvent) => {
            if (!closed && !signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          void (async () => {
            try {
              emit({ type: "stage", stage: "fetching" });
              let product = await deps.product(link, config, signal);
              signal.throwIfAborted();
              if (config.visionModel && product.imageUrl) {
                emit({ type: "stage", stage: "inspecting" });
                product = withImageEvidence(product, await deps.inspectImage(product, config, signal));
                signal.throwIfAborted();
              }
              emit({ type: "product", product });
              emit({ type: "stage", stage: "analyzing" });
              const { content, quality } = await deps.generate(product, config, signal);
              signal.throwIfAborted();
              emit({ type: "result", content, quality });
            } catch (error) {
              if (!closed) {
                const safe = publicError(error);
                controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error: safe })}\n`));
              }
            } finally {
              clearTimeout(timeout);
              release?.();
              if (!closed) { closed = true; controller.close(); }
            }
          })();
        },
        cancel() { closed = true; abort.abort(); clearTimeout(timeout); },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    } catch (error) {
      release?.();
      return Response.json({ error: publicError(error) }, { status: error instanceof AppError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
