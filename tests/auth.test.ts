import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../lib/errors";
import { hashToken } from "../lib/crypto";
import {
  authenticate, clearedCookie, login, LoginThrottle, logout, publicUser, readCookie,
  register, requireUser, sessionCookie, SESSION_COOKIE,
} from "../lib/server/auth";
import { MemoryAccountStore } from "../lib/server/store";

const context = { userAgent: "test-agent", ip: "203.0.113.10" };
const credentials = { email: "user@example.com", password: "a-long-enough-password" };

function setup() {
  return { store: new MemoryAccountStore(), throttle: new LoginThrottle() };
}

async function codeOf(action: Promise<unknown>): Promise<string> {
  try { await action; return "no-error"; } catch (error) {
    return error instanceof AppError ? error.code : `unexpected:${String(error)}`;
  }
}

test("registration creates an account, grants the bonus and opens a session", async () => {
  const { store } = setup();
  const { user, token } = await register(store, credentials, 10, context);
  assert.equal(user.email, credentials.email);
  assert.equal(user.credits, 10);
  assert.ok(token);
  assert.equal((await authenticate(store, token))?.user.id, user.id);
  const activity = await store.listActivity(user.id, { limit: 5 });
  assert.equal(activity.at(-1)?.action, "register");
  assert.equal(activity.at(-1)?.creditsDelta, 10);
});

test("the stored record never contains the password", async () => {
  const { store } = setup();
  const { user } = await register(store, credentials, 10, context);
  const stored = await store.findUserById(user.id);
  assert.ok(stored);
  assert.ok(!JSON.stringify(stored).includes(credentials.password));
  assert.match(stored.passwordHash, /^scrypt\$/);
});

test("a duplicate registration is refused", async () => {
  const { store } = setup();
  await register(store, credentials, 10, context);
  assert.equal(await codeOf(register(store, credentials, 10, context)), "EMAIL_TAKEN");
});

test("registering the same address in different letter case is refused", async () => {
  const { store } = setup();
  await register(store, credentials, 10, context);
  assert.equal(
    await codeOf(register(store, { ...credentials, email: "USER@example.com" }, 10, context)),
    "EMAIL_TAKEN",
  );
});

test("login succeeds with the right password and issues a new session", async () => {
  const { store, throttle } = setup();
  const registered = await register(store, credentials, 10, context);
  const signedIn = await login(store, credentials, context, throttle);
  assert.equal(signedIn.user.id, registered.user.id);
  assert.notEqual(signedIn.token, registered.token, "每次登录应签发独立令牌");
  // Both sessions stay valid, so signing in on a second device does not evict the first.
  assert.ok(await authenticate(store, registered.token));
  assert.ok(await authenticate(store, signedIn.token));
});

test("a wrong password and an unknown address fail identically", async () => {
  const { store, throttle } = setup();
  await register(store, credentials, 10, context);
  let wrongPassword = "";
  let unknownEmail = "";
  try { await login(store, { ...credentials, password: "wrong-password-here" }, context, throttle); }
  catch (error) { wrongPassword = (error as AppError).message; }
  try { await login(store, { email: "nobody@example.com", password: "wrong-password-here" }, context, new LoginThrottle()); }
  catch (error) { unknownEmail = (error as AppError).message; }
  assert.equal(wrongPassword, unknownEmail, "两种失败的提示必须一致，否则可用于枚举已注册邮箱");
  assert.equal(wrongPassword, "邮箱或密码不正确。");
});

test("an unknown address costs comparable time to a known one", async () => {
  const { store } = setup();
  await register(store, credentials, 10, context);
  const measure = async (email: string) => {
    const started = process.hrtime.bigint();
    await login(store, { email, password: "definitely-wrong" }, context, new LoginThrottle()).catch(() => undefined);
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const known = await measure(credentials.email);
  const unknown = await measure("nobody@example.com");
  // A missing decoy would make the unknown path return almost instantly.
  assert.ok(unknown > known * 0.5, `未注册邮箱耗时 ${unknown.toFixed(1)}ms 不应远快于已注册 ${known.toFixed(1)}ms`);
});

test("repeated failures are blocked and a success clears the counter", async () => {
  const { store, throttle } = setup();
  await register(store, credentials, 10, context);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal(await codeOf(login(store, { ...credentials, password: "bad-password-x" }, context, throttle)), "INVALID_CREDENTIALS");
  }
  assert.equal(await codeOf(login(store, { ...credentials, password: "bad-password-x" }, context, throttle)), "RATE_LIMITED");
  // Even the correct password stays blocked while the window is open.
  assert.equal(await codeOf(login(store, credentials, context, throttle)), "RATE_LIMITED");
});

test("the failure window expires", () => {
  const throttle = new LoginThrottle();
  const start = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) throttle.recordFailure(["email:a@example.com"], start);
  assert.throws(() => throttle.check(["email:a@example.com"], start + 60_000), /登录失败次数过多/);
  throttle.check(["email:a@example.com"], start + 16 * 60_000);
});

test("a successful login clears the accumulated failures", async () => {
  const { store, throttle } = setup();
  await register(store, credentials, 10, context);
  for (let attempt = 0; attempt < 4; attempt++) {
    await login(store, { ...credentials, password: "bad-password-x" }, context, throttle).catch(() => undefined);
  }
  await login(store, credentials, context, throttle);
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal(await codeOf(login(store, { ...credentials, password: "bad-password-x" }, context, throttle)), "INVALID_CREDENTIALS");
  }
});

test("failed logins are recorded for the account owner to review", async () => {
  const { store, throttle } = setup();
  const { user } = await register(store, credentials, 10, context);
  await login(store, { ...credentials, password: "bad-password-x" }, context, throttle).catch(() => undefined);
  const rows = await store.listActivity(user.id, { limit: 5 });
  assert.equal(rows[0].action, "login_failed");
  assert.equal(rows[0].outcome, "failed");
});

test("a disabled account cannot sign in", async () => {
  const { store, throttle } = setup();
  const { user } = await register(store, credentials, 10, context);
  await store.setUserStatus(user.id, "disabled");
  assert.equal(await codeOf(login(store, credentials, context, throttle)), "ACCOUNT_DISABLED");
});

test("disabling an account also stops its existing sessions", async () => {
  const { store } = setup();
  const { user, token } = await register(store, credentials, 10, context);
  assert.ok(await authenticate(store, token));
  await store.setUserStatus(user.id, "disabled");
  assert.equal(await authenticate(store, token), null, "停用后既有会话必须立即失效");
  assert.equal(await codeOf(requireUser(store, token)), "UNAUTHENTICATED");
});

test("re-enabling an account restores access", async () => {
  const { store, throttle } = setup();
  const { user } = await register(store, credentials, 10, context);
  await store.setUserStatus(user.id, "disabled");
  await store.setUserStatus(user.id, "active");
  assert.ok((await login(store, credentials, context, throttle)).token);
});

test("logout invalidates only that session", async () => {
  const { store, throttle } = setup();
  await register(store, credentials, 10, context);
  const first = await login(store, credentials, context, throttle);
  const second = await login(store, credentials, context, throttle);
  await logout(store, first.token);
  assert.equal(await authenticate(store, first.token), null);
  assert.ok(await authenticate(store, second.token), "登出不应影响其他设备的会话");
});

test("logout tolerates a missing token", async () => {
  const { store } = setup();
  await logout(store, null);
});

test("an invalid, expired or orphaned token authenticates nobody", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const store = new MemoryAccountStore(() => clock);
  const { user, token } = await register(store, credentials, 10, context);
  assert.equal(await authenticate(store, null), null);
  assert.equal(await authenticate(store, "not-a-real-token"), null);
  assert.ok(await authenticate(store, token));
  clock = new Date("2026-02-01T00:00:00Z");
  assert.equal(await authenticate(store, token), null, "过期会话必须失效");
  // A session row whose account vanished must not resolve either.
  clock = new Date("2026-01-01T00:00:00Z");
  const fresh = await login(store, credentials, context, new LoginThrottle());
  await store.deleteUserSessions(user.id);
  assert.equal(await authenticate(store, fresh.token), null);
});

test("requireUser raises an authentication error instead of returning null", async () => {
  const { store } = setup();
  assert.equal(await codeOf(requireUser(store, null)), "UNAUTHENTICATED");
  const { token } = await register(store, credentials, 10, context);
  assert.ok((await requireUser(store, token)).user);
});

test("only the token hash reaches storage", async () => {
  const { store } = setup();
  const { token } = await register(store, credentials, 10, context);
  assert.ok(await store.findSession(hashToken(token)), "应能通过哈希查到会话");
  assert.equal(await store.findSession(token), null, "原始令牌不应作为主键存在");
});

test("the public view of a user omits the password hash", async () => {
  const { store } = setup();
  const { user } = await register(store, credentials, 10, context);
  const view = publicUser(user);
  assert.deepEqual(Object.keys(view).sort(), ["createdAt", "credits", "email", "id"]);
  assert.ok(!JSON.stringify(view).includes("scrypt"));
});

test("the session cookie is protected against scripts and cross-site use", () => {
  const cookie = sessionCookie("abc123", true);
  assert.match(cookie, /^session=abc123;/);
  for (const flag of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]) {
    assert.ok(cookie.includes(flag), `缺少 ${flag}`);
  }
});

test("the Secure flag is omitted on plain http so local development works", () => {
  assert.ok(!sessionCookie("abc123", false).includes("Secure"));
  assert.ok(sessionCookie("abc123", false).includes("HttpOnly"));
});

test("clearing the cookie expires it immediately", () => {
  assert.match(clearedCookie(true), /Max-Age=0/);
  assert.match(clearedCookie(true), /^session=;/);
});

test("cookie parsing handles absent, malformed and multi-value headers", () => {
  assert.equal(readCookie(null, SESSION_COOKIE), null);
  assert.equal(readCookie("", SESSION_COOKIE), null);
  assert.equal(readCookie("other=1", SESSION_COOKIE), null);
  assert.equal(readCookie("session=abc", SESSION_COOKIE), "abc");
  assert.equal(readCookie("a=1; session=abc; b=2", SESSION_COOKIE), "abc");
  assert.equal(readCookie("  session = spaced  ", SESSION_COOKIE), "spaced");
  assert.equal(readCookie("session=", SESSION_COOKIE), null);
  assert.equal(readCookie("malformed; session=abc", SESSION_COOKIE), "abc");
  assert.equal(readCookie("sessionx=abc", SESSION_COOKIE), null, "不应匹配前缀相同的其他 Cookie");
});
