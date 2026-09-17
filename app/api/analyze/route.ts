import { createAnalyzeHandler } from "@/lib/server/analyze-handler";
import { getAccountStore } from "@/lib/server/account-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Built once: the handler owns the rate-limiting counters, so rebuilding it per request would reset
// them and make the limits meaningless. getAccountStore returns null when accounts are off, which
// keeps the endpoint in its original single-user mode.
export const POST = createAnalyzeHandler({ store: getAccountStore() ?? undefined });
