import { createLogoutHandler } from "@/lib/server/account-handlers";
import { withAccountStore } from "../../account-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAccountStore((store) => createLogoutHandler({ store }));
