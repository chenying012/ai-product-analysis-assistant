import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../lib/errors";
import { consumeAnalysisStream } from "../lib/event-stream";
import type { AnalysisEvent } from "../lib/contracts";
import { createAnalyzeHandler, RequestGate } from "../lib/server/analyze-handler";
import { generateContent } from "../lib/server/generate";
import { fetchProduct, type HtmlFetcher } from "../lib/server/source";
import { parseFetchEndpoint } from "../lib/server/config";
import { config, link, product, validContent, html as fixtureHtml } from "./fixtures";

const restrictedHtml = fixtureHtml.replace(
  '<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$29.95</span></span></div>',
  '<div id="outOfStock">This item cannot be shipped to your selected delivery location.</div>',
);

test("a region-restricted price is recovered through the configured relay", async () => {
  const seen: string[] = [];
  const fetcher: HtmlFetcher = async (_link, provider) => { seen.push(provider); return provider === "direct" ? restrictedHtml : fixtureHtml; };
  const result = await fetchProduct(link, { ...config, fetchEndpoint: "https://relay.invalid/fetch?url={url}" }, new AbortController().signal, fetcher);
  assert.deepEqual(seen, ["direct", "relay"]);
  assert.equal(result.price?.display, "$29.95");
  assert.equal(result.source.provider, "relay");
  assert.ok(result.warnings[0].includes("从其他地区取得"));
});

test("a relay result for a different ASIN is rejected instead of shown", async () => {
  const fetcher: HtmlFetcher = async (_link, provider) => provider === "direct" ? restrictedHtml : fixtureHtml.replace(/B000TEST01/g, "B000OTHER9");
  const result = await fetchProduct(link, { ...config, fetchEndpoint: "https://relay.invalid/fetch?url={url}" }, new AbortController().signal, fetcher);
  assert.equal(result.price, null);
  assert.equal(result.priceUnavailableReason, "region_restricted");
  assert.ok(result.warnings.some((message) => message.includes("未成功")));
});

test("a failing relay keeps the facts already collected", async () => {
  const fetcher: HtmlFetcher = async (_link, provider) => {
    if (provider === "direct") return restrictedHtml;
    throw new AppError("SOURCE_PROVIDER_ERROR", "中转失败", 502, true);
  };
  const result = await fetchProduct(link, { ...config, fetchEndpoint: "https://relay.invalid/fetch?url={url}" }, new AbortController().signal, fetcher);
  assert.equal(result.title, "测试用折叠收纳盒");
  assert.equal(result.price, null);
  assert.ok(result.warnings.some((message) => message.includes("未成功")));
});

test("without a fallback the restriction is reported without extra retry noise", async () => {
  const providers: string[] = [];
  const fetcher: HtmlFetcher = async (_link, provider) => { providers.push(provider); return restrictedHtml; };
  const result = await fetchProduct(link, config, new AbortController().signal, fetcher);
  assert.deepEqual(providers, ["direct"]);
  assert.ok(result.warnings.some((message) => message.includes("无法配送")));
  assert.ok(!result.warnings.some((message) => message.includes("未成功")));
});

test("an available price never triggers a fallback request", async () => {
  const providers: string[] = [];
  const fetcher: HtmlFetcher = async (_link, provider) => { providers.push(provider); return fixtureHtml; };
  const result = await fetchProduct(link, { ...config, fetchEndpoint: "https://relay.invalid/fetch?url={url}" }, new AbortController().signal, fetcher);
  assert.deepEqual(providers, ["direct"]);
  assert.equal(result.price?.display, "$29.95");
});

test("the relay template must be an HTTPS address containing the url placeholder", () => {
  assert.equal(parseFetchEndpoint(undefined), "");
  assert.equal(parseFetchEndpoint("  "), "");
  assert.equal(parseFetchEndpoint("https://relay.example/fetch?url={url}"), "https://relay.example/fetch?url={url}");
  for (const invalid of ["https://relay.example/fetch", "http://relay.example/fetch?url={url}", "https://user:pass@relay.example/?url={url}", "not-a-url{url}"]) {
    assert.throws(() => parseFetchEndpoint(invalid), (error: unknown) => error instanceof AppError && error.code === "SOURCE_NOT_CONFIGURED", invalid);
  }
});

function chatResponse(content: string, finish_reason = "stop") {
  return Response.json({ choices: [{ message: { content }, finish_reason }] });
}
function request(url = link.url, token = "") {
  return new Request("http://localhost/api/analyze", { method: "POST", headers: { "Content-Type": "application/json", "x-app-access-token": token }, body: JSON.stringify({ url }) });
}
function handler(overrides: Parameters<typeof createAnalyzeHandler>[0] = {}) {
  return createAnalyzeHandler({ config: () => config, product: async () => product, generate: async () => validContent, accessToken: () => "", gate: new RequestGate(), ...overrides });
}

test("model adapter makes a real-format request and validates content without test data in production", async () => {
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(input, "https://model.invalid/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test-model");
    assert.equal(body.response_format.type, "json_object");
    assert.equal(body.stream, false);
    assert.ok(body.messages[1].content.includes("F5"));
    return chatResponse(JSON.stringify(validContent));
  };
  assert.deepEqual(await generateContent(product, config, new AbortController().signal, fetcher), validContent);
});
test("DeepSeek official endpoint explicitly disables thinking", async () => {
  const fetcher: typeof fetch = async (_, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.response_format.type, "json_object");
    return chatResponse(JSON.stringify(validContent));
  };
  await generateContent(product, { ...config, baseUrl: "https://api.deepseek.com", model: "deepseek-flash" }, new AbortController().signal, fetcher);
});
test("other providers do not receive DeepSeek-specific parameters", async () => {
  const fetcher: typeof fetch = async (_, init) => {
    assert.equal("thinking" in JSON.parse(String(init?.body)), false);
    return chatResponse(JSON.stringify(validContent));
  };
  for (const baseUrl of ["https://api.openai.com/v1", "https://api.deepseek.com.example.test/v1"]) {
    await generateContent(product, { ...config, baseUrl }, new AbortController().signal, fetcher);
  }
});
test("repairs invalid generated JSON once using the same facts", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_, init) => {
    calls++;
    if (calls === 1) return chatResponse("{broken");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messages.length, 4);
    return chatResponse(JSON.stringify(validContent));
  };
  await generateContent(product, config, new AbortController().signal, fetcher);
  assert.equal(calls, 2);
});
test("does not retry indefinitely on invalid content", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return chatResponse("{}"); };
  await assert.rejects(() => generateContent(product, config, new AbortController().signal, fetcher), (error: unknown) => error instanceof AppError && error.code === "MODEL_VALIDATION_FAILED");
  assert.equal(calls, 2);
});
test("provider authorization failure is not retried or leaked", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response("upstream private response", { status: 401 }); };
  await assert.rejects(() => generateContent(product, config, new AbortController().signal, fetcher), (error: unknown) => error instanceof AppError && !error.message.includes("private") && error.code === "MODEL_PROVIDER_ERROR");
  assert.equal(calls, 1);
});
test("refusal is not treated as successful text", async () => {
  const fetcher: typeof fetch = async () => Response.json({ choices: [{ message: { refusal: "refused" }, finish_reason: "stop" }] });
  await assert.rejects(() => generateContent(product, config, new AbortController().signal, fetcher), (error: unknown) => error instanceof AppError && error.code === "MODEL_REFUSAL");
});
test("truncated model responses are repaired rather than silently accepted", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => chatResponse(JSON.stringify(validContent), ++calls === 1 ? "length" : "stop");
  await generateContent(product, config, new AbortController().signal, fetcher);
  assert.equal(calls, 2);
});
test("pipeline sends ordered actual stages, product and validated result", async () => {
  const events: AnalysisEvent[] = [];
  const response = await handler()(request());
  await consumeAnalysisStream(response, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ["stage", "product", "stage", "result"]);
  assert.deepEqual(events.at(-1), { type: "result", content: validContent });
});
test("missing configuration fails before scraping or model requests", async () => {
  let fetched = false;
  const response = await handler({ config: () => { throw new AppError("MODEL_NOT_CONFIGURED", "未配置", 503); }, product: async () => { fetched = true; return product; } })(request());
  assert.equal(response.status, 503);
  assert.equal(fetched, false);
  assert.equal((await response.json()).error.code, "MODEL_NOT_CONFIGURED");
});
test("invalid URL is rejected by the server before provider access", async () => {
  let configured = false;
  const response = await handler({ config: () => { configured = true; return config; } })(request("https://example.com/dp/B000TEST01"));
  assert.equal(response.status, 400);
  assert.equal(configured, false);
});
test("oversized request is rejected as 413 before any provider request", async () => {
  const response = await handler()(new Request("http://localhost/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "a".repeat(5000) }) }));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "REQUEST_TOO_LARGE");
});
test("rejects non-JSON request types", async () => {
  const response = await handler()(new Request("http://localhost/api/analyze", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "invalid" }));
  assert.equal(response.status, 400);
});
test("cancelling the response aborts pending work and releases its slot", async () => {
  const gate = new RequestGate();
  let aborted = false;
  const response = await handler({ gate, product: async (_, __, signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true }); }) })(request());
  await response.body!.cancel();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
  const a = gate.acquire(); const b = gate.acquire(); a(); b();
});
test("source failure emits error and never invokes the model", async () => {
  let generated = false;
  const response = await handler({ product: async () => { throw new AppError("SOURCE_BLOCKED", "访问受限"); }, generate: async () => { generated = true; return validContent; } })(request());
  const events: AnalysisEvent[] = [];
  await consumeAnalysisStream(response, (event) => events.push(event));
  assert.equal(generated, false);
  assert.deepEqual(events.map((event) => event.type), ["stage", "error"]);
});
test("model failure preserves product but does not emit result", async () => {
  const response = await handler({ generate: async () => { throw new AppError("MODEL_PROVIDER_ERROR", "模型失败"); } })(request());
  const events: AnalysisEvent[] = [];
  await consumeAnalysisStream(response, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), ["stage", "product", "stage", "error"]);
});
test("access token protects the endpoint, without echoing it", async () => {
  const secured = handler({ accessToken: () => "test-access-token" });
  const denied = await secured(request());
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes("test-access-token"));
  const accepted = await secured(request(link.url, "test-access-token"));
  await consumeAnalysisStream(accepted, () => undefined);
});
test("stream decoder handles Chinese characters split across byte boundaries", async () => {
  const messages: AnalysisEvent[] = [{ type: "product", product }, { type: "result", content: validContent }];
  const bytes = new TextEncoder().encode(messages.map((message) => JSON.stringify(message)).join("\n"));
  const response = new Response(new ReadableStream({ start(controller) { for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7)); controller.close(); } }), { headers: { "Content-Type": "application/x-ndjson" } });
  const events: AnalysisEvent[] = [];
  await consumeAnalysisStream(response, (event) => events.push(event));
  assert.deepEqual(events, messages);
});
test("an interrupted stream is not accepted as completed", async () => {
  const response = new Response(JSON.stringify({ type: "product", product }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  await assert.rejects(() => consumeAnalysisStream(response, () => undefined), (error: unknown) => error instanceof AppError && error.code === "INCOMPLETE_STREAM");
});
test("result without product is not accepted", async () => {
  const response = new Response(JSON.stringify({ type: "result", content: validContent }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  await assert.rejects(() => consumeAnalysisStream(response, () => undefined), AppError);
});
test("HTTP error is surfaced using only the public error object", async () => {
  const response = Response.json({ error: { code: "MODEL_NOT_CONFIGURED", message: "请配置模型", retryable: false } }, { status: 503 });
  await assert.rejects(() => consumeAnalysisStream(response, () => undefined), (error: unknown) => error instanceof AppError && error.message === "请配置模型");
});
