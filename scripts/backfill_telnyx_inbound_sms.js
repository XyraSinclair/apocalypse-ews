#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { webcrypto } = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(REPO_ROOT, "tmp", "telnyx-inbound-sms-backfill.sql");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function parseArgs(argv) {
  const options = {
    dateRange: "last_30_days",
    pageSize: 100,
    maxPages: Infinity,
    output: DEFAULT_OUTPUT,
    execute: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--date-range") {
      options.dateRange = argv[++index];
    } else if (arg === "--page-size") {
      options.pageSize = Number(argv[++index] || options.pageSize);
    } else if (arg === "--max-pages") {
      options.maxPages = Number(argv[++index] || options.maxPages);
    } else if (arg === "--output") {
      options.output = path.resolve(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.pageSize = Math.max(1, Math.min(100, Math.trunc(options.pageSize) || 100));
  if (!Number.isFinite(options.maxPages) || options.maxPages <= 0) {
    options.maxPages = Infinity;
  }
  return options;
}

function requireEnv(env, key) {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function utf8Bytes(value) {
  return new TextEncoder().encode(String(value));
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value) {
  return Uint8Array.from(Buffer.from(String(value), "base64"));
}

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(secret, value) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await webcrypto.subtle.sign("HMAC", key, utf8Bytes(value));
  return arrayBufferToHex(signature);
}

async function contactHash(env, type, value) {
  if (!value) {
    return null;
  }
  return hmacHex(requireEnv(env, "NOTIFICATION_HASH_SECRET"), `${type}:${value}`);
}

async function importAesKey(secret) {
  const keyBytes = base64ToBytes(secret);
  if (keyBytes.length !== 32) {
    throw new Error("NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return webcrypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function encryptString(env, value) {
  if (!value) {
    return null;
  }
  const key = await importAesKey(requireEnv(env, "NOTIFICATION_ENCRYPTION_KEY"));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, utf8Bytes(value));
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

function classifyInboundSms(body) {
  const keyword = String(body || "").trim().split(/\s+/)[0]?.toUpperCase() || "";
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
    return "stop";
  }
  if (["START", "YES", "UNSTOP"].includes(keyword)) {
    return "start";
  }
  if (["HELP", "INFO"].includes(keyword)) {
    return "help";
  }
  return "unknown";
}

function sql(value) {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function normalizePhone(value) {
  const text = String(value || "").trim();
  return text || null;
}

async function telnyxGet(env, pathAndQuery) {
  const response = await fetch(`https://api.telnyx.com/v2${pathAndQuery}`, {
    headers: {
      authorization: `Bearer ${requireEnv(env, "TELNYX_API_KEY")}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const firstError = Array.isArray(payload.errors) ? payload.errors[0] : null;
    throw new Error(firstError?.detail || firstError?.title || `Telnyx request failed with ${response.status}.`);
  }
  return payload;
}

async function listInboundDetailRecords(env, options) {
  const records = [];
  let pageNumber = 1;
  let totalPages = 1;

  while (pageNumber <= totalPages && pageNumber <= options.maxPages) {
    const params = new URLSearchParams();
    params.set("filter[record_type]", "messaging");
    params.set("filter[direction]", "inbound");
    params.set("filter[date_range]", options.dateRange);
    params.set("page[size]", String(options.pageSize));
    params.set("page[number]", String(pageNumber));
    params.set("sort", "-created_at");

    const payload = await telnyxGet(env, `/detail_records?${params.toString()}`);
    records.push(...(payload.data || []));
    totalPages = Number(payload.meta?.total_pages || pageNumber);
    pageNumber += 1;
  }

  return records;
}

async function retrieveMessage(env, id) {
  if (!id) {
    return null;
  }
  try {
    const payload = await telnyxGet(env, `/messages/${encodeURIComponent(id)}`);
    return payload.data || null;
  } catch (error) {
    return {
      id,
      retrieveError: error.message,
    };
  }
}

function getMessageToPhone(message, record) {
  if (Array.isArray(message?.to) && message.to[0]?.phone_number) {
    return normalizePhone(message.to[0].phone_number);
  }
  return normalizePhone(record.cld);
}

function getMessageFromPhone(message, record) {
  return normalizePhone(message?.from?.phone_number || record.cli);
}

function getReceivedAt(message, record) {
  const value = message?.received_at || message?.created_at || record.sent_at || record.created_at || record.completed_at;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString();
}

async function buildInsert(env, record) {
  const providerMessageId = String(record.id || "").trim();
  if (!providerMessageId) {
    return null;
  }

  const message = await retrieveMessage(env, providerMessageId);
  const fromPhone = getMessageFromPhone(message, record);
  if (!fromPhone) {
    return null;
  }

  const toPhone = getMessageToPhone(message, record);
  const text = message?.text || null;
  const receivedAt = getReceivedAt(message, record);
  const phoneHash = await contactHash(env, "phone", fromPhone);
  const fromPhoneCipher = await encryptString(env, fromPhone);
  const toPhoneHash = await contactHash(env, "phone", toPhone);
  const toPhoneCipher = await encryptString(env, toPhone);
  const messageTextCipher = await encryptString(env, text);
  const action = classifyInboundSms(text);
  const metadata = {
    source: "telnyx_detail_records",
    messageType: message?.type || record.message_type || null,
    profileId: message?.messaging_profile_id || record.profile_id || null,
    fromCarrier: message?.from?.carrier || null,
    fromLineType: message?.from?.line_type || null,
    toCarrier: message?.to?.[0]?.carrier || null,
    toLineType: message?.to?.[0]?.line_type || null,
    retrieveError: message?.retrieveError || null,
    textStored: Boolean(text),
  };

  return `
INSERT INTO notification_inbound_messages (
  id,
  provider,
  provider_message_id,
  provider_event_id,
  subscriber_id,
  channel,
  phone_hash,
  from_phone_hash,
  from_phone_cipher,
  to_phone_hash,
  to_phone_cipher,
  message_text_cipher,
  action,
  status,
  error,
  received_at,
  created_at,
  updated_at,
  metadata_json
)
VALUES (
  ${sql(webcrypto.randomUUID())},
  'telnyx',
  ${sql(providerMessageId)},
  NULL,
  (
    SELECT id
    FROM notification_signups
    WHERE phone_hash = ${sql(phoneHash)}
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'past_due' THEN 1
        WHEN 'pending_checkout' THEN 2
        ELSE 3
      END,
      updated_at DESC,
      id ASC
    LIMIT 1
  ),
  'sms',
  ${sql(phoneHash)},
  ${sql(phoneHash)},
  ${sql(fromPhoneCipher)},
  ${sql(toPhoneHash)},
  ${sql(toPhoneCipher)},
  ${sql(messageTextCipher)},
  ${sql(action)},
  ${sql(record.status || "delivered")},
  ${sql(message?.retrieveError || null)},
  ${sql(receivedAt)},
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  ${sql(JSON.stringify(metadata))}
)
ON CONFLICT(provider, provider_message_id) DO UPDATE SET
  subscriber_id = COALESCE(excluded.subscriber_id, notification_inbound_messages.subscriber_id),
  phone_hash = excluded.phone_hash,
  from_phone_hash = excluded.from_phone_hash,
  from_phone_cipher = excluded.from_phone_cipher,
  to_phone_hash = excluded.to_phone_hash,
  to_phone_cipher = excluded.to_phone_cipher,
  message_text_cipher = COALESCE(excluded.message_text_cipher, notification_inbound_messages.message_text_cipher),
  action = COALESCE(excluded.action, notification_inbound_messages.action),
  status = COALESCE(excluded.status, notification_inbound_messages.status),
  error = excluded.error,
  received_at = excluded.received_at,
  updated_at = CURRENT_TIMESTAMP,
  metadata_json = excluded.metadata_json;`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = {
    ...loadEnvFile(path.join(REPO_ROOT, ".env")),
    ...loadEnvFile(path.join(REPO_ROOT, ".dev.vars")),
    ...process.env,
  };

  const records = await listInboundDetailRecords(env, options);
  const statements = [];
  let skippedCount = 0;
  let textStoredCount = 0;

  for (const record of records) {
    const statement = await buildInsert(env, record);
    if (!statement) {
      skippedCount += 1;
      continue;
    }
    if (!statement.includes("textStored\":false")) {
      textStoredCount += 1;
    }
    statements.push(statement);
  }

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${statements.join("\n")}\n`);

  console.log(`Fetched inbound Telnyx records: ${records.length}`);
  console.log(`Prepared SQL inserts: ${statements.length}`);
  console.log(`Skipped records: ${skippedCount}`);
  console.log(`Records with body text available: ${textStoredCount}`);
  console.log(`SQL file: ${options.output}`);

  if (options.execute && statements.length > 0) {
    const result = spawnSync(
      "npx",
      ["wrangler", "d1", "execute", "ews-notifications", "--remote", "--file", options.output],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env, ...env },
      },
    );
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
