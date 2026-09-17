import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ActivityRecord, AnalysisSummary, CreditRecord, CreditReason,
} from "../account-contracts";
import type { Content, Product, Quality } from "../contracts";
import {
  createId, type AccountStore, type ActivityInput, type Page, type SessionRecord,
  type StoredAnalysis, type StoredUser,
} from "./store";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  credits       INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT,
  ip_prefix  TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  ref_id        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_user ON credit_transactions (user_id, id DESC);
-- Guarantees a retried request can neither be charged nor refunded twice.
CREATE UNIQUE INDEX IF NOT EXISTS credits_once
  ON credit_transactions (user_id, reason, ref_id) WHERE ref_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS activity_logs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  target        TEXT,
  outcome       TEXT NOT NULL,
  error_code    TEXT,
  credits_delta INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_user ON activity_logs (user_id, id DESC);

CREATE TABLE IF NOT EXISTS analyses (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asin        TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  title       TEXT NOT NULL,
  product     TEXT NOT NULL,
  content     TEXT,
  quality     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analyses_user ON analyses (user_id, id DESC);
`;

type UserRow = {
  id: string; email: string; password_hash: string; credits: number;
  status: string; created_at: string;
};

function toUser(row: UserRow): StoredUser {
  return {
    id: row.id, email: row.email, passwordHash: row.password_hash, credits: row.credits,
    status: row.status === "disabled" ? "disabled" : "active", createdAt: row.created_at,
  };
}

/**
 * SQLite-backed store. Chosen so the deployment needs no external database service and no additional
 * dependency: node:sqlite ships with the runtime.
 *
 * Durability caveat: the file lives on the container's own disk. If the container is rebuilt or reset
 * the accounts and their credit history are lost. That is an accepted trade-off for this demo, not a
 * property to rely on.
 */
export class SqliteAccountStore implements AccountStore {
  private readonly db: DatabaseSync;

  constructor(file: string, private readonly clock: () => Date = () => new Date()) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  now(): Date { return this.clock(); }

  private timestamp(): string { return this.now().toISOString(); }

  close(): void { this.db.close(); }

  /**
   * Runs work inside a transaction so a partially applied change can never be observed. Used for
   * every operation that touches a balance together with its ledger row.
   */
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertLedger(userId: string, delta: number, balanceAfter: number, reason: CreditReason, refId: string | null): void {
    this.db.prepare(
      "INSERT INTO credit_transactions (id, user_id, delta, balance_after, reason, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(createId(this.now().getTime()), userId, delta, balanceAfter, reason, refId, this.timestamp());
  }

  async createUser(input: { email: string; passwordHash: string; signupBonus: number }): Promise<StoredUser | null> {
    const email = input.email.toLowerCase();
    try {
      return this.transaction(() => {
        const id = createId(this.now().getTime());
        const credits = Math.max(0, input.signupBonus);
        this.db.prepare(
          "INSERT INTO users (id, email, password_hash, credits, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
        ).run(id, email, input.passwordHash, credits, this.timestamp());
        // The bonus and its ledger row share this transaction, so an account can never exist without
        // the credits it was promised.
        if (credits > 0) this.insertLedger(id, credits, credits, "signup_bonus", null);
        return toUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow);
      });
    } catch (error) {
      // A unique-constraint violation means the address was taken, which is a normal outcome.
      if (error instanceof Error && /UNIQUE constraint failed: users.email/.test(error.message)) return null;
      throw error;
    }
  }

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async findUserById(userId: string): Promise<StoredUser | null> {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async setUserStatus(userId: string, status: StoredUser["status"]): Promise<void> {
    this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  }

  /** Removes an account. Foreign keys cascade, so sessions, ledger, history and analyses go with it. */
  async deleteUser(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }

  async createSession(
    userId: string, tokenHash: string, expiresAt: Date,
    context: { userAgent: string | null; ipPrefix: string | null },
  ): Promise<void> {
    this.db.prepare(
      "INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, created_at, user_agent, ip_prefix) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(tokenHash, userId, expiresAt.toISOString(), this.timestamp(),
      context.userAgent?.slice(0, 200) ?? null, context.ipPrefix);
  }

  async findSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
      { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    // Expired rows are removed on read, so a stale token cannot be replayed even if cleanup lags.
    if (new Date(row.expires_at).getTime() <= this.now().getTime()) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    return { userId: row.user_id, expiresAt: row.expires_at };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  async spendCredit(userId: string, refId: string): Promise<{ ok: boolean; balance: number }> {
    return this.transaction(() => {
      const existing = this.db.prepare(
        "SELECT balance_after FROM credit_transactions WHERE user_id = ? AND reason = 'api_call' AND ref_id = ?",
      ).get(userId, refId) as { balance_after: number } | undefined;
      // Charging the same reference twice would double-bill a retried request.
      if (existing) {
        const current = this.db.prepare("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number } | undefined;
        return { ok: true, balance: current?.credits ?? existing.balance_after };
      }
      // The balance check lives in the UPDATE itself; deciding from a previous SELECT would let two
      // concurrent requests both pass the check and drive the balance negative.
      const result = this.db.prepare("UPDATE users SET credits = credits - 1 WHERE id = ? AND credits >= 1").run(userId);
      const row = this.db.prepare("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number } | undefined;
      if (!row) return { ok: false, balance: 0 };
      if (result.changes === 0) return { ok: false, balance: row.credits };
      this.insertLedger(userId, -1, row.credits, "api_call", refId);
      return { ok: true, balance: row.credits };
    });
  }

  async refundCredit(userId: string, refId: string): Promise<{ refunded: boolean; balance: number }> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number } | undefined;
      if (!row) return { refunded: false, balance: 0 };
      const charged = this.db.prepare(
        "SELECT 1 FROM credit_transactions WHERE user_id = ? AND reason = 'api_call' AND ref_id = ?",
      ).get(userId, refId);
      const already = this.db.prepare(
        "SELECT 1 FROM credit_transactions WHERE user_id = ? AND reason = 'refund' AND ref_id = ?",
      ).get(userId, refId);
      // Only a charge that actually happened, and has not been reversed, can be refunded.
      if (!charged || already) return { refunded: false, balance: row.credits };
      this.db.prepare("UPDATE users SET credits = credits + 1 WHERE id = ?").run(userId);
      const updated = this.db.prepare("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number };
      this.insertLedger(userId, 1, updated.credits, "refund", refId);
      return { refunded: true, balance: updated.credits };
    });
  }

  async grantCredits(userId: string, amount: number, reason: CreditReason): Promise<number> {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE users SET credits = credits + ? WHERE id = ?").run(amount, userId);
      if (result.changes === 0) return 0;
      const row = this.db.prepare("SELECT credits FROM users WHERE id = ?").get(userId) as { credits: number };
      this.insertLedger(userId, amount, row.credits, reason, null);
      return row.credits;
    });
  }

  async listCredits(userId: string, page: Page): Promise<CreditRecord[]> {
    const rows = page.before
      ? this.db.prepare("SELECT * FROM credit_transactions WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(userId, page.before, page.limit)
      : this.db.prepare("SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, page.limit);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), delta: Number(row.delta), balanceAfter: Number(row.balance_after),
      reason: row.reason as CreditReason, refId: row.ref_id ? String(row.ref_id) : null,
      createdAt: String(row.created_at),
    }));
  }

  async recordActivity(userId: string, input: ActivityInput): Promise<void> {
    this.db.prepare(
      "INSERT INTO activity_logs (id, user_id, action, target, outcome, error_code, credits_delta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(createId(this.now().getTime()), userId, input.action, input.target ?? null, input.outcome,
      input.errorCode ?? null, input.creditsDelta ?? 0, this.timestamp());
  }

  async listActivity(userId: string, page: Page): Promise<ActivityRecord[]> {
    const rows = page.before
      ? this.db.prepare("SELECT * FROM activity_logs WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(userId, page.before, page.limit)
      : this.db.prepare("SELECT * FROM activity_logs WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, page.limit);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), action: row.action as ActivityRecord["action"],
      target: row.target ? String(row.target) : null,
      outcome: row.outcome as ActivityRecord["outcome"],
      errorCode: row.error_code ? String(row.error_code) : null,
      creditsDelta: Number(row.credits_delta), createdAt: String(row.created_at),
    }));
  }

  async saveAnalysis(userId: string, analysis: StoredAnalysis): Promise<void> {
    this.db.prepare(
      "INSERT OR REPLACE INTO analyses (id, user_id, asin, marketplace, title, product, content, quality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(analysis.id, userId, analysis.asin, analysis.marketplace, analysis.product.title,
      JSON.stringify(analysis.product),
      analysis.content ? JSON.stringify(analysis.content) : null,
      analysis.quality ? JSON.stringify(analysis.quality) : null,
      analysis.createdAt);
  }

  async listAnalyses(userId: string, page: Page): Promise<AnalysisSummary[]> {
    const rows = page.before
      ? this.db.prepare("SELECT id, asin, marketplace, title, content, created_at FROM analyses WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(userId, page.before, page.limit)
      : this.db.prepare("SELECT id, asin, marketplace, title, content, created_at FROM analyses WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, page.limit);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), asin: String(row.asin), marketplace: String(row.marketplace),
      title: String(row.title), succeeded: Boolean(row.content), createdAt: String(row.created_at),
    }));
  }

  async findAnalysis(userId: string, analysisId: string): Promise<StoredAnalysis | null> {
    // The owner is part of the lookup, so another account's identifier simply looks absent.
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ? AND user_id = ?").get(analysisId, userId) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), asin: String(row.asin), marketplace: String(row.marketplace),
      product: JSON.parse(String(row.product)) as Product,
      content: row.content ? (JSON.parse(String(row.content)) as Content) : null,
      quality: row.quality ? (JSON.parse(String(row.quality)) as Quality) : null,
      createdAt: String(row.created_at),
    };
  }
}
