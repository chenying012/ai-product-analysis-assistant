import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createActivityHandler, createAnalysesHandler, createAnalysisDetailHandler,
  createLoginHandler, createLogoutHandler, createMeHandler, createRegisterHandler,
} from "../lib/server/account-handlers";
import { SESSION_COOKIE } from "../lib/server/auth";
import { MemoryAccountStore, createId, type StoredAnalysis } from "../lib/server/store";
import { product as sampleProduct, validContent, validQuality } from "./fixtures";

function jsonRequest(body: unknown, cookie?: string): Request {
  return new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-proto": "https",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const value = header.split(";")[0];
  assert.ok(value.startsWith(`${SESSION_COOKIE}=`), "响应应设置会话 Cookie");
  return value;
}

const password = "a-long-enough-password";

async function signUp(store: MemoryAccountStore, email: string): Promise<{ cookie: string; userId: string }> {
  const response = await createRegisterHandler({ store })(jsonRequest({ email, password }));
  const cookie = cookieOf(response);
  const body = (await response.json()) as { user?: { id: string }; error?: { code: string } };
  assert.equal(response.status, 201, `注册应成功，实际返回 ${response.status} ${JSON.stringify(body)}`);
  assert.ok(body.user, "注册响应应包含用户信息");
  return { cookie, userId: body.user.id };
}

function analysisOf(id: string): StoredAnalysis {
  return {
    id, asin: sampleProduct.asin, marketplace: sampleProduct.marketplace,
    product: sampleProduct, content: validContent, quality: validQuality,
    createdAt: new Date().toISOString(),
  };
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error?: { code: string } }).error?.code ?? "no-error";
}

test("registration returns the account and signs the user in", async () => {
  const store = new MemoryAccountStore();
  const { cookie, userId } = await signUp(store, "new@example.com");
  const me = await createMeHandler({ store })(getRequest("https://app.example.com/api/me", cookie));
  assert.equal(me.status, 200);
  const body = (await me.json()) as { user: { id: string; credits: number } };
  assert.equal(body.user.id, userId);
  assert.equal(body.user.credits, 10);
});

test("the response never carries the password or its hash", async () => {
  const store = new MemoryAccountStore();
  const response = await createRegisterHandler({ store })(jsonRequest({ email: "safe@example.com", password }));
  const text = await response.text();
  assert.ok(!text.includes(password));
  assert.ok(!text.includes("scrypt"));
});

test("the session cookie is http-only and same-site", async () => {
  const store = new MemoryAccountStore();
  const response = await createRegisterHandler({ store })(jsonRequest({ email: "cookie@example.com", password }));
  const header = response.headers.get("set-cookie") ?? "";
  for (const flag of ["HttpOnly", "SameSite=Lax", "Secure"]) {
    assert.ok(header.includes(flag), `缺少 ${flag}`);
  }
});

test("weak input is rejected without creating an account", async () => {
  const store = new MemoryAccountStore();
  const handler = createRegisterHandler({ store });
  for (const body of [{ email: "not-an-email", password }, { email: "a@example.com", password: "short" }, {}]) {
    const response = await handler(jsonRequest(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(await store.findUserByEmail("a@example.com"), null);
});

test("registration requires the invite code when one is configured", async () => {
  const store = new MemoryAccountStore();
  const handler = createRegisterHandler({ store, inviteCode: () => "let-me-in" });
  assert.equal(await errorCode(await handler(jsonRequest({ email: "gate@example.com", password }))), "INVITE_REQUIRED");
  assert.equal(await errorCode(await handler(jsonRequest({ email: "gate@example.com", password, inviteCode: "wrong" }))), "INVITE_REQUIRED");
  const allowed = await handler(jsonRequest({ email: "gate@example.com", password, inviteCode: "let-me-in" }));
  assert.equal(allowed.status, 201);
});

test("login issues a session and a wrong password does not", async () => {
  const store = new MemoryAccountStore();
  await signUp(store, "login@example.com");
  const handler = createLoginHandler({ store });
  const ok = await handler(jsonRequest({ email: "login@example.com", password }));
  assert.equal(ok.status, 200);
  assert.ok(cookieOf(ok));
  const bad = await handler(jsonRequest({ email: "login@example.com", password: "wrong-password-here" }));
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null, "登录失败不应下发会话");
});

test("logout clears the cookie and invalidates the session", async () => {
  const store = new MemoryAccountStore();
  const { cookie } = await signUp(store, "bye@example.com");
  const response = await createLogoutHandler({ store })(jsonRequest({}, cookie));
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const me = await createMeHandler({ store })(getRequest("https://app.example.com/api/me", cookie));
  assert.equal(me.status, 401);
});

test("every account endpoint refuses an anonymous caller", async () => {
  const store = new MemoryAccountStore();
  const checks: [string, Response][] = [
    ["me", await createMeHandler({ store })(getRequest("https://app.example.com/api/me"))],
    ["history", await createActivityHandler({ store })(getRequest("https://app.example.com/api/history"))],
    ["analyses", await createAnalysesHandler({ store })(getRequest("https://app.example.com/api/analyses"))],
  ];
  for (const [name, response] of checks) {
    assert.equal(response.status, 401, `${name} 应拒绝匿名访问`);
    assert.equal(await errorCode(response), "UNAUTHENTICATED");
  }
});

test("a forged or expired cookie authenticates nobody", async () => {
  const store = new MemoryAccountStore();
  await signUp(store, "real@example.com");
  for (const cookie of [`${SESSION_COOKIE}=forged-token`, `${SESSION_COOKIE}=`, "other=value"]) {
    const response = await createMeHandler({ store })(getRequest("https://app.example.com/api/me", cookie));
    assert.equal(response.status, 401, cookie);
  }
});

test("history and analyses only ever show the caller's own records", async () => {
  const store = new MemoryAccountStore();
  const alice = await signUp(store, "alice@example.com");
  const bob = await signUp(store, "bob@example.com");
  await store.saveAnalysis(alice.userId, analysisOf(createId()));
  await store.recordActivity(alice.userId, { action: "analyze", outcome: "success", target: "ALICE-SECRET" });
  await store.spendCredit(alice.userId, "alice-job");

  const bobHistory = await createActivityHandler({ store })(getRequest("https://app.example.com/api/history", bob.cookie));
  const historyBody = (await bobHistory.json()) as { activity: unknown[]; credits: { reason: string }[]; balance: number };
  assert.ok(!JSON.stringify(historyBody).includes("ALICE-SECRET"), "不得出现其他用户的记录");
  assert.equal(historyBody.credits.filter((row) => row.reason === "api_call").length, 0);
  assert.equal(historyBody.balance, 10, "余额应是本人的");

  const bobAnalyses = await createAnalysesHandler({ store })(getRequest("https://app.example.com/api/analyses", bob.cookie));
  assert.deepEqual(((await bobAnalyses.json()) as { analyses: unknown[] }).analyses, []);
});

test("another account's analysis id reports not found, not forbidden", async () => {
  const store = new MemoryAccountStore();
  const alice = await signUp(store, "owner@example.com");
  const bob = await signUp(store, "other@example.com");
  const analysisId = createId();
  await store.saveAnalysis(alice.userId, analysisOf(analysisId));
  const handler = createAnalysisDetailHandler({ store });

  const stolen = await handler(
    getRequest(`https://app.example.com/api/analyses/${analysisId}`, bob.cookie),
    { params: Promise.resolve({ id: analysisId }) },
  );
  // 403 would confirm the record exists, which is itself a disclosure.
  assert.equal(stolen.status, 404, "持有他人记录 ID 时必须返回 404");
  const stolenCode = await errorCode(stolen);
  assert.equal(stolenCode, "NOT_FOUND");

  const missing = await handler(
    getRequest("https://app.example.com/api/analyses/does-not-exist", bob.cookie),
    { params: Promise.resolve({ id: "does-not-exist" }) },
  );
  assert.equal(missing.status, 404, "不存在的 ID 应与越权访问无法区分");
  assert.equal(await errorCode(missing), stolenCode);
});

test("the owner can still read their own analysis", async () => {
  const store = new MemoryAccountStore();
  const alice = await signUp(store, "reader@example.com");
  const analysisId = createId();
  await store.saveAnalysis(alice.userId, analysisOf(analysisId));
  const response = await createAnalysisDetailHandler({ store })(
    getRequest(`https://app.example.com/api/analyses/${analysisId}`, alice.cookie),
    { params: Promise.resolve({ id: analysisId }) },
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { analysis: { id: string; asin: string } };
  assert.equal(body.analysis.id, analysisId);
  assert.equal(body.analysis.asin, sampleProduct.asin);
});

test("a disabled account loses access through its existing cookie", async () => {
  const store = new MemoryAccountStore();
  const { cookie, userId } = await signUp(store, "banned@example.com");
  await store.setUserStatus(userId, "disabled");
  const response = await createMeHandler({ store })(getRequest("https://app.example.com/api/me", cookie));
  assert.equal(response.status, 401);
});

test("pagination parameters are validated", async () => {
  const store = new MemoryAccountStore();
  const { cookie } = await signUp(store, "page@example.com");
  const handler = createActivityHandler({ store });
  for (const query of ["limit=0", "limit=999", "limit=abc"]) {
    const response = await handler(getRequest(`https://app.example.com/api/history?${query}`, cookie));
    assert.equal(response.status, 400, query);
  }
  assert.equal((await handler(getRequest("https://app.example.com/api/history?limit=5", cookie))).status, 200);
});

test("account responses are never cached by shared caches", async () => {
  const store = new MemoryAccountStore();
  const { cookie } = await signUp(store, "cache@example.com");
  const response = await createMeHandler({ store })(getRequest("https://app.example.com/api/me", cookie));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("an oversized or malformed body is rejected", async () => {
  const store = new MemoryAccountStore();
  const handler = createRegisterHandler({ store });
  const huge = new Request("https://app.example.com/api/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: `{"email":"a@example.com","password":"${"x".repeat(5000)}"}`,
  });
  assert.equal((await handler(huge)).status, 413);
  const malformed = new Request("https://app.example.com/api/auth", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not json",
  });
  assert.equal((await handler(malformed)).status, 400);
  const wrongType = new Request("https://app.example.com/api/auth", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
  });
  assert.equal((await handler(wrongType)).status, 400);
});
