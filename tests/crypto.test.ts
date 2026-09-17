import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  createToken, decryptSecret, encryptSecret, hashPassword, hashToken,
  ipPrefix, readEncryptionKey, safeEqual, verifyPassword,
} from "../lib/crypto";

const key = randomBytes(32);
const keyBase64 = key.toString("base64");

test("a password verifies against its own hash", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.ok(await verifyPassword("correct horse battery", stored));
});

test("a wrong password is rejected", async () => {
  const stored = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse batter", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("the same password produces different stored values", async () => {
  const [first, second] = await Promise.all([hashPassword("repeated"), hashPassword("repeated")]);
  assert.notEqual(first, second, "每次哈希必须使用独立随机盐");
  assert.ok(await verifyPassword("repeated", first));
  assert.ok(await verifyPassword("repeated", second));
});

test("a stored hash never contains the password itself", async () => {
  const stored = await hashPassword("plaintext-must-not-appear");
  assert.ok(!stored.includes("plaintext-must-not-appear"));
});

test("the hash records its cost parameters so they can be raised later", async () => {
  const stored = await hashPassword("cost");
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
});

test("passwords differing only by unicode form are treated as equal", async () => {
  // Composed and decomposed forms look identical to the user, so a login must accept both.
  const stored = await hashPassword("café-\u00e9");
  assert.ok(await verifyPassword("cafe\u0301-e\u0301", stored));
});

test("a malformed verifier is rejected instead of throwing", async () => {
  for (const stored of ["", "scrypt$", "bcrypt$1$2$3$4$5", "scrypt$a$8$1$c2FsdA==$aGFzaA==", "scrypt$32768$8$1$$", "not-a-hash"]) {
    assert.equal(await verifyPassword("any", stored), false, `应拒绝: ${stored}`);
  }
});

test("an implausible cost parameter cannot be used to exhaust memory", async () => {
  const stored = `scrypt$${2 ** 21}$8$1$${Buffer.from("salt").toString("base64")}$${Buffer.alloc(32).toString("base64")}`;
  assert.equal(await verifyPassword("any", stored), false);
});

test("an encrypted secret decrypts back to the original", () => {
  const secret = "sk-example-value-not-a-real-key";
  assert.equal(decryptSecret(encryptSecret(secret, key), key), secret);
});

test("encryption never reveals the plaintext and never repeats itself", () => {
  const secret = "visible-marker";
  const first = encryptSecret(secret, key);
  const second = encryptSecret(secret, key);
  assert.ok(!first.includes(secret));
  assert.notEqual(first, second, "每条记录必须使用独立随机 IV");
  assert.equal(decryptSecret(second, key), secret);
});

test("chinese and emoji round-trip without corruption", () => {
  const secret = "密钥内容·测试🙂";
  assert.equal(decryptSecret(encryptSecret(secret, key), key), secret);
});

test("a tampered ciphertext is detected rather than silently accepted", () => {
  const payload = encryptSecret("integrity", key);
  const parts = payload.split(":");
  const data = Buffer.from(parts[2], "base64");
  data[0] ^= 0x01;
  const tampered = [parts[0], parts[1], data.toString("base64"), parts[3]].join(":");
  assert.throws(() => decryptSecret(tampered, key), /篡改|校验失败/);
});

test("a tampered authentication tag is detected", () => {
  const parts = encryptSecret("integrity", key).split(":");
  const tag = Buffer.from(parts[3], "base64");
  tag[0] ^= 0x01;
  assert.throws(() => decryptSecret([parts[0], parts[1], parts[2], tag.toString("base64")].join(":"), key), /篡改|校验失败/);
});

test("decrypting with the wrong key fails", () => {
  const payload = encryptSecret("secret", key);
  assert.throws(() => decryptSecret(payload, randomBytes(32)), /篡改|校验失败/);
});

test("a malformed payload is rejected with a clear error", () => {
  for (const payload of ["", "v1", "v1:a:b", "v2:a:b:c", `v1:${Buffer.alloc(4).toString("base64")}:x:${Buffer.alloc(16).toString("base64")}`]) {
    assert.throws(() => decryptSecret(payload, key), /无法识别|篡改|校验失败/, `应拒绝: ${payload}`);
  }
});

test("the ciphertext carries a version prefix for future key rotation", () => {
  assert.match(encryptSecret("versioned", key), /^v1:/);
});

test("the encryption key must be exactly 32 bytes", () => {
  assert.equal(readEncryptionKey(keyBase64).length, 32);
  assert.throws(() => readEncryptionKey(undefined), /未配置/);
  assert.throws(() => readEncryptionKey("   "), /未配置/);
  assert.throws(() => readEncryptionKey(randomBytes(16).toString("base64")), /32 字节/);
  assert.throws(() => readEncryptionKey(randomBytes(64).toString("base64")), /32 字节/);
});

test("token hashing is stable and hides the token", () => {
  const token = createToken();
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), hashToken(createToken()));
  assert.ok(!hashToken(token).includes(token));
});

test("generated tokens are unique and url-safe", () => {
  const tokens = new Set(Array.from({ length: 50 }, createToken));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test("safe comparison accepts equal values and rejects differences", () => {
  assert.ok(safeEqual("same-value", "same-value"));
  assert.equal(safeEqual("value", "value2"), false);
  assert.equal(safeEqual("", "x"), false);
  assert.ok(safeEqual("", ""));
});

test("ip addresses are reduced to a coarse prefix", () => {
  assert.equal(ipPrefix("203.0.113.42"), "203.0.113.0/24");
  assert.equal(ipPrefix("2001:db8:1234:5678::1"), "2001:db8:1234::/48");
  assert.equal(ipPrefix(null), null);
  assert.equal(ipPrefix(""), null);
  assert.equal(ipPrefix("not-an-ip"), null);
  assert.equal(ipPrefix("999.1.1.1"), null);
});
