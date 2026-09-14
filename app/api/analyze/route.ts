import { createAnalyzeHandler } from "@/lib/server/analyze-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const POST = createAnalyzeHandler();
