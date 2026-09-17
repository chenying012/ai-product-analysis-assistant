import { NextResponse, type NextRequest } from "next/server";

/**
 * Hosts that legitimately serve plain HTTP: loopback, the unspecified address a container binds to,
 * and private ranges used by orchestrator health checks. Redirecting these would break local
 * development and readiness probes, which never speak TLS.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  const [a, b] = octets.map(Number);
  // 127/8 loopback, 10/8 and 192.168/16 private, 172.16/12 private.
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * How long browsers should refuse plain HTTP for this origin. Deliberately short by default because
 * the instruction cannot be withdrawn from browsers that already cached it; raise it via
 * HSTS_MAX_AGE once the HTTPS deployment has been verified.
 */
function maxAge(env: Readonly<Record<string, string | undefined>>): number {
  const value = Number(env.HSTS_MAX_AGE ?? 300);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 300;
}

/**
 * Decides how a request should be treated with respect to transport security. Kept as a pure
 * function so the rules can be tested without a running server.
 *
 * Static security headers live in next.config.ts because they need no request context; this handles
 * only the two decisions that depend on the actual connection.
 */
export function evaluateTransport(
  input: { protocol: string; hostname: string; forwardedProto: string | null },
  env: Readonly<Record<string, string | undefined>> = process.env,
): { action: "redirect" } | { action: "pass"; hsts: string | null } {
  const local = isLocalHost(input.hostname);
  // Behind a proxy the connection to this process is plain HTTP even when the client used TLS, so
  // the forwarded header is authoritative when present.
  const clientProtocol = input.forwardedProto?.split(",")[0].trim().toLowerCase()
    || input.protocol.replace(":", "").toLowerCase();
  if (clientProtocol !== "https") return local ? { action: "pass", hsts: null } : { action: "redirect" };
  // Never send HSTS over localhost: it would poison the developer's browser for every local project
  // sharing that hostname.
  const seconds = maxAge(env);
  return { action: "pass", hsts: local || seconds <= 0 ? null : `max-age=${seconds}; includeSubDomains` };
}

/**
 * Resolves the host the client actually addressed. Behind a proxy request.url carries the internal
 * bind address (0.0.0.0 or 127.0.0.1) while the real name lives in the forwarding headers, so
 * trusting request.url would treat every production request as local and never redirect.
 */
export function resolveHost(headers: { forwardedHost: string | null; host: string | null }, fallback: string): string {
  const candidate = headers.forwardedHost?.split(",")[0].trim() || headers.host?.trim() || fallback;
  return candidate || fallback;
}

/** Strips the port from a host value, leaving IPv6 brackets intact for the caller to normalise. */
export function hostnameOf(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1 || undefined);
  return host.replace(/:\d+$/, "");
}

export default function proxy(request: NextRequest): NextResponse {
  const url = new URL(request.url);
  const host = resolveHost(
    { forwardedHost: request.headers.get("x-forwarded-host"), host: request.headers.get("host") },
    url.host,
  );
  const hostname = hostnameOf(host);
  const decision = evaluateTransport({
    protocol: url.protocol,
    hostname,
    forwardedProto: request.headers.get("x-forwarded-proto"),
  });
  if (decision.action === "redirect") {
    url.protocol = "https:";
    url.host = host;
    // 308 preserves the method and body, so a POST that arrived over HTTP is not silently turned
    // into a GET.
    return NextResponse.redirect(url, 308);
  }
  const response = NextResponse.next();
  if (decision.hsts) response.headers.set("Strict-Transport-Security", decision.hsts);
  return response;
}

export const config = {
  // Static assets are served from the platform edge and need no transport decision of their own.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};