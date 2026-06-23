import { base64ToBytes, utf8Bytes } from "./encoding.js";
import { HttpError, jsonResponse } from "./http.js";

const SENDGRID_WEBHOOK_TOLERANCE_SECONDS = 300;
const SENDGRID_FAILURE_EVENTS = new Set(["bounce", "dropped"]);
const SENDGRID_ACCEPTANCE_EVENTS = new Set(["processed", "deferred"]);

function getPublicBaseUrl(env) {
  return String(env.APP_BASE_URL || env.EWS_PUBLIC_URL || "")
    .trim()
    .replace(/\/+$/, "");
}

export function getSendGridWebhookUrl(env) {
  const configuredUrl = String(env.SENDGRID_WEBHOOK_URL || "").trim();
  if (configuredUrl) {
    return configuredUrl;
  }

  const publicBaseUrl = getPublicBaseUrl(env);
  if (!publicBaseUrl.startsWith("https://")) {
    return null;
  }

  return `${publicBaseUrl}/api/sendgrid/webhook`;
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function decodePemSpki(value) {
  const match = String(value || "").match(/-----BEGIN PUBLIC KEY-----(?<body>[\s\S]+?)-----END PUBLIC KEY-----/);
  if (!match?.groups?.body) {
    return null;
  }

  return base64ToBytes(match.groups.body.replace(/\s+/g, ""));
}

function decodeSendGridPublicKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }

  const pemBytes = decodePemSpki(text);
  if (pemBytes) {
    return pemBytes;
  }

  try {
    return base64ToBytes(text.replace(/\s+/g, ""));
  } catch {
    return null;
  }
}

async function importSendGridPublicKey(value) {
  const keyBytes = decodeSendGridPublicKey(value);
  if (!keyBytes) {
    throw new HttpError(500, "SENDGRID_WEBHOOK_PUBLIC_KEY is not a supported ECDSA public key format.");
  }

  return crypto.subtle.importKey("spki", keyBytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

function readDerLength(bytes, offset) {
  if (offset >= bytes.length) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  const first = bytes[offset];
  if (first < 0x80) {
    return { length: first, offset: offset + 1 };
  }

  const byteCount = first & 0x7f;
  if (byteCount < 1 || byteCount > 2 || offset + byteCount >= bytes.length) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  let length = 0;
  for (let index = 0; index < byteCount; index += 1) {
    length = length * 256 + bytes[offset + 1 + index];
  }
  return { length, offset: offset + 1 + byteCount };
}

function readDerInteger(bytes, offset) {
  if (bytes[offset] !== 0x02) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  const lengthResult = readDerLength(bytes, offset + 1);
  const start = lengthResult.offset;
  const end = start + lengthResult.length;
  if (end > bytes.length || start === end) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  let value = bytes.slice(start, end);
  while (value.length > 32 && value[0] === 0) {
    value = value.slice(1);
  }
  if (value.length > 32) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  const output = new Uint8Array(32);
  output.set(value, 32 - value.length);
  return { value: output, offset: end };
}

function derEcdsaSignatureToRaw(signatureBytes) {
  if (signatureBytes[0] !== 0x30) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  const sequenceLength = readDerLength(signatureBytes, 1);
  const sequenceEnd = sequenceLength.offset + sequenceLength.length;
  if (sequenceEnd !== signatureBytes.length) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  const r = readDerInteger(signatureBytes, sequenceLength.offset);
  const s = readDerInteger(signatureBytes, r.offset);
  if (s.offset !== sequenceEnd) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }

  return concatBytes(r.value, s.value);
}

export function hasSendGridWebhookVerificationKey(env) {
  return Boolean(String(env.SENDGRID_WEBHOOK_PUBLIC_KEY || "").trim());
}

export async function verifySendGridWebhook(request, env, rawBodyBytes) {
  const publicKey = String(env.SENDGRID_WEBHOOK_PUBLIC_KEY || "").trim();
  if (!publicKey) {
    throw new HttpError(500, "Missing required secret: SENDGRID_WEBHOOK_PUBLIC_KEY.");
  }

  const signature = request.headers.get("x-twilio-email-event-webhook-signature") || "";
  const timestamp = request.headers.get("x-twilio-email-event-webhook-timestamp") || "";
  if (!signature || !timestamp) {
    throw new HttpError(403, "Missing SendGrid webhook signature.");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new HttpError(403, "Invalid SendGrid webhook timestamp.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SENDGRID_WEBHOOK_TOLERANCE_SECONDS) {
    throw new HttpError(403, "SendGrid webhook timestamp is outside the allowed tolerance.");
  }

  let rawSignature;
  try {
    rawSignature = derEcdsaSignatureToRaw(base64ToBytes(signature));
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(403, "Invalid SendGrid webhook signature encoding.");
  }

  const key = await importSendGridPublicKey(publicKey);
  const signedPayload = concatBytes(utf8Bytes(timestamp), rawBodyBytes);
  const signatureMatches = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    rawSignature,
    signedPayload,
  );
  if (!signatureMatches) {
    throw new HttpError(403, "Invalid SendGrid webhook signature.");
  }
}

export function normalizeSendGridEventStatus(event = {}) {
  const eventName = String(event.event || "").trim().toLowerCase();
  if (eventName === "delivered") {
    return "delivered";
  }
  if (SENDGRID_FAILURE_EVENTS.has(eventName)) {
    return "undelivered";
  }
  if (SENDGRID_ACCEPTANCE_EVENTS.has(eventName)) {
    return "sent";
  }

  return null;
}

export function getSendGridDeliveryError(event = {}) {
  return event.reason || event.response || event.status || null;
}

export function getSendGridProviderStatus(event = {}) {
  return event.event || event.status || null;
}

export function getSendGridProviderMessageIds(event = {}) {
  const ids = [];
  const addId = (value) => {
    const text = String(value || "").trim();
    if (text && !ids.includes(text)) {
      ids.push(text);
    }
  };

  addId(event.sg_message_id);
  const filterPrefix = String(event.sg_message_id || "").match(/^(?<id>.+?)\.filter\d+\./)?.groups?.id;
  addId(filterPrefix);
  addId(String(event["smtp-id"] || "").replace(/^<|>$/g, ""));
  return ids;
}

export function sendGridWebhookResponse(payload = {}) {
  return jsonResponse(
    {
      ok: true,
      provider: "sendgrid",
      ...payload,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
