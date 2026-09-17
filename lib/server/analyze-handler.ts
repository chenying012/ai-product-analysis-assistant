import { createHash, timingSafeEqual } from "node:crypto";
import { normalizeAmazonUrl } from "../amazon-url";
import { requestSchema, type AnalysisEvent, type Product } from "../contracts";
import { AppError, publicError } from "../errors";
import { getServerConfig, type ServerConfig } from "./config";
import { generateContent, type GenerationResult } from "./generate";
import { inspectProductImage, withImageEvidence } from "./vision";
import { fetchProduct, readResponseText } from "./source";
import { readCookie, requireUser, SESSION_COOKIE, type AuthContext } from "./auth";
import { holdCredit, type CreditHold } from "./credits";
import { createId, type AccountStore } from "./store";

/**
 * Limits concurrent and short-term request volume to protect the process itself.
 *
 * Counters are held per identity rather than globally so one busy account cannot starve the others.
 * This is a per-instance guard; the credit ledger provides the cross-instance quota.
 */
export class RequestGate {
  private active = new Map<string, number>();
  private starts = new Map<string, number[]>();

  acquire(key = "anonymous", now = Date.now()): () => void {
    const recent = (this.starts.get(key) ?? []).filter((time) => now - time < 60000);
    const running = this.active.get(key) ?? 0;
    if (running >= 2 || recent.length >= 10) throw new AppError("RATE_LIMITED", "当前请求较多，请稍后重试。", 429, true);
    this.active.set(key, running + 1);
    this.starts.set(key, [...recent, now]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining > 0) this.active.set(key, remaining); else this.active.delete(key);
    };
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
  /** Account storage. When absent the endpoint runs in its original single-user mode: no login, no
   * credit accounting and no history, which keeps the tool usable before a database is configured. */
  store?: AccountStore;
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
    let hold: CreditHold | undefined;
    let auth: AuthContext | undefined;
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
      const store = deps.store;
      if (store) auth = await requireUser(store, readCookie(request.headers.get("cookie"), SESSION_COOKIE));
      release = deps.gate.acquire(auth?.user.id);
      // Identifies this attempt in the ledger, the audit trail and the saved analysis, so all three
      // can be reconciled afterwards.
      const analysisId = createId();
      // Charged before the stream opens: afterwards the status code is fixed and 402 is impossible.
      if (store && auth) hold = await holdCredit(store, auth.user.id, analysisId);
      const abort = new AbortController();
      const timeout = setTimeout(() => abort.abort(new DOMException("Request timed out", "TimeoutError")), 90000);
      const signal = AbortSignal.any([request.signal, abort.signal]);
      const encoder = new TextEncoder();
      let closed = false;
      const settle = async (outcome: "success" | "failed", errorCode: string | null, product: Product | null, result: GenerationResult | null) => {
        if (!store || !auth) return;
        // A run that produced nothing usable returns the credit; a completed one keeps it even when
        // the quality report flags issues, because the model tokens were really spent.
        if (outcome === "failed") await hold?.refund();
        if (product) {
          await store.saveAnalysis(auth.user.id, {
            id: analysisId, asin: product.asin, marketplace: product.marketplace, product,
            content: result?.content ?? null, quality: result?.quality ?? null,
            createdAt: new Date().toISOString(),
          });
        }
        await store.recordActivity(auth.user.id, {
          action: "analyze", outcome, target: link.asin, errorCode,
          creditsDelta: outcome === "failed" ? 0 : -1,
        });
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: AnalysisEvent) => {
            if (!closed && !signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          void (async () => {
            let product: Product | null = null;
            try {
              emit({ type: "stage", stage: "fetching" });
              product = await deps.product(link, config, signal);
              signal.throwIfAborted();
              if (config.visionModel && product.imageUrl) {
                emit({ type: "stage", stage: "inspecting" });
                product = withImageEvidence(product, await deps.inspectImage(product, config, signal));
                signal.throwIfAborted();
              }
              emit({ type: "product", product });
              emit({ type: "stage", stage: "analyzing" });
              const result = await deps.generate(product, config, signal);
              signal.throwIfAborted();
              emit({ type: "result", content: result.content, quality: result.quality });
              await settle("success", null, product, result);
            } catch (error) {
              const safe = publicError(error);
              await settle("failed", safe.code, product, null).catch(() => undefined);
              if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify({ type: "error", error: safe })}\n`));
            } finally {
              clearTimeout(timeout);
              release?.();
              if (!closed) { closed = true; controller.close(); }
            }
          })();
        },
        cancel() {
          closed = true;
          abort.abort();
          clearTimeout(timeout);
          // Cancelling skips the stream's own error path, so the charge is released here. The user
          // received nothing, and refund() stays safe if that path already ran.
          void hold?.refund().catch(() => undefined);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
    } catch (error) {
      // Nothing was streamed yet, so a charge taken moments ago has to be undone here.
      await hold?.refund().catch(() => undefined);
      release?.();
      return Response.json({ error: publicError(error) }, { status: error instanceof AppError ? error.status : 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}
