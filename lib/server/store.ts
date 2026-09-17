import { randomBytes } from "node:crypto";
import type { Content, Product, Quality } from "../contracts";
import type {
  ActivityAction, ActivityOutcome, ActivityRecord, AnalysisSummary, CreditReason, CreditRecord,
} from "../account-contracts";

export type StoredUser = {
  id: string;
  email: string;
  passwordHash: string;
  credits: number;
  status: "active" | "disabled";
  createdAt: string;
};

export type StoredAnalysis = {
  id: string;
  asin: string;
  marketplace: string;
  product: Product;
  content: Content | null;
  quality: Quality | null;
  createdAt: string;
};

export type SessionRecord = { userId: string; expiresAt: string };

export type ActivityInput = {
  action: ActivityAction;
  outcome: ActivityOutcome;
  target?: string | null;
  errorCode?: string | null;
  creditsDelta?: number;
};

export type Page = { limit: number; before?: string };

/**
 * Persistence boundary for every account-scoped record.
 *
 * Two rules are enforced by the signatures themselves:
 *  1. Any method touching user-owned data takes `userId` first, so a caller cannot forget to scope a
 *     query and accidentally expose another account's rows.
 *  2. Operations that must not be observable half-finished (registration bonus, spending, refunds)
 *     are single methods rather than composable primitives, letting each implementation apply its own
 *     atomicity mechanism — a transaction in SQL, a synchronous block in memory.
 */
export interface AccountStore {
  /** Creates the account and applies its signup bonus as one indivisible step. Returns null when the
   * address is already taken, so the caller never has to pre-check and race. */
  createUser(input: { email: string; passwordHash: string; signupBonus: number }): Promise<StoredUser | null>;
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(userId: string): Promise<StoredUser | null>;
  /** Enables or disables an account. Disabling also has to invalidate its sessions, which the caller
   * does explicitly so the intent stays visible at the call site. */
  setUserStatus(userId: string, status: StoredUser["status"]): Promise<void>;

  /** The store's clock. Session lifetimes are derived from it so issuing and expiry always agree,
   * even when a test or a replica runs on a different notion of "now". */
  now(): Date;

  createSession(userId: string, tokenHash: string, expiresAt: Date, context: { userAgent: string | null; ipPrefix: string | null }): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Invalidates every session of one account, used on password change or lockout. */
  deleteUserSessions(userId: string): Promise<void>;

  /** Atomically removes one credit. Returns `ok: false` with the unchanged balance when the account
   * cannot afford it, so the caller never needs a separate read-then-write. */
  spendCredit(userId: string, refId: string): Promise<{ ok: boolean; balance: number }>;
  /** Returns a previously spent credit. Idempotent: repeating it for the same reference is a no-op,
   * so a retry cannot mint credits. */
  refundCredit(userId: string, refId: string): Promise<{ refunded: boolean; balance: number }>;
  grantCredits(userId: string, amount: number, reason: CreditReason): Promise<number>;
  listCredits(userId: string, page: Page): Promise<CreditRecord[]>;

  recordActivity(userId: string, input: ActivityInput): Promise<void>;
  listActivity(userId: string, page: Page): Promise<ActivityRecord[]>;

  saveAnalysis(userId: string, analysis: StoredAnalysis): Promise<void>;
  listAnalyses(userId: string, page: Page): Promise<AnalysisSummary[]>;
  /** Reads one analysis. The owner is part of the lookup, so a valid id belonging to someone else is
   * indistinguishable from a missing record. */
  findAnalysis(userId: string, analysisId: string): Promise<StoredAnalysis | null>;
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
let lastStamp = 0;
let sequence = 0;

/**
 * Generates a lexicographically sortable identifier: a millisecond timestamp, a per-millisecond
 * counter, then randomness. Sorting by id therefore matches creation order even for records written
 * within the same millisecond, which keeps cursor pagination correct, while the random tail stops the
 * value from being a guessable sequence number.
 */
export function createId(now = Date.now(), random = randomBytes): string {
  if (now === lastStamp) sequence += 1; else { lastStamp = now; sequence = 0; }
  const time = now.toString(36).padStart(9, "0");
  const seq = sequence.toString(36).padStart(4, "0");
  const suffix = Array.from(random(8), (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join("");
  return `${time}${seq}${suffix}`;
}

/** Applies cursor pagination to records already sorted newest-first. */
function paginate<T extends { id: string }>(records: T[], page: Page): T[] {
  if (!page.before) return records.slice(0, page.limit);
  const index = records.findIndex((record) => record.id === page.before);
  // An unknown cursor returns nothing rather than silently restarting from the top, which would make
  // a client loop forever over the first page.
  if (index < 0) return [];
  return records.slice(index + 1, index + 1 + page.limit);
}

/**
 * In-memory implementation used by tests and by local runs without a database.
 *
 * JavaScript executes each method body without interleaving, so grouping a read and its dependent
 * write inside one synchronous block gives the same all-or-nothing guarantee a transaction provides
 * in SQL. Data is intentionally lost on restart; this is not a durable store.
 */
export class MemoryAccountStore implements AccountStore {
  private users = new Map<string, StoredUser>();
  private emails = new Map<string, string>();
  private sessions = new Map<string, SessionRecord & { userAgent: string | null; ipPrefix: string | null }>();
  private credits: (CreditRecord & { userId: string })[] = [];
  private activity: (ActivityRecord & { userId: string })[] = [];
  private analyses = new Map<string, StoredAnalysis & { userId: string }>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  now(): Date { return this.clock(); }

  private timestamp(): string { return this.now().toISOString(); }

  async createUser(input: { email: string; passwordHash: string; signupBonus: number }): Promise<StoredUser | null> {
    const email = input.email.toLowerCase();
    if (this.emails.has(email)) return null;
    const user: StoredUser = {
      id: createId(this.now().getTime()),
      email,
      passwordHash: input.passwordHash,
      credits: 0,
      status: "active",
      createdAt: this.timestamp(),
    };
    this.users.set(user.id, user);
    this.emails.set(email, user.id);
    if (input.signupBonus > 0) {
      user.credits = input.signupBonus;
      this.credits.unshift({
        id: createId(this.now().getTime()), userId: user.id, delta: input.signupBonus,
        balanceAfter: user.credits, reason: "signup_bonus", refId: null, createdAt: this.timestamp(),
      });
    }
    return { ...user };
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const id = this.emails.get(email.toLowerCase());
    const user = id ? this.users.get(id) : undefined;
    return user ? { ...user } : null;
  }

  async findUserById(userId: string): Promise<StoredUser | null> {
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  async setUserStatus(userId: string, status: StoredUser["status"]): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.status = status;
  }

  async createSession(
    userId: string, tokenHash: string, expiresAt: Date,
    context: { userAgent: string | null; ipPrefix: string | null },
  ): Promise<void> {
    this.sessions.set(tokenHash, {
      userId, expiresAt: expiresAt.toISOString(),
      userAgent: context.userAgent?.slice(0, 200) ?? null, ipPrefix: context.ipPrefix,
    });
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash);
    if (!session) return null;
    // Expired rows are dropped on read so a stale token cannot be reused even if cleanup lags.
    if (new Date(session.expiresAt).getTime() <= this.now().getTime()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return { userId: session.userId, expiresAt: session.expiresAt };
  }

  async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); }

  async deleteUserSessions(userId: string): Promise<void> {
    for (const [hash, session] of this.sessions) if (session.userId === userId) this.sessions.delete(hash);
  }

  async spendCredit(userId: string, refId: string): Promise<{ ok: boolean; balance: number }> {
    const user = this.users.get(userId);
    if (!user) return { ok: false, balance: 0 };
    // Charging the same reference twice would double-bill a retried request.
    if (this.credits.some((row) => row.userId === userId && row.reason === "api_call" && row.refId === refId)) {
      return { ok: true, balance: user.credits };
    }
    if (user.credits < 1) return { ok: false, balance: user.credits };
    user.credits -= 1;
    this.credits.unshift({
      id: createId(this.now().getTime()), userId, delta: -1, balanceAfter: user.credits,
      reason: "api_call", refId, createdAt: this.timestamp(),
    });
    return { ok: true, balance: user.credits };
  }

  async refundCredit(userId: string, refId: string): Promise<{ refunded: boolean; balance: number }> {
    const user = this.users.get(userId);
    if (!user) return { refunded: false, balance: 0 };
    const charged = this.credits.some((row) => row.userId === userId && row.reason === "api_call" && row.refId === refId);
    const already = this.credits.some((row) => row.userId === userId && row.reason === "refund" && row.refId === refId);
    // Only a charge that happened, and has not been reversed yet, can be refunded.
    if (!charged || already) return { refunded: false, balance: user.credits };
    user.credits += 1;
    this.credits.unshift({
      id: createId(this.now().getTime()), userId, delta: 1, balanceAfter: user.credits,
      reason: "refund", refId, createdAt: this.timestamp(),
    });
    return { refunded: true, balance: user.credits };
  }

  async grantCredits(userId: string, amount: number, reason: CreditReason): Promise<number> {
    const user = this.users.get(userId);
    if (!user) return 0;
    user.credits += amount;
    this.credits.unshift({
      id: createId(this.now().getTime()), userId, delta: amount, balanceAfter: user.credits,
      reason, refId: null, createdAt: this.timestamp(),
    });
    return user.credits;
  }

  async listCredits(userId: string, page: Page): Promise<CreditRecord[]> {
    const rows = this.credits.filter((row) => row.userId === userId);
    return paginate(rows, page).map(({ userId: _owner, ...record }) => record);
  }

  async recordActivity(userId: string, input: ActivityInput): Promise<void> {
    this.activity.unshift({
      id: createId(this.now().getTime()), userId, action: input.action, outcome: input.outcome,
      target: input.target ?? null, errorCode: input.errorCode ?? null,
      creditsDelta: input.creditsDelta ?? 0, createdAt: this.timestamp(),
    });
  }

  async listActivity(userId: string, page: Page): Promise<ActivityRecord[]> {
    const rows = this.activity.filter((row) => row.userId === userId);
    return paginate(rows, page).map(({ userId: _owner, ...record }) => record);
  }

  async saveAnalysis(userId: string, analysis: StoredAnalysis): Promise<void> {
    this.analyses.set(analysis.id, { ...analysis, userId });
  }

  async listAnalyses(userId: string, page: Page): Promise<AnalysisSummary[]> {
    const rows = [...this.analyses.values()]
      .filter((row) => row.userId === userId)
      .sort((left, right) => right.id.localeCompare(left.id));
    return paginate(rows, page).map((row) => ({
      id: row.id, asin: row.asin, marketplace: row.marketplace,
      title: row.product.title, succeeded: Boolean(row.content), createdAt: row.createdAt,
    }));
  }

  async findAnalysis(userId: string, analysisId: string): Promise<StoredAnalysis | null> {
    const row = this.analyses.get(analysisId);
    // The ownership check lives in the lookup itself, so another account's id simply looks absent.
    if (!row || row.userId !== userId) return null;
    const { userId: _owner, ...analysis } = row;
    return analysis;
  }
}
