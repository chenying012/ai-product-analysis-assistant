import { getSetupStatus } from "@/lib/server/config";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getSetupStatus(), { headers: { "Cache-Control": "no-store" } });
}
