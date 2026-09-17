import assert from "node:assert/strict";
import { test } from "node:test";
import type { Content, Product, Quality } from "../lib/contracts";
import { AppError } from "../lib/errors";
import { createAnalyzeHandler, RequestGate } from "../lib/server/analyze-handler";
import { ANALYSIS_COST, holdCredit, SIGNUP_BONUS } from "../lib/server/credits";
import { MemoryAccountStore } from "../lib/server/store";
import { register, SESSION_COOKIE } from "../lib/server/auth";
import { config, product as sampleProduct, validContent, validQuality } from "./fixtures";

const requestContext = { userAgent: "test", ip: "203.0.113.5" };

async function makeAccount(store: MemoryAccountStore, email = "user@example.com") {
  return register(store, { email, password: "a-long-enough-password" }, SIGNUP_BONUS, requestContext);
}

function analyzeRequest(token: string | null, url = `https://www.amazon.com/dp/${sampleProduct.asin}`): Request {
  return new Request("https://app.example.com/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    },
    body: JSON.stringify({ url }),
  });
}

type HandlerOverrides = {
  store?: MemoryAccountStore;
  product?: () => Promise<Product>;
  generate?: () => Promise<{ content: Content; quality: Quality }>;
};

function makeHandler({ store, product, generate }: HandlerOverrides) {
  return createAnalyzeHandler({
    store,
    config: () => config,
    gate: new RequestGate(),
    accessToken: () => "",
    product: product ?? (async () => sampleProduct),
    generate: generate ?? (async () => ({ content: validContent, quality: validQuality })),
    inspectImage: async () => null,
  });
}

async function drain(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("an unauthenticated request is refused before any work", async () => {
  const store = new MemoryAccountStore();
  let fetched = false;
  const handler = makeHandler({ store, product: async () => { fetched = true; return sampleProduct; } });
  const response = await handler(analyzeRequest(null));
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "UNAUTHENTICATED");
  assert.equal(fetched, false, "未登录时不应发起采集");
});

test("a successful analysis charges exactly one credit and is recorded", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  const events = await drain(await makeHandler({ store })(analyzeRequest(token)));
  assert.ok(events.some((event) => event.type === "result"));

  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS - ANALYSIS_COST);
  const ledger = await store.listCredits(user.id, { limit: 10 });
  assert.equal(ledger[0].reason, "api_call");
  assert.equal(ledger[0].delta, -ANALYSIS_COST);
  assert.equal(ledger.filter((row) => row.reason === "refund").length, 0);

  const activity = await store.listActivity(user.id, { limit: 10 });
  assert.equal(activity[0].action, "analyze");
  assert.equal(activity[0].outcome, "success");
  assert.equal(activity[0].creditsDelta, -ANALYSIS_COST);

  const analyses = await store.listAnalyses(user.id, { limit: 10 });
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].succeeded, true);
  assert.equal(analyses[0].asin, sampleProduct.asin);
});

test("the ledger reference matches the stored analysis", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  await drain(await makeHandler({ store })(analyzeRequest(token)));
  const [charge] = await store.listCredits(user.id, { limit: 1 });
  const [analysis] = await store.listAnalyses(user.id, { limit: 1 });
  assert.equal(charge.refId, analysis.id, "扣费流水必须能对应到具体的分析记录");
});

test("a collection failure refunds the credit and keeps no analysis", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  const handler = makeHandler({
    store,
    product: async () => { throw new AppError("SOURCE_BLOCKED", "采集受限。", 502, true); },
  });
  const events = await drain(await handler(analyzeRequest(token)));
  assert.equal((events.at(-1) as { error: { code: string } }).error.code, "SOURCE_BLOCKED");

  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS, "采集失败必须退回积分");
  const ledger = await store.listCredits(user.id, { limit: 10 });
  assert.equal(ledger.filter((row) => row.reason === "refund").length, 1);
  assert.equal(ledger.reduce((sum, row) => sum + row.delta, 0), SIGNUP_BONUS);

  const activity = await store.listActivity(user.id, { limit: 10 });
  assert.equal(activity[0].outcome, "failed");
  assert.equal(activity[0].errorCode, "SOURCE_BLOCKED");
  assert.equal(activity[0].creditsDelta, 0);
  assert.deepEqual(await store.listAnalyses(user.id, { limit: 10 }), []);
});

test("a model failure refunds the credit but keeps the product it did fetch", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  const handler = makeHandler({
    store,
    generate: async () => { throw new AppError("MODEL_TIMEOUT", "模型超时。", 504, true); },
  });
  const events = await drain(await handler(analyzeRequest(token)));
  assert.ok(events.some((event) => event.type === "product"), "商品档案应已推送");
  assert.equal((events.at(-1) as { error: { code: string } }).error.code, "MODEL_TIMEOUT");

  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS, "模型失败必须退回积分");
  const analyses = await store.listAnalyses(user.id, { limit: 10 });
  assert.equal(analyses.length, 1);
  assert.equal(analyses[0].succeeded, false, "已采集到的商品信息仍应保留供查看");
});

test("an exhausted balance is refused with 402 before the stream opens", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  for (let index = 0; index < SIGNUP_BONUS; index++) {
    await store.spendCredit(user.id, `used-${index}`);
  }
  let fetched = false;
  const handler = makeHandler({ store, product: async () => { fetched = true; return sampleProduct; } });
  const response = await handler(analyzeRequest(token));
  assert.equal(response.status, 402, "积分不足必须在开始推流前返回 402");
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "INSUFFICIENT_CREDITS");
  assert.match(body.error.message, /当前余额 0/, "提示应包含实际余额");
  assert.equal(fetched, false, "余额不足时不应发起采集");
});

test("an invalid link does not consume a credit", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  const response = await makeHandler({ store })(analyzeRequest(token, "https://example.com/not-amazon"));
  assert.ok(response.status >= 400);
  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS, "链接无效时不应扣分");
  assert.deepEqual(await store.listCredits(user.id, { limit: 10 }).then((rows) => rows.filter((row) => row.reason === "api_call")), []);
});

test("cancelling the response returns the credit", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  const handler = makeHandler({
    store,
    generate: () => new Promise(() => undefined),
  });
  const response = await handler(analyzeRequest(token));
  await response.body?.cancel();
  // The refund is issued from the stream's cancel hook, which runs asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS, "用户取消后必须退回积分");
});

test("balances are independent between accounts", async () => {
  const store = new MemoryAccountStore();
  const alice = await makeAccount(store, "alice@example.com");
  const bob = await makeAccount(store, "bob@example.com");
  await drain(await makeHandler({ store })(analyzeRequest(alice.token)));
  assert.equal((await store.findUserById(alice.user.id))?.credits, SIGNUP_BONUS - ANALYSIS_COST);
  assert.equal((await store.findUserById(bob.user.id))?.credits, SIGNUP_BONUS, "扣费不得影响其他账户");
  assert.deepEqual(await store.listAnalyses(bob.user.id, { limit: 10 }), []);
});

test("repeated analyses spend down the balance one credit at a time", async () => {
  const store = new MemoryAccountStore();
  const { user, token } = await makeAccount(store);
  const handler = makeHandler({ store });
  for (let index = 0; index < 3; index++) await drain(await handler(analyzeRequest(token)));
  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS - 3);
  assert.equal((await store.listAnalyses(user.id, { limit: 10 })).length, 3);
});

test("a hold refuses to charge an account that cannot pay", async () => {
  const store = new MemoryAccountStore();
  const { user } = await makeAccount(store);
  for (let index = 0; index < SIGNUP_BONUS; index++) await store.spendCredit(user.id, `drain-${index}`);
  await assert.rejects(
    () => holdCredit(store, user.id, "next"),
    (error: unknown) => error instanceof AppError && error.code === "INSUFFICIENT_CREDITS" && error.status === 402,
  );
});

test("refunding a hold twice returns only one credit", async () => {
  const store = new MemoryAccountStore();
  const { user } = await makeAccount(store);
  const hold = await holdCredit(store, user.id, "job-1");
  assert.equal(hold.balance, SIGNUP_BONUS - ANALYSIS_COST);
  await hold.refund();
  await hold.refund();
  assert.equal((await store.findUserById(user.id))?.credits, SIGNUP_BONUS);
  assert.equal((await store.listCredits(user.id, { limit: 10 })).filter((row) => row.reason === "refund").length, 1);
});

test("the endpoint still works without a store, in single-user mode", async () => {
  // Preserves the original behaviour so the tool remains usable before a database is configured.
  const events = await drain(await makeHandler({})(analyzeRequest(null)));
  assert.ok(events.some((event) => event.type === "result"), "未配置账户存储时应保持原有单用户行为");
});
