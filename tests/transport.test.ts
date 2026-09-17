import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateTransport, hostnameOf, resolveHost } from "../proxy";

const publicHost = "68acf3344a2b42fcb72391236349cf4c.ap-singapore.myide.io";

test("the forwarded host takes precedence over the internal bind address", () => {
  // Without this the production host looks like 127.0.0.1 and the redirect never fires.
  assert.equal(resolveHost({ forwardedHost: publicHost, host: "127.0.0.1:3000" }, "0.0.0.0:3000"), publicHost);
  assert.equal(resolveHost({ forwardedHost: null, host: publicHost }, "0.0.0.0:3000"), publicHost);
  assert.equal(resolveHost({ forwardedHost: null, host: null }, "0.0.0.0:3000"), "0.0.0.0:3000");
});

test("only the first forwarded host is used and blanks fall back", () => {
  assert.equal(resolveHost({ forwardedHost: `${publicHost}, evil.example`, host: null }, "fallback"), publicHost);
  assert.equal(resolveHost({ forwardedHost: "   ", host: "   " }, "fallback"), "fallback");
});

test("the port is stripped from the hostname", () => {
  assert.equal(hostnameOf(`${publicHost}:3000`), publicHost);
  assert.equal(hostnameOf("127.0.0.1:3000"), "127.0.0.1");
  assert.equal(hostnameOf("localhost"), "localhost");
  assert.equal(hostnameOf("[::1]:3000"), "[::1]");
});

test("plain http on a public host is redirected", () => {
  const decision = evaluateTransport({ protocol: "http:", hostname: publicHost, forwardedProto: null });
  assert.deepEqual(decision, { action: "redirect" });
});

test("a proxy reporting http is trusted over the local connection protocol", () => {
  // TLS terminates at the platform edge, so the local protocol is https while the client used http.
  const decision = evaluateTransport({ protocol: "https:", hostname: publicHost, forwardedProto: "http" });
  assert.deepEqual(decision, { action: "redirect" });
});

test("only the first forwarded protocol is considered", () => {
  const redirect = evaluateTransport({ protocol: "https:", hostname: publicHost, forwardedProto: "http, https" });
  assert.deepEqual(redirect, { action: "redirect" });
  const pass = evaluateTransport({ protocol: "http:", hostname: publicHost, forwardedProto: "https, http" });
  assert.equal(pass.action, "pass");
});

test("forwarded protocol casing and spacing are tolerated", () => {
  const decision = evaluateTransport({ protocol: "http:", hostname: publicHost, forwardedProto: "  HTTPS " });
  assert.equal(decision.action, "pass");
});

test("https on a public host passes and carries HSTS", () => {
  const decision = evaluateTransport({ protocol: "https:", hostname: publicHost, forwardedProto: "https" });
  assert.equal(decision.action, "pass");
  assert.equal(decision.action === "pass" ? decision.hsts : null, "max-age=300; includeSubDomains");
});

test("HSTS lifetime is configurable", () => {
  const decision = evaluateTransport(
    { protocol: "https:", hostname: publicHost, forwardedProto: "https" },
    { HSTS_MAX_AGE: "31536000" },
  );
  assert.equal(decision.action === "pass" ? decision.hsts : null, "max-age=31536000; includeSubDomains");
});

test("HSTS can be disabled with zero and ignores invalid values", () => {
  const disabled = evaluateTransport({ protocol: "https:", hostname: publicHost, forwardedProto: "https" }, { HSTS_MAX_AGE: "0" });
  assert.equal(disabled.action === "pass" ? disabled.hsts : "unset", null);
  const invalid = evaluateTransport({ protocol: "https:", hostname: publicHost, forwardedProto: "https" }, { HSTS_MAX_AGE: "abc" });
  assert.equal(invalid.action === "pass" ? invalid.hsts : null, "max-age=300; includeSubDomains");
});

test("local development over http is never redirected", () => {
  // 0.0.0.0 is what Next reports when the server binds every interface, and private ranges are used
  // by container health checks. Redirecting any of them breaks local runs and readiness probes.
  for (const hostname of ["localhost", "127.0.0.1", "127.0.1.1", "::1", "[::1]", "::", "0.0.0.0", "app.localhost", "10.0.0.5", "192.168.1.20", "172.20.0.3"]) {
    const decision = evaluateTransport({ protocol: "http:", hostname, forwardedProto: null });
    assert.equal(decision.action, "pass", `${hostname} 不应被跳转`);
  }
});

test("public addresses outside private ranges are still redirected", () => {
  for (const hostname of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.1.1", "203.0.113.7", publicHost]) {
    const decision = evaluateTransport({ protocol: "http:", hostname, forwardedProto: null });
    assert.deepEqual(decision, { action: "redirect" }, `${hostname} 应被跳转`);
  }
});

test("localhost never receives HSTS even over https", () => {
  // Sending it would make every future local project on this hostname unreachable over http.
  const decision = evaluateTransport({ protocol: "https:", hostname: "localhost", forwardedProto: "https" });
  assert.equal(decision.action === "pass" ? decision.hsts : "unset", null);
});

test("a host merely containing localhost is still protected", () => {
  const decision = evaluateTransport({ protocol: "http:", hostname: "localhost.attacker.example", forwardedProto: null });
  assert.deepEqual(decision, { action: "redirect" }, "不能因为域名前缀包含 localhost 就放行");
});
