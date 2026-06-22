import { arrayBufferToHex, base64ToBytes, bytesToBase64, utf8Bytes, utf8String } from "./encoding.js";
import { HttpError } from "./http.js";

const ENCRYPTION_PREFIX = "v1";

function requireSecret(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new HttpError(500, `Missing required secret: ${key}.`);
  }

  return value;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function importAesKey(secret) {
  const keyBytes = base64ToBytes(secret);
  if (keyBytes.length !== 32) {
    throw new HttpError(500, "NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }

  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function hmacHex(secret, value) {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, utf8Bytes(value));
  return arrayBufferToHex(signature);
}

export async function contactHash(env, type, value) {
  if (!value) {
    return null;
  }

  const secret = requireSecret(env, "NOTIFICATION_HASH_SECRET");
  return hmacHex(secret, `${type}:${value}`);
}

export async function metadataHash(env, type, value) {
  if (!value) {
    return null;
  }

  const secret = requireSecret(env, "NOTIFICATION_HASH_SECRET");
  return hmacHex(secret, `metadata:${type}:${value}`);
}

export async function encryptString(env, value) {
  if (!value) {
    return null;
  }

  const key = await importAesKey(requireSecret(env, "NOTIFICATION_ENCRYPTION_KEY"));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8Bytes(value));
  return `${ENCRYPTION_PREFIX}:${bytesToBase64(iv)}:${bytesToBase64(encrypted)}`;
}

export async function decryptString(env, value) {
  if (!value) {
    return null;
  }

  const [version, ivBase64, encryptedBase64] = String(value).split(":");
  if (version !== ENCRYPTION_PREFIX || !ivBase64 || !encryptedBase64) {
    throw new HttpError(500, "Stored contact data uses an unsupported encryption format.");
  }

  const key = await importAesKey(requireSecret(env, "NOTIFICATION_ENCRYPTION_KEY"));
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivBase64) },
    key,
    base64ToBytes(encryptedBase64),
  );

  return utf8String(decrypted);
}
