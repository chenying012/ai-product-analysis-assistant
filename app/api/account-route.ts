import { getAccountStore } from "@/lib/server/account-store";
import type { AccountStore } from "@/lib/server/store";
import { AppError, publicError } from "@/lib/errors";

/** Shape Next generates for a route with no dynamic segments. */
type EmptyRouteContext = { params: Promise<Record<string, never>> };

/**
 * Wraps a route so it only runs when accounts are configured. Without this every account route would
 * repeat the same guard, and a missing one would surface as an opaque 500.
 */
export function withAccountStore(
  build: (store: AccountStore) => (request: Request) => Promise<Response>,
) {
  return async function handler(request: Request, _context: EmptyRouteContext): Promise<Response> {
    const store = getAccountStore();
    if (!store) {
      return Response.json(
        { error: publicError(new AppError("ACCOUNTS_DISABLED", "本站未启用账户功能。", 503)) },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return build(store)(request);
  };
}
