import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** Wraps scrypt as a promise. promisify's overloads omit the options argument, so the callback form
 * is wrapped directly to keep maxmem type-checked. */
function deriveKey(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error); else resolve(derived);
    });
  });
}

/**
 * Cost parameters for password hashing. N=2^15 keeps a single verification near 100ms on the target
 * runtime, which is unnoticeable for a login yet makes large offline guessing campaigns expensive.
 * They are stored inside every hash so raising them later cannot invalidate existing passwords.
 *
 * Node's default maxmem is 32MiB while these parameters need roughly 128*N*r bytes, so the limit is
 * raised explicitly. Without it the runtime rejects the parameters outright.
 */
const SCRYPT_COST = { N: 32768, r: 8, p: 1, keyLength: 32 } as const;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const SALT_BYTES = 16;
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const CIPHER_VERSION = "v1";

/** Compares two strings without leaking their contents through timing differences. */
export function safeEqual(left: string, right: string): boolean {
  // Hashing first gives both operands a fixed length, so timingSafeEqual never throws on a length
  // mismatch and the comparison itself cannot reveal how many characters matched.
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Hashes a session token. Tokens are high-entropy random values, so a fast digest is sufficient. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Creates a URL-safe random token with 256 bits of entropy. */
export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Derives a verifier for a password. The result embeds the cost parameters and a per-password salt,
 * so two identical passwords never produce the same stored value.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await deriveKey(password.normalize("NFKC"), salt, SCRYPT_COST.keyLength, { ...SCRYPT_COST, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT_COST.N}$${SCRYPT_COST.r}$${SCRYPT_COST.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Checks a password against a stored verifier. Returns false for malformed records instead of
 * throwing, so a corrupted row cannot be distinguished from a wrong password by the caller.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;
  // scrypt needs roughly 128*N*r bytes. Bounding the product rather than each factor keeps the door
  // open for stronger parameters later while ensuring a tampered record cannot request more memory
  // than the process is willing to allocate.
  if (128 * N * r > SCRYPT_MAXMEM || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt, "base64");
    expected = Buffer.from(rawHash, "base64");
  } catch { return false; }
  if (!salt.length || !expected.length) return false;
  try {
    const derived = await deriveKey(password.normalize("NFKC"), salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
    return timingSafeEqual(derived, expected);
  } catch { return false; }
}

/** Reads the data encryption key. Throws when it is absent or the wrong size, so the application
 * fails to start rather than silently falling back to weaker protection. */
export function readEncryptionKey(value: string | undefined): Buffer {
  const raw = value?.trim();
  if (!raw) throw new Error("DATA_ENCRYPTION_KEY 未配置，无法加密存储敏感数据。");
  let key: Buffer;
  try { key = Buffer.from(raw, "base64"); } catch { throw new Error("DATA_ENCRYPTION_KEY 必须是 base64 编码的 32 字节密钥。"); }
  if (key.length !== AES_KEY_BYTES) throw new Error(`DATA_ENCRYPTION_KEY 必须是 ${AES_KEY_BYTES} 字节，当前为 ${key.length} 字节。`);
  return key;
}

/**
 * Encrypts a secret with AES-256-GCM. The authentication tag is stored alongside the ciphertext so
 * any modification is detected at decryption time instead of producing plausible garbage.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [CIPHER_VERSION, iv.toString("base64"), encrypted.toString("base64"), cipher.getAuthTag().toString("base64")].join(":");
}

/** Reverses {@link encryptSecret}. Throws when the payload was tampered with or the key is wrong. */
export function decryptSecret(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) throw new Error("密文格式无法识别，可能已损坏或来自其他版本。");
  const [, rawIv, rawData, rawTag] = parts;
  const iv = Buffer.from(rawIv, "base64");
  const tag = Buffer.from(rawTag, "base64");
  if (iv.length !== AES_IV_BYTES || tag.length !== 16) throw new Error("密文格式无法识别，可能已损坏或来自其他版本。");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(rawData, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // GCM reports both a wrong key and modified data the same way; neither is recoverable.
    throw new Error("密文校验失败，数据可能被篡改或密钥不正确。");
  }
}

/** Reduces an IP address to a coarse prefix so activity logs can flag unusual locations without
 * retaining an identifier precise enough to track an individual. */
export function ipPrefix(address: string | null | undefined): string | null {
  const raw = address?.trim();
  if (!raw) return null;
  if (raw.includes(":")) {
    const groups = raw.split(":").filter(Boolean).slice(0, 3);
    return groups.length ? `${groups.join(":")}::/48` : null;
  }
  const octets = raw.split(".");
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return null;
  return `${octets.slice(0, 3).join(".")}.0/24`;
}
