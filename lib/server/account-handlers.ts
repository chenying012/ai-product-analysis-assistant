import { z } from "zod";
import { AppError, publicError } from "../errors";
import {
  historyQuerySchema, loginSchema, registerSchema, type PublicUser,
} from "../account-contracts";
import {
  clearedCookie, login, LoginThrottle, logout, publicUser, readCookie, register,
  requireUser, sessionCookie, SESSION_COOKIE, type RequestContext,
} from "./auth";
import { SIGNUP_BONUS } from "./credits";
import type { AccountStore } from "./store";

const throttle = new LoginThrottle();

/** Requests are only Secure-flagged when the client actually used TLS, so local http still works. */
function usedHttps(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim().toLowerCase();
  return (forwarded || new URL(request.url).protocol.replace(":", "")) === "https";
}

function contextOf(request: Request): RequestContext {
  return {
    userAgent: request.headers.get("user-agent"),
    // Trusts the platform's forwarding header; there is no other view of the client address here.
    ip: request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null,
  };
}

function sessionToken(request: Request): string | null {
  return readCookie(request.headers.get("cookie"), SESSION_COOKIE);
}

const noStore = { "Cache-Control": "no-store" } as const;

function fail(error: unknown): Response {
  return Response.json(
    { error: publicError(error) },
    { status: error instanceof AppError ? error.status : 500, headers: noStore },
  );
}

async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new AppError("INVALID_REQUEST", "请求格式不正确。", 400);
  }
  const raw = await request.text();
  if (raw.length > 4096) throw new AppError("REQUEST_TOO_LARGE", "请求内容过大。", 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new AppError("INVALID_REQUEST", "请求内容不是有效的 JSON。", 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("INVALID_REQUEST", "请检查邮箱格式，密码至少 10 位。", 400);
  }
  return parsed.data;
}

/** Rejects registration when an invite code is configured but not supplied correctly. */
function checkInvite(supplied: string | undefined, expected: string): void {
  if (!expected) return;
  if (supplied?.trim() !== expected) throw new AppError("INVITE_REQUIRED", "注册需要邀请码，请向网站维护者获取。", 403);
}

export type AccountHandlerDeps = {
  store: AccountStore;
  inviteCode?: () => string;
  signupBonus?: number;
};

export function createRegisterHandler({ store, inviteCode, signupBonus = SIGNUP_BONUS }: AccountHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const input = await readJson(request, registerSchema);
      checkInvite(input.inviteCode, inviteCode?.() ?? "");
      const { user, token } = await register(store, input, signupBonus, contextOf(request));
      return Response.json({ user: publicUser(user) } satisfies { user: PublicUser }, {
        status: 201,
        headers: { ...noStore, "Set-Cookie": sessionCookie(token, usedHttps(request)) },
      });
    } catch (error) { return fail(error); }
  };
}

export function createLoginHandler({ store }: AccountHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const input = await readJson(request, loginSchema);
      const { user, token } = await login(store, input, contextOf(request), throttle);
      return Response.json({ user: publicUser(user) }, {
        headers: { ...noStore, "Set-Cookie": sessionCookie(token, usedHttps(request)) },
      });
    } catch (error) { return fail(error); }
  };
}

export function createLogoutHandler({ store }: AccountHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    try {
      await logout(store, sessionToken(request));
      return Response.json({ ok: true }, {
        headers: { ...noStore, "Set-Cookie": clearedCookie(usedHttps(request)) },
      });
    } catch (error) { return fail(error); }
  };
}

export function createMeHandler({ store }: AccountHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const { user } = await requireUser(store, sessionToken(request));
      return Response.json({ user: publicUser(user) }, { headers: noStore });
    } catch (error) { return fail(error); }
  };
}

function pageOf(request: Request) {
  const url = new URL(request.url);
  const parsed = historyQuerySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
  });
  if (!parsed.success) throw new AppError("INVALID_REQUEST", "分页参数无效。", 400);
  return { limit: parsed.data.limit, before: parsed.data.before };
}

export function createActivityHandler({ store }: AccountHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const { user } = await requireUser(store, sessionToken(request));
      // Every listing is scoped to the caller; there is no parameter that could widen it.
      const [activity, credits] = await Promise.all([
        store.listActivity(user.id, pageOf(request)),
        store.listCredits(user.id, pageOf(request)),
      ]);
      return Response.json({ activity, credits, balance: user.credits }, { headers: noStore });
    } catch (error) { return fail(error); }
  };
}

export function createAnalysesHandler({ store }: AccountHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    try {
      const { user } = await requireUser(store, sessionToken(request));
      return Response.json({ analyses: await store.listAnalyses(user.id, pageOf(request)) }, { headers: noStore });
    } catch (error) { return fail(error); }
  };
}

export function createAnalysisDetailHandler({ store }: AccountHandlerDeps) {
  return async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    try {
      const { user } = await requireUser(store, sessionToken(request));
      const { id } = await context.params;
      const analysis = await store.findAnalysis(user.id, id);
      // Someone else's identifier is reported as missing rather than forbidden: a 403 would confirm
      // that the record exists.
      if (!analysis) throw new AppError("NOT_FOUND", "没有找到该分析记录。", 404);
      return Response.json({ analysis }, { headers: noStore });
    } catch (error) { return fail(error); }
  };
}
