import test from "node:test";
import assert from "node:assert/strict";
import type { Content, Product } from "../lib/contracts";
import { estimateSpeechSeconds, reviewContent, blockingIssueInstruction, SPEECH_CHARACTERS_PER_SECOND } from "../lib/server/quality";
import { inspectProductImage, withImageEvidence } from "../lib/server/vision";
import { generateContent } from "../lib/server/generate";
import { config, product, validContent } from "./fixtures";

function withScript(hook: string, body: string, base: Content = validContent): Content {
  return { ...base, script: { ...base.script, hook, body } };
}
function withSellingPoint(description: string): Content {
  return { ...validContent, sellingPoints: [{ title: "卖点", description, evidenceIds: ["F5"] }] };
}

test("a clean draft passes the quality check", () => {
  const report = reviewContent(validContent, product);
  assert.equal(report.passed, true);
  assert.deepEqual(report.issues.filter((issue) => issue.severity === "blocking"), []);
  assert.equal(report.evidence.total, product.evidence.length);
  assert.ok(report.evidence.cited > 0);
});

test("absolute and guarantee wording is blocked", () => {
  for (const phrase of ["这款收纳盒百分百好用", "绝对不会变形，放心买", "一定能解决你的收纳问题", "彻底解决杂物堆积", "买了再也不用整理"]) {
    const report = reviewContent(withSellingPoint(phrase), product);
    assert.equal(report.passed, false, phrase);
    assert.ok(report.issues.some((issue) => issue.code === "absolute_claim" || issue.code === "guaranteed_effect"), phrase);
  }
});

test("overstating a comfort claim as fatigue-free is blocked", () => {
  const report = reviewContent(withScript("坐着不舒服吗？", "这把椅子坐久了也不累，随时都轻松。"), product);
  assert.equal(report.passed, false);
  const issue = report.issues.find((item) => item.code === "guaranteed_effect");
  assert.ok(issue, "应识别为效果承诺");
  assert.ok(issue!.message.includes("标称"));
});

test("numbers that are absent from the material are blocked", () => {
  const report = reviewContent(withSellingPoint("容量达到 45 升，能装很多东西。"), product);
  const issue = report.issues.find((item) => item.code === "unsupported_number");
  assert.ok(issue);
  assert.equal(issue!.excerpt, "45");
  // A number that the page really states must stay allowed.
  const allowed = reviewContent(withSellingPoint("材质为 Fabric，结构可折叠。"), product);
  assert.equal(allowed.issues.some((item) => item.code === "unsupported_number"), false);
});

test("price wording is blocked when no price was collected", () => {
  assert.equal(product.price?.display, "$29.95");
  const priced = reviewContent(withScript("预算有限？", "这个价格能买到可折叠收纳盒，日常够用。"), product);
  assert.equal(priced.issues.some((issue) => issue.code === "price_claim"), false, "有价格时允许提及价格");
  const unpriced: Product = { ...product, price: null, priceUnavailableReason: "region_restricted" };
  const report = reviewContent(withScript("预算有限？", "这个价格能买到可折叠收纳盒，很划算。"), unpriced);
  assert.equal(report.passed, false);
  assert.ok(report.issues.some((issue) => issue.code === "price_claim"));
});

test("competitor comparisons and health claims are blocked", () => {
  const comparison = reviewContent(withSellingPoint("比其他同类收纳盒都要结实。"), product);
  assert.ok(comparison.issues.some((issue) => issue.code === "unsupported_comparison"));
  const health = reviewContent(withSellingPoint("还能杀菌除螨，改善睡眠。"), product);
  assert.ok(health.issues.some((issue) => issue.code === "health_claim"));
  // A term the page itself states is not treated as an invented health claim.
  const stated: Product = { ...product, evidence: [...product.evidence, { id: "FX", label: "页面功能描述", value: "抗菌涂层" }] };
  const allowed = reviewContent(withSellingPoint("页面标称有抗菌涂层。"), stated);
  assert.equal(allowed.issues.some((issue) => issue.code === "health_claim"), false);
});

test("purchase pressure is advisory rather than blocking", () => {
  const report = reviewContent(withScript("还在犹豫？", "限时优惠中，赶紧下单带走这个收纳盒。"), { ...product, price: null });
  const pressure = report.issues.find((issue) => issue.code === "purchase_pressure");
  assert.ok(pressure);
  assert.equal(pressure!.severity, "advisory");
});

test("speech time is estimated from spoken characters and pauses", () => {
  assert.equal(estimateSpeechSeconds(""), 0);
  assert.equal(estimateSpeechSeconds("十个字的中文句"), Math.round((7 / SPEECH_CHARACTERS_PER_SECOND) * 10) / 10);
  assert.ok(estimateSpeechSeconds("一句话，两停顿。") > estimateSpeechSeconds("一句话两停顿"));
  // The 20-character hook limit already keeps a valid hook at about four seconds, so the timing rule
  // acts as a guard for looser input rather than a routine blocker.
  const short = reviewContent(withScript("露营晒到没处躲？", validContent.script.body), product);
  assert.equal(short.speech.hookWithinFiveSeconds, true);
  assert.ok(short.speech.hookSeconds > 0 && short.speech.hookSeconds < 5);
  assert.equal(short.speech.totalSeconds > short.speech.hookSeconds, true);
  const overLimit = "这是一句故意写得非常长的开场白用来测试时长估算是否会在超过上限时给出提示";
  assert.ok(estimateSpeechSeconds(overLimit) > 5);
  const long = reviewContent(withScript(overLimit, validContent.script.body), product);
  assert.equal(long.speech.hookWithinFiveSeconds, false);
  const issue = long.issues.find((item) => item.code === "hook_too_slow");
  assert.ok(issue);
  assert.equal(issue!.severity, "advisory", "时长只是估算，不应拦截结果");
});

test("the correction request names the issues without inventing facts", () => {
  const content = withSellingPoint("绝对不会变形，容量 45 升。");
  const instruction = blockingIssueInstruction(reviewContent(content, product), content);
  assert.ok(instruction.includes("45"));
  assert.ok(instruction.includes("不要添加新事实"));
  assert.ok(instruction.includes("150"));
});

test("image analysis stays disabled until a vision model is configured", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return Response.json({}); };
  assert.equal(await inspectProductImage(product, config, new AbortController().signal, fetcher), null);
  assert.equal(called, false, "未配置视觉模型时不应发出任何请求");
});

test("image analysis rejects non-image content and hosts outside Amazon", async () => {
  const visionConfig = { ...config, visionModel: "vision-model" };
  const htmlResponse: typeof fetch = async () => new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
  assert.equal(await inspectProductImage({ ...product, imageUrl: "https://m.media-amazon.com/images/I/a.jpg" }, visionConfig, new AbortController().signal, htmlResponse), null);
  let requested = false;
  const anyResponse: typeof fetch = async () => { requested = true; return new Response("x", { headers: { "Content-Type": "image/png" } }); };
  assert.equal(await inspectProductImage({ ...product, imageUrl: "https://evil.example.com/a.jpg" }, visionConfig, new AbortController().signal, anyResponse), null);
  assert.equal(requested, false, "非 Amazon 图片主机不应被下载");
});

test("image analysis returns observations and never blocks on model failure", async () => {
  const visionConfig = { ...config, visionModel: "vision-model" };
  const imageProduct = { ...product, imageUrl: "https://m.media-amazon.com/images/I/test.jpg" };
  const fetcher = (payload: unknown): typeof fetch => async (input) => String(input).includes("media-amazon")
    ? new Response(Buffer.from([1, 2, 3]), { headers: { "Content-Type": "image/jpeg" } })
    : Response.json(payload);
  const ok = await inspectProductImage(imageProduct, visionConfig, new AbortController().signal,
    fetcher({ choices: [{ message: { content: JSON.stringify({ observations: ["米白色方形收纳盒", "侧面有提手"] }) } }] }));
  assert.deepEqual(ok, { observations: ["米白色方形收纳盒", "侧面有提手"], model: "vision-model" });
  for (const broken of [{ choices: [{ message: { content: "not json" } }] }, { choices: [{ message: { content: JSON.stringify({ observations: [] }) } }] }, {}]) {
    assert.equal(await inspectProductImage(imageProduct, visionConfig, new AbortController().signal, fetcher(broken)), null);
  }
});

test("image observations become separately numbered evidence", () => {
  const enriched = withImageEvidence(product, { observations: ["米白色方形收纳盒", "侧面有提手"], model: "vision-model" });
  assert.equal(enriched.evidence.length, product.evidence.length + 2);
  const added = enriched.evidence.slice(-2);
  assert.deepEqual(added.map((fact) => fact.id), ["V1", "V2"]);
  assert.ok(added.every((fact) => fact.label === "商品图片可见信息"));
  assert.ok(enriched.warnings.some((warning) => warning.includes("视觉模型")));
  assert.deepEqual(withImageEvidence(product, null), product);
  // Text facts keep their original identifiers so existing citations stay valid.
  assert.deepEqual(enriched.evidence.slice(0, product.evidence.length), product.evidence);
});

test("generated text may cite image evidence", () => {
  const enriched = withImageEvidence(product, { observations: ["米白色方形收纳盒"], model: "vision-model" });
  const content: Content = { ...validContent, sellingPoints: [{ title: "外观简洁", description: "从主图可见是米白色方形盒体，摆放在客厅不突兀。", evidenceIds: ["V1"] }] };
  const report = reviewContent(content, enriched);
  assert.equal(report.passed, true);
  assert.ok(report.evidence.cited > 0);
});

const conditioned: Product = {
  ...product,
  evidence: [...product.evidence, { id: "FC", label: "页面功能描述", value: "Extend Wi-Fi coverage with a compatible eero network; router sold separately." }],
};

test("a prerequisite stated in the cited evidence must appear in the copy", () => {
  const dropped: Content = { ...validContent, sellingPoints: [{ title: "扩展网络", description: "它还能扩展家里的 Wi-Fi 覆盖范围，信号更稳。", evidenceIds: ["FC"] }] };
  const report = reviewContent(dropped, conditioned);
  assert.equal(report.passed, false, "遗漏前提条件应被拦截");
  const issue = report.issues.find((item) => item.code === "dropped_condition");
  assert.ok(issue, "应识别为前提条件遗漏");
  assert.equal(issue!.severity, "blocking");
  assert.ok(issue!.message.includes("FC"));
});

test("copy that keeps the prerequisite passes", () => {
  const kept: Content = { ...validContent, sellingPoints: [{ title: "扩展网络", description: "如果已有兼容的 eero 网络，它还能帮助扩展 Wi-Fi 覆盖，路由需单独购买。", evidenceIds: ["FC"] }] };
  const report = reviewContent(kept, conditioned);
  assert.equal(report.issues.some((issue) => issue.code === "dropped_condition"), false);
});

test("evidence without a prerequisite is not flagged", () => {
  const report = reviewContent(validContent, product);
  assert.equal(report.issues.some((issue) => issue.code === "dropped_condition"), false);
});

test("marketing questions and identity fields do not raise false conditions", () => {
  // "Need a bigger sound?" is a marketing question, and the product name is routinely cited for naming.
  const noisy: Product = {
    ...product,
    evidence: [
      { id: "F1", label: "商品名称", value: "Echo Dot - Need a bigger sound? Requires nothing extra" },
      ...product.evidence.slice(1),
    ],
  };
  const citesTitle: Content = { ...validContent, audiences: [{ title: "小空间用户", description: "适合卧室或书桌使用的小型设备。", evidenceIds: ["F1"] }] };
  const report = reviewContent(citesTitle, noisy);
  assert.equal(report.issues.some((issue) => issue.code === "dropped_condition"), false, "标题里的营销问句不应算前提条件");
  assert.equal(report.issues.some((issue) => issue.code === "weak_citation"), false, "引用商品名称属正常命名");
});

test("the same prerequisite is reported once instead of per field", () => {
  const dropped: Content = {
    ...validContent,
    scenarios: [{ title: "扩展覆盖", description: "在客厅也能把网络信号带过去。", evidenceIds: ["FC"] }],
    sellingPoints: [{ title: "扩展网络", description: "它还能扩展家里的 Wi-Fi 覆盖范围。", evidenceIds: ["FC"] }],
  };
  const conditions = reviewContent(dropped, conditioned).issues.filter((issue) => issue.code === "dropped_condition");
  assert.equal(conditions.length, 1, "同一依据的同一条件只报一次");
});

test("a citation unrelated to the claim is reported as advisory", () => {
  const spec = product.evidence.find((fact) => fact.label === "Material");
  assert.ok(spec, "固定数据应包含规格依据");
  const unrelated: Content = { ...validContent, sellingPoints: [{ title: "静音", description: "运转时几乎听不到噪音。", evidenceIds: [spec!.id] }] };
  const report = reviewContent(unrelated, product);
  const issue = report.issues.find((item) => item.code === "weak_citation");
  assert.ok(issue, "全部引用都无关时应提示");
  assert.equal(issue!.severity, "advisory", "弱引用只提示，不拦截");
  // A claim that genuinely restates its evidence must not be flagged.
  assert.equal(reviewContent(validContent, product).issues.some((item) => item.code === "weak_citation"), false);
});

test("one relevant citation is enough to avoid a weak-citation flag", () => {
  // Chinese copy paraphrases English page text, so per-citation term overlap would misfire constantly.
  const spec = product.evidence.find((fact) => fact.label === "Material")!;
  const feature = product.evidence.find((fact) => fact.label === "页面功能描述" && fact.value.includes("折叠"))!;
  const mixed: Content = { ...validContent, sellingPoints: [{ title: "可折叠", description: "可折叠结构便于闲置时收纳。", evidenceIds: [spec.id, feature.id] }] };
  assert.equal(reviewContent(mixed, product).issues.some((item) => item.code === "weak_citation"), false);
});

const exaggerated: Content = { ...validContent, sellingPoints: [{ title: "收纳", description: "绝对不会变形，彻底解决杂物问题。", evidenceIds: ["F5"] }] };const chatResponse = (content: Content) => Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }] });

test("a blocking quality issue triggers one correction and the fixed draft is returned", async () => {
  const prompts: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    prompts.push(body.messages.at(-1)!.content);
    return chatResponse(prompts.length === 1 ? exaggerated : validContent);
  };
  const result = await generateContent(product, config, new AbortController().signal, fetcher);
  assert.equal(prompts.length, 2, "应当只追加一次质量修正请求");
  assert.ok(prompts[1].includes("内容质量检查"), "修正请求需说明是质量问题");
  assert.ok(prompts[1].includes("绝对不会变形") || prompts[1].includes("彻底解决"), "修正请求需指出具体表述");
  assert.deepEqual(result.content, validContent);
  assert.equal(result.quality.passed, true);
  assert.equal(result.quality.revisions, 1);
});

test("content that stays exaggerated is returned with the problem reported, not silently accepted", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return chatResponse(exaggerated); };
  const result = await generateContent(product, config, new AbortController().signal, fetcher);
  assert.equal(calls, 3, "尝试次数应有上限");
  assert.deepEqual(result.content, exaggerated, "不擅自改写模型输出");
  assert.equal(result.quality.passed, false);
  assert.ok(result.quality.issues.some((issue) => issue.severity === "blocking"));
  assert.equal(result.quality.revisions, 2);
});

test("a first valid draft is never lost when a later correction attempt fails", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    if (calls === 1) return chatResponse(exaggerated);
    return new Response("upstream failure", { status: 500 });
  };
  const result = await generateContent(product, config, new AbortController().signal, fetcher);
  assert.deepEqual(result.content, exaggerated);
  assert.equal(result.quality.passed, false, "保留草稿的同时如实报告问题");
});
