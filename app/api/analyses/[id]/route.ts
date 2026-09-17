import { createAnalysisDetailHandler } from "@/lib/server/account-handlers";
import { getAccountStore } from "@/lib/server/account-store";
import { AppError, publicError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const store = getAccountStore();
  if (!store) {
    return Response.json(
      { error: publicError(new AppError("ACCOUNTS_DISABLED", "本站未启用账户功能。", 503)) },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return createAnalysisDetailHandler({ store })(request, context);
}
