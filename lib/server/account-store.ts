import type { AccountStore } from "./store";

/**
 * Where the account database lives. Kept outside the build output so redeploying the application code
 * does not by itself discard registered accounts.
 */
const DEFAULT_PATH = ".runtime/accounts.db";

let instance: AccountStore | null = null;

/** True when the deployment is running with accounts, credits and history enabled. */
export function accountsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const setting = env.ACCOUNTS_DB?.trim();
  return Boolean(setting) && setting !== "off";
}

function databasePath(env: Readonly<Record<string, string | undefined>>): string {
  const setting = env.ACCOUNTS_DB?.trim() ?? "";
  return setting === "on" ? DEFAULT_PATH : setting;
}

/**
 * Returns the shared account store, or null when accounts are switched off.
 *
 * The SQLite implementation is loaded lazily through a runtime require: node:sqlite needs an
 * experimental flag, and importing it at module scope would break both the build's page-data
 * collection and any test that merely touches this module.
 *
 * Durability warning: this is a SQLite file on the container's own disk. If the container is rebuilt
 * or reset, every account and its credit history is lost. Acceptable for a demo; not a substitute for
 * a managed database.
 */
export function getAccountStore(env: Readonly<Record<string, string | undefined>> = process.env): AccountStore | null {
  if (!accountsEnabled(env)) return null;
  if (!instance) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SqliteAccountStore } = require("./sqlite-store") as typeof import("./sqlite-store");
    instance = new SqliteAccountStore(databasePath(env));
  }
  return instance;
}
