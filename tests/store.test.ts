import assert from "node:assert/strict";
import { test } from "node:test";
import type { Content, Product, Quality } from "../lib/contracts";
import { createId, MemoryAccountStore, type StoredAnalysis } from "../lib/server/store";

function makeStore(): MemoryAccountStore {
  return new MemoryAccountStore();
}

async function makeUser(store: MemoryAccountStore, email: string, bonus = 10) {
  const user = await store.createUser({ email, passwordHash: `hash-of-${email}`, signupBonus: bonus });
  assert.ok(user, "测试前置：用户应创建成功");
  return user;
}

const product = { title: "Test Product", asin: "B000000001" } as unknown as Product;

function makeAnalysis(id: string, succeeded = true): StoredAnalysis {
  return {
    id, asin: "B000000001", marketplace: "amazon.com", product,
    content: succeeded ? ({ script: { hook: "钩子", body: "正文" } } as unknown as Content) : null,
    quality: succeeded ? ({ passed: true } as unknown as Quality) : null,
    createdAt: new Date().toISOString(),
  };
}

test("identifiers sort in creation order even within one millisecond", () => {
  const ids = Array.from({ length: 100 }, () => createId(1_700_000_000_000));
  assert.deepEqual([...ids].sort(), ids, "同毫秒内生成的 id 必须严格递增，否则游标分页会漏记录");
  assert.equal(new Set(ids).size, ids.length);
});

test("identifiers from later timestamps sort after earlier ones", () => {
  const early = createId(1_700_000_000_000);
  const late = createId(1_700_000_000_001);
  assert.ok(late > early);
});

test("registration applies the signup bonus and records it in the ledger", async () => {
  const store = makeStore();
  const user = await makeUser(store, "new@example.com");
  assert.equal(user.credits, 10);
  const ledger = await store.listCredits(user.id, { limit: 10 });
  assert.equal(ledger.length, 1);
  assert.deepEqual(
    { delta: ledger[0].delta, balanceAfter: ledger[0].balanceAfter, reason: ledger[0].reason },
    { delta: 10, balanceAfter: 10, reason: "signup_bonus" },
  );
});

test("a duplicate email is rejected without creating a second account", async () => {
  const store = makeStore();
  await makeUser(store, "taken@example.com");
  assert.equal(await store.createUser({ email: "taken@example.com", passwordHash: "other", signupBonus: 10 }), null);
  assert.equal(await store.createUser({ email: "TAKEN@example.com", passwordHash: "other", signupBonus: 10 }), null, "邮箱比较必须忽略大小写");
});

test("email lookup is case-insensitive", async () => {
  const store = makeStore();
  const user = await makeUser(store, "Mixed@Example.com");
  assert.equal((await store.findUserByEmail("mixed@example.com"))?.id, user.id);
  assert.equal((await store.findUserByEmail("MIXED@EXAMPLE.COM"))?.id, user.id);
});

test("spending reduces the balance and writes one ledger row", async () => {
  const store = makeStore();
  const user = await makeUser(store, "spender@example.com", 2);
  const first = await store.spendCredit(user.id, "analysis-1");
  assert.deepEqual(first, { ok: true, balance: 1 });
  assert.equal((await store.findUserById(user.id))?.credits, 1);
  const rows = await store.listCredits(user.id, { limit: 10 });
  assert.equal(rows[0].reason, "api_call");
  assert.equal(rows[0].delta, -1);
  assert.equal(rows[0].refId, "analysis-1");
});

test("spending is rejected once the balance is exhausted", async () => {
  const store = makeStore();
  const user = await makeUser(store, "broke@example.com", 1);
  assert.deepEqual(await store.spendCredit(user.id, "a"), { ok: true, balance: 0 });
  assert.deepEqual(await store.spendCredit(user.id, "b"), { ok: false, balance: 0 });
  assert.equal((await store.findUserById(user.id))?.credits, 0, "余额不得变成负数");
});

test("charging the same reference twice does not bill twice", async () => {
  const store = makeStore();
  const user = await makeUser(store, "retry@example.com", 5);
  await store.spendCredit(user.id, "same-ref");
  const repeat = await store.spendCredit(user.id, "same-ref");
  assert.deepEqual(repeat, { ok: true, balance: 4 }, "重试同一请求不应重复扣费");
  assert.equal((await store.listCredits(user.id, { limit: 10 })).filter((row) => row.reason === "api_call").length, 1);
});

test("concurrent spending never exceeds the available balance", async () => {
  const store = makeStore();
  const user = await makeUser(store, "race@example.com", 10);
  const results = await Promise.all(Array.from({ length: 25 }, (_unused, index) => store.spendCredit(user.id, `ref-${index}`)));
  assert.equal(results.filter((result) => result.ok).length, 10, "余额 10 时只应有 10 次成功");
  assert.equal((await store.findUserById(user.id))?.credits, 0);
});

test("a refund restores exactly one credit and is idempotent", async () => {
  const store = makeStore();
  const user = await makeUser(store, "refund@example.com", 3);
  await store.spendCredit(user.id, "job-1");
  assert.deepEqual(await store.refundCredit(user.id, "job-1"), { refunded: true, balance: 3 });
  assert.deepEqual(await store.refundCredit(user.id, "job-1"), { refunded: false, balance: 3 }, "重复退款不得增加余额");
  assert.equal((await store.listCredits(user.id, { limit: 10 })).filter((row) => row.reason === "refund").length, 1);
});

test("a refund without a matching charge is refused", async () => {
  const store = makeStore();
  const user = await makeUser(store, "nocharge@example.com", 4);
  assert.deepEqual(await store.refundCredit(user.id, "never-charged"), { refunded: false, balance: 4 });
});

test("the balance always equals the sum of its ledger", async () => {
  const store = makeStore();
  const user = await makeUser(store, "audit@example.com", 10);
  await store.spendCredit(user.id, "x1");
  await store.spendCredit(user.id, "x2");
  await store.refundCredit(user.id, "x2");
  await store.grantCredits(user.id, 5, "admin_adjust");
  const rows = await store.listCredits(user.id, { limit: 50 });
  const total = rows.reduce((sum, row) => sum + row.delta, 0);
  assert.equal(total, (await store.findUserById(user.id))?.credits);
  assert.equal(total, 14);
});

test("operations on an unknown user do not create records", async () => {
  const store = makeStore();
  assert.deepEqual(await store.spendCredit("ghost", "ref"), { ok: false, balance: 0 });
  assert.deepEqual(await store.refundCredit("ghost", "ref"), { refunded: false, balance: 0 });
  assert.equal(await store.grantCredits("ghost", 5, "admin_adjust"), 0);
});

test("a session is found before expiry and rejected afterwards", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const store = new MemoryAccountStore(() => clock);
  const user = await makeUser(store, "session@example.com");
  await store.createSession(user.id, "hash-1", new Date("2026-01-08T00:00:00Z"), { userAgent: null, ipPrefix: null });
  assert.equal((await store.findSession("hash-1"))?.userId, user.id);
  clock = new Date("2026-01-09T00:00:00Z");
  assert.equal(await store.findSession("hash-1"), null, "过期会话必须失效");
});

test("sessions can be revoked individually and in bulk", async () => {
  const store = makeStore();
  const user = await makeUser(store, "revoke@example.com");
  const future = new Date(Date.now() + 86_400_000);
  await store.createSession(user.id, "h1", future, { userAgent: null, ipPrefix: null });
  await store.createSession(user.id, "h2", future, { userAgent: null, ipPrefix: null });
  await store.deleteSession("h1");
  assert.equal(await store.findSession("h1"), null);
  assert.ok(await store.findSession("h2"));
  await store.deleteUserSessions(user.id);
  assert.equal(await store.findSession("h2"), null, "批量吊销必须清掉该用户全部会话");
});

test("bulk revocation leaves other accounts signed in", async () => {
  const store = makeStore();
  const [alice, bob] = [await makeUser(store, "a@example.com"), await makeUser(store, "b@example.com")];
  const future = new Date(Date.now() + 86_400_000);
  await store.createSession(alice.id, "alice-token", future, { userAgent: null, ipPrefix: null });
  await store.createSession(bob.id, "bob-token", future, { userAgent: null, ipPrefix: null });
  await store.deleteUserSessions(alice.id);
  assert.equal(await store.findSession("alice-token"), null);
  assert.equal((await store.findSession("bob-token"))?.userId, bob.id, "不得影响其他用户的会话");
});

test("activity is recorded and returned newest first", async () => {
  const store = makeStore();
  const user = await makeUser(store, "log@example.com");
  await store.recordActivity(user.id, { action: "login", outcome: "success" });
  await store.recordActivity(user.id, { action: "analyze", outcome: "failed", target: "B000000001", errorCode: "SOURCE_BLOCKED", creditsDelta: -1 });
  const rows = await store.listActivity(user.id, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, "analyze");
  assert.equal(rows[0].errorCode, "SOURCE_BLOCKED");
  assert.equal(rows[0].creditsDelta, -1);
  assert.equal(rows[1].action, "login");
});

test("analyses are listed newest first with a success flag", async () => {
  const store = makeStore();
  const user = await makeUser(store, "analyses@example.com");
  await store.saveAnalysis(user.id, makeAnalysis(createId(1_700_000_000_000), true));
  await store.saveAnalysis(user.id, makeAnalysis(createId(1_700_000_000_001), false));
  const rows = await store.listAnalyses(user.id, { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].succeeded, false, "最新一条应排在最前");
  assert.equal(rows[1].succeeded, true);
  assert.equal(rows[0].title, "Test Product");
});

test("cursor pagination walks the whole list without repeats or gaps", async () => {
  const store = makeStore();
  const user = await makeUser(store, "page@example.com", 0);
  for (let index = 0; index < 7; index++) await store.recordActivity(user.id, { action: "login", outcome: "success" });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 5; round++) {
    const rows = await store.listActivity(user.id, { limit: 3, before: cursor });
    if (!rows.length) break;
    seen.push(...rows.map((row) => row.id));
    cursor = rows[rows.length - 1].id;
  }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7, "分页不得重复返回同一条记录");
});

test("an unknown cursor returns nothing instead of restarting", async () => {
  const store = makeStore();
  const user = await makeUser(store, "cursor@example.com", 0);
  await store.recordActivity(user.id, { action: "login", outcome: "success" });
  assert.deepEqual(await store.listActivity(user.id, { limit: 10, before: "does-not-exist" }), []);
});

test("one account never sees another account's records", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "alice@example.com");
  const bob = await makeUser(store, "bob@example.com");
  const analysisId = createId();
  await store.saveAnalysis(alice.id, makeAnalysis(analysisId));
  await store.recordActivity(alice.id, { action: "analyze", outcome: "success", target: "SECRET" });
  await store.spendCredit(alice.id, "alice-job");

  assert.deepEqual(await store.listAnalyses(bob.id, { limit: 50 }), []);
  assert.deepEqual(await store.listActivity(bob.id, { limit: 50 }), []);
  assert.equal((await store.listCredits(bob.id, { limit: 50 })).filter((row) => row.reason === "api_call").length, 0);
  assert.equal(
    await store.findAnalysis(bob.id, analysisId), null,
    "即使持有正确的记录 ID，其他用户也必须查不到",
  );
  assert.ok(await store.findAnalysis(alice.id, analysisId), "所有者本人仍应查得到");
});

test("one account cannot refund a charge belonging to another", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "owner@example.com", 5);
  const bob = await makeUser(store, "thief@example.com", 5);
  await store.spendCredit(alice.id, "shared-ref");
  assert.deepEqual(await store.refundCredit(bob.id, "shared-ref"), { refunded: false, balance: 5 }, "不得退还他人的扣费");
  assert.equal((await store.findUserById(alice.id))?.credits, 4);
});

test("spending is tracked per account", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "one@example.com", 1);
  const bob = await makeUser(store, "two@example.com", 1);
  assert.equal((await store.spendCredit(alice.id, "job")).ok, true);
  assert.equal((await store.spendCredit(bob.id, "job")).ok, true, "同名引用在不同账户下互不影响");
  assert.equal((await store.findUserById(alice.id))?.credits, 0);
  assert.equal((await store.findUserById(bob.id))?.credits, 0);
});
