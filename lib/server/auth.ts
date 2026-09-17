import { AppError } from "../errors";
import { createToken, hashPassword, hashToken, ipPrefix, verifyPassword } from "../crypto";
import type { LoginInput, PublicUser, RegisterInput } from "../account-contracts";
import type { AccountStore, StoredUser } from "./store";

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 7;
/** Rejects further attempts for one identity after this many consecutive failures. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * A password verification is deliberately slow, so an unknown address must burn the same time as a
 * known one. Without this the response latency alone reveals which addresses are registered.
 *
 * The decoy is produced by the real hashing routine on first use, guaranteeing identical cost
 * parameters and digest length; a hand-written constant would verify faster and reintroduce the leak.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(createToken());
  return decoyHash;
}

export type AuthContext = { user: StoredUser; tokenHash: string };

export function publicUser(user: StoredUser): PublicUser {
  return { id: user.id, email: user.email, credits: user.credits, createdAt: user.createdAt };
}

/**
 * Counts recent failures per identity so credential stuffing becomes impractical.
 *
 * Keyed by email and by client network separately: keying only on email lets one attacker lock a
 * victim out, while keying only on network lets a botnet spread attempts across addresses.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();

  private recent(key: string, now: number): number[] {
    const times = (this.failures.get(key) ?? []).filter((time) => now - time < FAILURE_WINDOW_MS);
    if (times.length) this.failures.set(key, times); else this.failures.delete(key);
    return times;
  }

  check(keys: string[], now = Date.now()): void {
    if (keys.some((key) => this.recent(key, now).length >= MAX_FAILURES)) {
      throw new AppError("RATE_LIMITED", "登录失败次数过多，请稍后再试。", 429, true);
    }
  }

  recordFailure(keys: string[], now = Date.now()): void {
    for (const key of keys) this.failures.set(key, [...this.recent(key, now), now]);
  }

  clear(keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }
}

export type RequestContext = { userAgent: string | null; ip: string | null };

function throttleKeys(email: string, context: RequestContext): string[] {
  const network = ipPrefix(context.ip);
  return network ? [`email:${email}`, `net:${network}`] : [`email:${email}`];
}

/** Registers an account and applies its signup bonus atomically. */
export async function register(
  store: AccountStore, input: RegisterInput, bonus: number, context: RequestContext,
): Promise<{ user: StoredUser; token: string }> {
  const passwordHash = await hashPassword(input.password);
  const user = await store.createUser({ email: input.email, passwordHash, signupBonus: bonus });
  // A duplicate address is reported plainly: the address is already known to whoever owns it, and
  // registration cannot be silently skipped.
  if (!user) throw new AppError("EMAIL_TAKEN", "该邮箱已注册，请直接登录。", 409);
  await store.recordActivity(user.id, { action: "register", outcome: "success", creditsDelta: bonus });
  const token = await openSession(store, user.id, context);
  return { user, token };
}

/**
 * Verifies credentials. Every failure path returns the same message and spends comparable time, so
 * neither the wording nor the latency reveals whether an address exists.
 */
export async function login(
  store: AccountStore, input: LoginInput, context: RequestContext, throttle: LoginThrottle,
): Promise<{ user: StoredUser; token: string }> {
  const keys = throttleKeys(input.email, context);
  const now = store.now().getTime();
  throttle.check(keys, now);
  const user = await store.findUserByEmail(input.email);
  const matches = await verifyPassword(input.password, user?.passwordHash ?? await decoy());
  if (!user || !matches) {
    throttle.recordFailure(keys, now);
    if (user) await store.recordActivity(user.id, { action: "login_failed", outcome: "failed" });
    throw new AppError("INVALID_CREDENTIALS", "邮箱或密码不正确。", 401);
  }
  if (user.status !== "active") throw new AppError("ACCOUNT_DISABLED", "该账号已被停用，请联系维护者。", 403);
  throttle.clear(keys);
  await store.recordActivity(user.id, { action: "login", outcome: "success" });
  return { user, token: await openSession(store, user.id, context) };
}

async function openSession(store: AccountStore, userId: string, context: RequestContext): Promise<string> {
  const token = createToken();
  // Derived from the store's clock so the lifetime written here matches the one it later checks.
  const expiresAt = new Date(store.now().getTime() + SESSION_DAYS * 86_400_000);
  // Only the hash is stored, so a leaked database cannot be replayed as a valid login.
  await store.createSession(userId, hashToken(token), expiresAt, {
    userAgent: context.userAgent, ipPrefix: ipPrefix(context.ip),
  });
  return token;
}

export async function logout(store: AccountStore, token: string | null): Promise<void> {
  if (token) await store.deleteSession(hashToken(token));
}

/** Resolves the caller from a session token, or null when it is missing, expired or orphaned. */
export async function authenticate(store: AccountStore, token: string | null): Promise<AuthContext | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await store.findSession(tokenHash);
  if (!session) return null;
  const user = await store.findUserById(session.userId);
  if (!user) {
    // The account is gone but the session row survived; drop it rather than leaving it usable.
    await store.deleteSession(tokenHash);
    return null;
  }
  if (user.status !== "active") return null;
  return { user, tokenHash };
}

/** Same as {@link authenticate} but raises the error the API layer should return. */
export async function requireUser(store: AccountStore, token: string | null): Promise<AuthContext> {
  const context = await authenticate(store, token);
  if (!context) throw new AppError("UNAUTHENTICATED", "请先登录后再使用。", 401);
  return context;
}

/** Builds the Set-Cookie value. Secure is omitted on plain HTTP so local development still works. */
export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax",
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Reads one cookie without trusting the rest of the header to be well formed. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim() || null;
  }
  return null;
}
