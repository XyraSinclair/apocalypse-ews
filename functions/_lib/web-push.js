import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "./encoding.js";
import { HttpError } from "./http.js";

const WEB_PUSH_PUBLIC_KEY_BYTES = 65;
const WEB_PUSH_PRIVATE_KEY_BYTES = 32;
const WEB_PUSH_AUTH_SECRET_MIN_BYTES = 16;
const WEB_PUSH_AUTH_SECRET_MAX_BYTES = 32;
const WEB_PUSH_RECORD_SIZE = 4096;
const WEB_PUSH_MAX_PAYLOAD_BYTES = 3072;
const WEB_PUSH_DEFAULT_TTL_SECONDS = 300;
const WEB_PUSH_MAX_TTL_SECONDS = 24 * 60 * 60;
const WEB_PUSH_VAPID_EXPIRY_SECONDS = 12 * 60 * 60;

export class WebPushDeliveryError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "WebPushDeliveryError";
    this.status = status;
    this.expired = status === 404 || status === 410;
  }
}

function hasText(value) {
  return Boolean(String(value || "").trim());
}

export function isWebPushConfigured(env) {
  return hasText(env.WEB_PUSH_VAPID_PUBLIC_KEY) && hasText(env.WEB_PUSH_VAPID_PRIVATE_KEY) && hasText(env.WEB_PUSH_CONTACT);
}

export function getVapidPublicKey(env) {
  const publicKey = String(env.WEB_PUSH_VAPID_PUBLIC_KEY || "").trim();
  if (!publicKey) {
    throw new HttpError(503, "Browser push is not configured.");
  }
  parseVapidPublicKey(publicKey);
  return publicKey;
}

function concatBytes(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function uint32Bytes(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function assertBase64Url(value, label) {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(String(value || ""))) {
    throw new HttpError(400, `${label} must be base64url encoded.`);
  }
}

function parseBase64UrlBytes(value, label) {
  assertBase64Url(value, label);
  return base64UrlToBytes(value);
}

function parseVapidPublicKey(value) {
  const bytes = parseBase64UrlBytes(value, "WEB_PUSH_VAPID_PUBLIC_KEY");
  if (bytes.length !== WEB_PUSH_PUBLIC_KEY_BYTES || bytes[0] !== 4) {
    throw new HttpError(500, "WEB_PUSH_VAPID_PUBLIC_KEY must be a base64url-encoded uncompressed P-256 public key.");
  }
  return bytes;
}

function parseVapidPrivateKey(value) {
  const bytes = parseBase64UrlBytes(value, "WEB_PUSH_VAPID_PRIVATE_KEY");
  if (bytes.length !== WEB_PUSH_PRIVATE_KEY_BYTES) {
    throw new HttpError(500, "WEB_PUSH_VAPID_PRIVATE_KEY must be a base64url-encoded P-256 private key scalar.");
  }
  return bytes;
}

function normalizeVapidSubject(value) {
  const subject = String(value || "").trim();
  if (!subject) {
    throw new HttpError(500, "WEB_PUSH_CONTACT is required for browser push VAPID authentication.");
  }
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(subject) && !/^https:\/\//i.test(subject)) {
    throw new HttpError(500, "WEB_PUSH_CONTACT must be a mailto: address or https URL.");
  }
  return subject;
}

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || "").trim();
  if (!value) {
    throw new HttpError(400, "Push subscription endpoint is missing.");
  }
  if (value.length > 2048) {
    throw new HttpError(400, "Push subscription endpoint is too long.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Push subscription endpoint must be a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new HttpError(400, "Push subscription endpoint must use https.");
  }
  return { endpoint: url.toString(), origin: url.origin };
}

export function normalizePushSubscriptionPayload(value) {
  const source = value?.subscription && typeof value.subscription === "object" ? value.subscription : value;
  const { endpoint, origin } = normalizeEndpoint(source?.endpoint);
  const keys = source?.keys || {};
  const p256dh = String(keys.p256dh || "").trim();
  const auth = String(keys.auth || "").trim();
  const p256dhBytes = parseBase64UrlBytes(p256dh, "Push subscription p256dh key");
  if (p256dhBytes.length !== WEB_PUSH_PUBLIC_KEY_BYTES || p256dhBytes[0] !== 4) {
    throw new HttpError(400, "Push subscription p256dh key must be an uncompressed P-256 public key.");
  }
  const authBytes = parseBase64UrlBytes(auth, "Push subscription auth secret");
  if (authBytes.length < WEB_PUSH_AUTH_SECRET_MIN_BYTES || authBytes.length > WEB_PUSH_AUTH_SECRET_MAX_BYTES) {
    throw new HttpError(400, "Push subscription auth secret length is invalid.");
  }
  return {
    endpoint,
    endpointOrigin: origin,
    keys: {
      p256dh,
      auth,
    },
    encoding: "aes128gcm",
  };
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, dataBytes);
  return new Uint8Array(signature);
}

async function hkdfExpand(prkBytes, infoBytes, length) {
  const chunks = [];
  let previous = new Uint8Array(0);
  let generatedLength = 0;
  let counter = 1;
  while (generatedLength < length) {
    const chunk = await hmacSha256(prkBytes, concatBytes(previous, infoBytes, new Uint8Array([counter])));
    chunks.push(chunk);
    previous = chunk;
    generatedLength += chunk.length;
    counter += 1;
  }
  return concatBytes(...chunks).slice(0, length);
}

function webPushInfo(userPublicKey, serverPublicKey) {
  return concatBytes(utf8Bytes("WebPush: info"), new Uint8Array([0]), userPublicKey, serverPublicKey);
}

export async function encryptWebPushPayload(subscription, payloadText) {
  const normalizedSubscription = normalizePushSubscriptionPayload(subscription);
  const payloadBytes = utf8Bytes(payloadText);
  if (payloadBytes.length > WEB_PUSH_MAX_PAYLOAD_BYTES) {
    throw new HttpError(400, "Push notification payload is too large.");
  }

  const userPublicKey = base64UrlToBytes(normalizedSubscription.keys.p256dh);
  const authSecret = base64UrlToBytes(normalizedSubscription.keys.auth);
  const applicationServerKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const applicationServerPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", applicationServerKeys.publicKey));
  const userPublicCryptoKey = await crypto.subtle.importKey(
    "raw",
    userPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: userPublicCryptoKey }, applicationServerKeys.privateKey, 256),
  );

  const prkKey = await hmacSha256(authSecret, sharedSecret);
  const ikm = await hkdfExpand(prkKey, webPushInfo(userPublicKey, applicationServerPublicKey), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk, utf8Bytes("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, utf8Bytes("Content-Encoding: nonce\0"), 12);
  const plaintext = concatBytes(payloadBytes, new Uint8Array([2]));
  if (plaintext.length + 16 > WEB_PUSH_RECORD_SIZE) {
    throw new HttpError(400, "Push notification payload exceeds one aes128gcm record.");
  }
  const contentEncryptionKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, contentEncryptionKey, plaintext));
  const header = concatBytes(salt, uint32Bytes(WEB_PUSH_RECORD_SIZE), new Uint8Array([applicationServerPublicKey.length]), applicationServerPublicKey);
  return concatBytes(header, ciphertext);
}

async function importVapidSigningKey(env) {
  const publicKey = parseVapidPublicKey(String(env.WEB_PUSH_VAPID_PUBLIC_KEY || "").trim());
  const privateKey = parseVapidPrivateKey(String(env.WEB_PUSH_VAPID_PRIVATE_KEY || "").trim());
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
    d: bytesToBase64Url(privateKey),
    ext: false,
    key_ops: ["sign"],
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function createVapidJwt(env, endpointOrigin) {
  const header = bytesToBase64Url(utf8Bytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(
    utf8Bytes(
      JSON.stringify({
        aud: endpointOrigin,
        exp: Math.floor(Date.now() / 1000) + WEB_PUSH_VAPID_EXPIRY_SECONDS,
        sub: normalizeVapidSubject(env.WEB_PUSH_CONTACT),
      }),
    ),
  );
  const unsignedToken = `${header}.${claims}`;
  const signingKey = await importVapidSigningKey(env);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, utf8Bytes(unsignedToken)),
  );
  return `${unsignedToken}.${bytesToBase64Url(signature)}`;
}

function normalizeTtl(value) {
  const ttl = Math.trunc(Number(value || WEB_PUSH_DEFAULT_TTL_SECONDS));
  if (!Number.isFinite(ttl) || ttl <= 0) {
    return WEB_PUSH_DEFAULT_TTL_SECONDS;
  }
  return Math.min(ttl, WEB_PUSH_MAX_TTL_SECONDS);
}

function normalizeUrgency(value) {
  const urgency = String(value || "high").trim().toLowerCase();
  if (["very-low", "low", "normal", "high"].includes(urgency)) {
    return urgency;
  }
  return "high";
}

export function buildWebPushNotificationPayload({ title, body, url, tag, level, eventKey }) {
  return JSON.stringify({
    title: String(title || "Apocalypse EWS alert").slice(0, 160),
    body: String(body || "A takeoff or anomaly alert was detected.").slice(0, 1200),
    url: String(url || "/"),
    tag: String(tag || eventKey || "apocalypse-ews-alert").slice(0, 128),
    level: level ?? null,
    eventKey: eventKey || null,
  });
}

export async function sendWebPush(env, { subscription, payload, ttl = WEB_PUSH_DEFAULT_TTL_SECONDS, urgency = "high" }) {
  const normalizedSubscription = normalizePushSubscriptionPayload(subscription);
  if (!isWebPushConfigured(env)) {
    throw new HttpError(500, "Browser push is not configured.");
  }
  const body = await encryptWebPushPayload(normalizedSubscription, payload);
  const vapidJwt = await createVapidJwt(env, normalizedSubscription.endpointOrigin);
  const response = await fetch(normalizedSubscription.endpoint, {
    method: "POST",
    headers: {
      authorization: `vapid t=${vapidJwt}, k=${getVapidPublicKey(env)}`,
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(normalizeTtl(ttl)),
      urgency: normalizeUrgency(urgency),
    },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    const message = responseText.trim() || `Web Push request failed with ${response.status}`;
    throw new WebPushDeliveryError(response.status, message.slice(0, 1000));
  }
  return {
    id: response.headers.get("location") || null,
    providerStatus: String(response.status),
  };
}
