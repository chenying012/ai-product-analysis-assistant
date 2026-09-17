import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { register } from "../lib/server/auth";
import { SqliteAccountStore } from "../lib/server/sqlite-store";
import { createId, type StoredAnalysis } from "../lib/server/store";
import { product as sampleProduct, validContent, validQuality } from "./fixtures";

const workspace = mkdtempSync(join(tmpdir(), "account-store-"));
const stores: SqliteAccountStore[] = [];
let counter = 0;

/** Each test gets its own database file so state never leaks between cases. */
function makeStore(clock?: () => Date): SqliteAccountStore {
  const store = new SqliteAccountStore(join(workspace, `t${counter++}.db`), clock);
  stores.push(store);
  return store;
}

after(() => {
  for (const store of stores) { try { store.close(); } catch { /* already closed */ } }
  rmSync(workspace, { recursive: true, force: true });
});

async function makeUser(store: SqliteAccountStore, email: string, bonus = 10) {
  const user = await store.createUser({ email, passwordHash: `hash-of-${email}`, signupBonus: bonus });
  assert.ok(user, "测试前置：用户应创建成功");
  return user;
}

function analysisOf(id: string, succeeded = true): StoredAnalysis {
  return {
    id, asin: sampleProduct.asin, marketplace: sampleProduct.marketplace, product: sampleProduct,
    content: succeeded ? validContent : null, quality: succeeded ? validQuality : null,
    createdAt: new Date().toISOString(),
  };
}

test("the schema is created on first use and reopening keeps the data", async () => {
  const file = join(workspace, "persist.db");
  const first = new SqliteAccountStore(file);
  const user = await first.createUser({ email: "keep@example.com", passwordHash: "h", signupBonus: 10 });
  assert.ok(user);
  first.close();
  // Durability across process restarts is the whole point of using a file.
  const second = new SqliteAccountStore(file);
  stores.push(second);
  const reloaded = await second.findUserByEmail("keep@example.com");
  assert.equal(reloaded?.id, user.id);
  assert.equal(reloaded?.credits, 10);
});

test("registration and its bonus are committed together", async () => {
  const store = makeStore();
  const user = await makeUser(store, "bonus@example.com");
  assert.equal(user.credits, 10);
  const ledger = await store.listCredits(user.id, { limit: 10 });
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].reason, "signup_bonus");
  assert.equal(ledger[0].delta, 10);
  assert.equal(ledger[0].balanceAfter, 10);
});

test("a duplicate email is refused, in any letter case", async () => {
  const store = makeStore();
  await makeUser(store, "dup@example.com");
  assert.equal(await store.createUser({ email: "dup@example.com", passwordHash: "x", signupBonus: 10 }), null);
  assert.equal(await store.createUser({ email: "DUP@Example.com", passwordHash: "x", signupBonus: 10 }), null);
  const ledger = await store.listCredits((await store.findUserByEmail("dup@example.com"))!.id, { limit: 10 });
  assert.equal(ledger.length, 1, "失败的注册不得留下积分流水");
});

test("spending decrements the balance and records the reference", async () => {
  const store = makeStore();
  const user = await makeUser(store, "spend@example.com", 3);
  assert.deepEqual(await store.spendCredit(user.id, "job-1"), { ok: true, balance: 2 });
  const [row] = await store.listCredits(user.id, { limit: 1 });
  assert.equal(row.reason, "api_call");
  assert.equal(row.refId, "job-1");
  assert.equal(row.balanceAfter, 2);
});

test("the balance never goes below zero", async () => {
  const store = makeStore();
  const user = await makeUser(store, "empty@example.com", 1);
  assert.deepEqual(await store.spendCredit(user.id, "a"), { ok: true, balance: 0 });
  assert.deepEqual(await store.spendCredit(user.id, "b"), { ok: false, balance: 0 });
  assert.equal((await store.findUserById(user.id))?.credits, 0);
});

test("charging the same reference twice bills once", async () => {
  const store = makeStore();
  const user = await makeUser(store, "retry@example.com", 5);
  await store.spendCredit(user.id, "same");
  assert.deepEqual(await store.spendCredit(user.id, "same"), { ok: true, balance: 4 });
  const charges = (await store.listCredits(user.id, { limit: 10 })).filter((row) => row.reason === "api_call");
  assert.equal(charges.length, 1, "唯一索引应阻止重复扣费");
});

test("concurrent charges cannot overdraw the account", async () => {
  const store = makeStore();
  const user = await makeUser(store, "race@example.com", 10);
  const results = await Promise.all(Array.from({ length: 25 }, (_v, index) => store.spendCredit(user.id, `r-${index}`)));
  assert.equal(results.filter((result) => result.ok).length, 10);
  assert.equal((await store.findUserById(user.id))?.credits, 0);
});

test("a refund is applied once and only for a real charge", async () => {
  const store = makeStore();
  const user = await makeUser(store, "refund@example.com", 4);
  await store.spendCredit(user.id, "job");
  assert.deepEqual(await store.refundCredit(user.id, "job"), { refunded: true, balance: 4 });
  assert.deepEqual(await store.refundCredit(user.id, "job"), { refunded: false, balance: 4 });
  assert.deepEqual(await store.refundCredit(user.id, "never"), { refunded: false, balance: 4 });
  assert.equal((await store.listCredits(user.id, { limit: 10 })).filter((row) => row.reason === "refund").length, 1);
});

test("the balance always equals the sum of the ledger", async () => {
  const store = makeStore();
  const user = await makeUser(store, "audit@example.com", 10);
  await store.spendCredit(user.id, "x1");
  await store.spendCredit(user.id, "x2");
  await store.refundCredit(user.id, "x2");
  await store.grantCredits(user.id, 5, "admin_adjust");
  const total = (await store.listCredits(user.id, { limit: 50 })).reduce((sum, row) => sum + row.delta, 0);
  assert.equal(total, (await store.findUserById(user.id))?.credits);
  assert.equal(total, 14);
});

test("operations on an unknown account change nothing", async () => {
  const store = makeStore();
  assert.deepEqual(await store.spendCredit("ghost", "r"), { ok: false, balance: 0 });
  assert.deepEqual(await store.refundCredit("ghost", "r"), { refunded: false, balance: 0 });
  assert.equal(await store.grantCredits("ghost", 5, "admin_adjust"), 0);
});

test("sessions expire and can be revoked", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const store = makeStore(() => clock);
  const user = await makeUser(store, "session@example.com");
  await store.createSession(user.id, "hash-a", new Date("2026-01-08T00:00:00Z"), { userAgent: "agent", ipPrefix: "203.0.113.0/24" });
  assert.equal((await store.findSession("hash-a"))?.userId, user.id);
  clock = new Date("2026-01-09T00:00:00Z");
  assert.equal(await store.findSession("hash-a"), null, "过期会话必须失效");
});

test("bulk revocation leaves other accounts untouched", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "alice-s@example.com");
  const bob = await makeUser(store, "bob-s@example.com");
  const future = new Date(Date.now() + 86_400_000);
  await store.createSession(alice.id, "a-token", future, { userAgent: null, ipPrefix: null });
  await store.createSession(bob.id, "b-token", future, { userAgent: null, ipPrefix: null });
  await store.deleteUserSessions(alice.id);
  assert.equal(await store.findSession("a-token"), null);
  assert.equal((await store.findSession("b-token"))?.userId, bob.id);
});

test("a real registration through the auth layer works end to end", async () => {
  const store = makeStore();
  const { user, token } = await register(
    store, { email: "flow@example.com", password: "a-long-enough-password" }, 10,
    { userAgent: "test", ip: "203.0.113.9" },
  );
  assert.equal(user.credits, 10);
  const session = await store.findSession(
    (await import("../lib/crypto")).hashToken(token),
  );
  assert.equal(session?.userId, user.id);
  assert.equal((await store.listActivity(user.id, { limit: 5 })).at(-1)?.action, "register");
});

test("analyses round-trip through JSON without losing fields", async () => {
  const store = makeStore();
  const user = await makeUser(store, "json@example.com");
  const id = createId();
  await store.saveAnalysis(user.id, analysisOf(id));
  const loaded = await store.findAnalysis(user.id, id);
  assert.ok(loaded);
  assert.equal(loaded.product.title, sampleProduct.title);
  assert.deepEqual(loaded.product.evidence, sampleProduct.evidence, "证据列表必须完整保留");
  assert.equal(loaded.content?.script.hook, validContent.script.hook);
  assert.equal(loaded.quality?.passed, validQuality.passed);
});

test("a failed analysis is stored without content", async () => {
  const store = makeStore();
  const user = await makeUser(store, "failed@example.com");
  const id = createId();
  await store.saveAnalysis(user.id, analysisOf(id, false));
  const [summary] = await store.listAnalyses(user.id, { limit: 5 });
  assert.equal(summary.succeeded, false);
  assert.equal((await store.findAnalysis(user.id, id))?.content, null);
});

test("listings are newest first and paginate without repeats", async () => {
  const store = makeStore();
  const user = await makeUser(store, "page@example.com", 0);
  for (let index = 0; index < 7; index++) {
    await store.recordActivity(user.id, { action: "login", outcome: "success" });
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let round = 0; round < 5; round++) {
    const rows = await store.listActivity(user.id, { limit: 3, before: cursor });
    if (!rows.length) break;
    seen.push(...rows.map((row) => row.id));
    cursor = rows.at(-1)?.id;
  }
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual([...seen].sort().reverse(), seen, "必须按时间倒序返回");
});

test("one account cannot read another's records", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "owner-x@example.com");
  const bob = await makeUser(store, "other-x@example.com");
  const id = createId();
  await store.saveAnalysis(alice.id, analysisOf(id));
  await store.recordActivity(alice.id, { action: "analyze", outcome: "success", target: "ALICE-ONLY" });
  await store.spendCredit(alice.id, "alice-job");

  assert.equal(await store.findAnalysis(bob.id, id), null, "持有正确 ID 也不得读到他人记录");
  assert.ok(await store.findAnalysis(alice.id, id));
  assert.deepEqual(await store.listAnalyses(bob.id, { limit: 50 }), []);
  assert.deepEqual(await store.listActivity(bob.id, { limit: 50 }), []);
  assert.equal((await store.listCredits(bob.id, { limit: 50 })).filter((row) => row.reason === "api_call").length, 0);
});

test("one account cannot refund another's charge", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "victim@example.com", 5);
  const bob = await makeUser(store, "attacker@example.com", 5);
  await store.spendCredit(alice.id, "shared");
  assert.deepEqual(await store.refundCredit(bob.id, "shared"), { refunded: false, balance: 5 });
  assert.equal((await store.findUserById(alice.id))?.credits, 4);
});

test("the same reference in different accounts is independent", async () => {
  const store = makeStore();
  const alice = await makeUser(store, "one-r@example.com", 1);
  const bob = await makeUser(store, "two-r@example.com", 1);
  assert.equal((await store.spendCredit(alice.id, "job")).ok, true);
  assert.equal((await store.spendCredit(bob.id, "job")).ok, true);
  assert.equal((await store.findUserById(alice.id))?.credits, 0);
  assert.equal((await store.findUserById(bob.id))?.credits, 0);
});

test("deleting an account removes everything it owned", async () => {
  const store = makeStore();
  const user = await makeUser(store, "cascade@example.com");
  await store.saveAnalysis(user.id, analysisOf(createId()));
  await store.recordActivity(user.id, { action: "login", outcome: "success" });
  await store.createSession(user.id, "c-token", new Date(Date.now() + 86_400_000), { userAgent: null, ipPrefix: null });
  // Cascading deletes are what make account removal actually erase the person's data.
  await store.deleteUser(user.id);
  assert.equal(await store.findUserById(user.id), null);
  assert.deepEqual(await store.listAnalyses(user.id, { limit: 10 }), []);
  assert.deepEqual(await store.listActivity(user.id, { limit: 10 }), []);
  assert.deepEqual(await store.listCredits(user.id, { limit: 10 }), []);
  assert.equal(await store.findSession("c-token"), null);
});

test("a disabled status survives a reload", async () => {
  const file = join(workspace, "status.db");
  const first = new SqliteAccountStore(file);
  const user = await first.createUser({ email: "status@example.com", passwordHash: "h", signupBonus: 10 });
  assert.ok(user);
  await first.setUserStatus(user.id, "disabled");
  first.close();
  const second = new SqliteAccountStore(file);
  stores.push(second);
  assert.equal((await second.findUserById(user.id))?.status, "disabled");
});
