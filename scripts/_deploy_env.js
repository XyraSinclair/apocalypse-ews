const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const REQUIRED_DASHBOARD_ENV_VARS = [
  "VITE_DASHBOARD_URL",
  "VITE_MILITARY_DASHBOARD_URL",
  "VITE_UNTRACKED_DASHBOARD_URL",
];
const REQUIRED_NOTIFICATION_SECRET_ENV_VARS = [
  "NOTIFICATION_HASH_SECRET",
  "NOTIFICATION_ENCRYPTION_KEY",
];
const REQUIRED_PROVIDER_ENV_VARS = [
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
];
const REQUIRED_WEB_PUSH_ENV_VARS = [
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_CONTACT",
];
const REQUIRED_DEPLOY_ENV_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "INTERNAL_ALERT_TOKEN",
  "EWS_PUBLIC_URL",
  ...REQUIRED_PROVIDER_ENV_VARS,
  ...REQUIRED_WEB_PUSH_ENV_VARS,
  "SENDGRID_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_WEBHOOK_URL",
  "EWS_ALERT_EVENTS_WEBHOOK_URL",
  "EWS_SMOKE_TEST_EMAIL",
  "EWS_SMOKE_TEST_PHONE",
  ...REQUIRED_DASHBOARD_ENV_VARS,
  ...REQUIRED_NOTIFICATION_SECRET_ENV_VARS,
];
const REQUIRED_WRANGLER_VARS = [
  "EWS_PUBLIC_URL",
  "APP_BASE_URL",
  "EWS_NOTIFICATION_URL",
];
const SERVICE_ENV_PATH = "/etc/apocalypse-ews.env";
const PROJECT_ENV_PATH = path.join(REPO_ROOT, ".env");
const WRANGLER_CONFIG_PATH = path.join(REPO_ROOT, "wrangler.toml");
const MAINTENANCE_WRANGLER_CONFIG_PATH = path.join(REPO_ROOT, "wrangler.maintenance.toml");
const DEFAULT_DEPLOY_ENV_FILES = [SERVICE_ENV_PATH, PROJECT_ENV_PATH];

function parseDotEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function readDotEnvFile(filePath = PROJECT_ENV_PATH) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  const env = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith("#")) {
      continue;
    }

    env[match[1]] = parseDotEnvValue(match[2]);
  }

  return env;
}

function readDotEnvFiles(filePaths = DEFAULT_DEPLOY_ENV_FILES) {
  const env = {};
  for (const filePath of filePaths) {
    const fileEnv = readDotEnvFile(filePath);
    for (const [key, value] of Object.entries(fileEnv)) {
      if (env[key] === undefined) {
        env[key] = value;
      }
    }
  }
  return env;
}

function getDeployEnvFiles(extraEnvFiles = []) {
  return [...extraEnvFiles.filter(Boolean), ...DEFAULT_DEPLOY_ENV_FILES];
}

function derivePublicPathUrl(env, pathname) {
  const baseUrl = String(env.APP_BASE_URL || env.EWS_PUBLIC_URL || "").trim();
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    return "";
  }
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function withDerivedDeployEnv(env) {
  const derivedEnv = { ...env };
  if (!derivedEnv.SENDGRID_WEBHOOK_URL) {
    derivedEnv.SENDGRID_WEBHOOK_URL = derivePublicPathUrl(derivedEnv, "/api/sendgrid/webhook");
  }
  if (!derivedEnv.EWS_ALERT_EVENTS_WEBHOOK_URL) {
    derivedEnv.EWS_ALERT_EVENTS_WEBHOOK_URL = derivePublicPathUrl(derivedEnv, "/api/internal/alert-events");
  }
  return derivedEnv;
}


function getEnvWithDotEnv(baseEnv = process.env, options = {}) {
  const envFiles = options.envFiles || getDeployEnvFiles(options.extraEnvFiles || []);
  return withDerivedDeployEnv({
    ...readDotEnvFiles(envFiles),
    ...baseEnv,
  });
}

function validateDashboardUrl(name, value) {
  if (!value) {
    return `${name} is missing.`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return `${name} must be an absolute URL.`;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${name} must use http or https.`;
  }

  if (!url.pathname.endsWith(".json")) {
    return `${name} must point at a .json snapshot.`;
  }

  return null;
}

function validatePublicUrl(name, value) {
  if (!value) {
    return `${name} is missing.`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return `${name} must be an absolute URL.`;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${name} must use http or https.`;
  }

  if (/^(?:127\.0\.0\.1|localhost)$/i.test(url.hostname)) {
    return `${name} must be a public URL, not localhost.`;
  }

  return null;
}

function validateHttpsPublicUrl(name, value) {
  const publicUrlError = validatePublicUrl(name, value);
  if (publicUrlError) {
    return publicUrlError;
  }

  const url = new URL(value);
  if (url.protocol !== "https:") {
    return `${name} must use https.`;
  }

  return null;
}

function validateAlertEventsWebhookUrl(value) {
  const urlError = validateHttpsPublicUrl("EWS_ALERT_EVENTS_WEBHOOK_URL", value);
  if (urlError) {
    return urlError;
  }

  const url = new URL(value);
  if (url.pathname !== "/api/internal/alert-events") {
    return "EWS_ALERT_EVENTS_WEBHOOK_URL must point at /api/internal/alert-events.";
  }

  return null;
}
function validateSendGridWebhookUrl(value) {
  const urlError = validateHttpsPublicUrl("SENDGRID_WEBHOOK_URL", value);
  if (urlError) {
    return urlError;
  }

  const url = new URL(value);
  if (url.pathname !== "/api/sendgrid/webhook") {
    return "SENDGRID_WEBHOOK_URL must point at /api/sendgrid/webhook.";
  }

  return null;
}


function validateNotificationEncryptionKey(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).trim();
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return "NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.";
  }

  if (Buffer.from(normalized, "base64").length !== 32) {
    return "NOTIFICATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key.";
  }

  return null;
}

function decodeBase64Url(value) {
  const normalized = String(value || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function validateBase64UrlKey(name, value, byteLength, { firstByte = null } = {}) {
  if (!value) {
    return null;
  }
  const normalized = String(value).trim();
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(normalized)) {
    return `${name} must be base64url encoded.`;
  }
  const bytes = decodeBase64Url(normalized);
  if (bytes.length !== byteLength) {
    return `${name} must decode to ${byteLength} bytes.`;
  }
  if (firstByte !== null && bytes[0] !== firstByte) {
    return `${name} must be an uncompressed P-256 public key.`;
  }
  return null;
}

function validateWebPushContact(value) {
  if (!value) {
    return null;
  }
  const contact = String(value).trim();
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(contact) && !/^https:\/\//i.test(contact)) {
    return "WEB_PUSH_CONTACT must be a mailto: address or https URL.";
  }
  return null;
}


function getTomlString(block, key) {
  const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match ? match[1].trim() : "";
}

function getD1DatabaseBlock(configText) {
  const blocks = configText.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g) || [];
  return blocks.find((block) => getTomlString(block, "binding") === "EWS_NOTIFY_DB") || "";
}

function tomlString(value) {
  return JSON.stringify(String(value || ""));
}

function ensureWranglerConfig(env = process.env, filePath = WRANGLER_CONFIG_PATH) {
  if (fs.existsSync(filePath)) {
    return false;
  }

  if (!fs.existsSync(MAINTENANCE_WRANGLER_CONFIG_PATH)) {
    return false;
  }

  const maintenanceText = fs.readFileSync(MAINTENANCE_WRANGLER_CONFIG_PATH, "utf8");
  const d1Block = getD1DatabaseBlock(maintenanceText);
  const databaseName = getTomlString(d1Block, "database_name");
  const databaseId = getTomlString(d1Block, "database_id");
  if (!databaseName || !databaseId || databaseId === "replace-with-cloudflare-d1-database-id") {
    return false;
  }

  const ewsPublicUrl = env.EWS_PUBLIC_URL || "https://ews.kylemcdonald.net/";
  const appBaseUrl = env.APP_BASE_URL || "https://ews.kylemcdonald.net";
  const notificationUrl = env.EWS_NOTIFICATION_URL || appBaseUrl;
  const configText = [
    'name = "apocalypse-ews"',
    'compatibility_date = "2026-05-05"',
    'pages_build_output_dir = "dist"',
    "",
    "[vars]",
    `EWS_PUBLIC_URL = ${tomlString(ewsPublicUrl)}`,
    `APP_BASE_URL = ${tomlString(appBaseUrl)}`,
    `EWS_NOTIFICATION_URL = ${tomlString(notificationUrl)}`,
    "",
    "[[d1_databases]]",
    'binding = "EWS_NOTIFY_DB"',
    `database_name = ${tomlString(databaseName)}`,
    `database_id = ${tomlString(databaseId)}`,
    'migrations_dir = "migrations"',
    "",
  ].join("\n");

  fs.writeFileSync(filePath, configText);
  return true;
}

function validateWranglerConfig(filePath = WRANGLER_CONFIG_PATH) {
  const errors = [];
  let d1DatabaseName = "";

  const vars = {};

  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      d1DatabaseName,
      errors: ["wrangler.toml is required for Pages deploys; copy wrangler.example.toml and set the D1 database_id."],
    };
  }

  const configText = fs.readFileSync(filePath, "utf8");
  for (const name of REQUIRED_WRANGLER_VARS) {
    const value = getTomlString(configText, name);
    vars[name] = value;
    if (!value) {
      errors.push(`wrangler.toml [vars] must set ${name}.`);
      continue;
    }
    if (/replace-with/i.test(value)) {
      errors.push(`wrangler.toml [vars] ${name} must not use a placeholder URL.`);
      continue;
    }
    const publicUrlError = validatePublicUrl(`wrangler.toml [vars] ${name}`, value);
    if (publicUrlError) {
      errors.push(publicUrlError);
    }
  }
  const d1Block = getD1DatabaseBlock(configText);
  if (!d1Block) {
    errors.push("wrangler.toml must bind the EWS_NOTIFY_DB D1 database.");
  } else {
    d1DatabaseName = getTomlString(d1Block, "database_name");
    const databaseId = getTomlString(d1Block, "database_id");
    const migrationsDir = getTomlString(d1Block, "migrations_dir") || "migrations";
    const migrationsPath = path.resolve(path.dirname(filePath), migrationsDir);

    if (!d1DatabaseName) {
      errors.push("wrangler.toml EWS_NOTIFY_DB must set database_name.");
    }
    if (!databaseId || databaseId === "replace-with-cloudflare-d1-database-id") {
      errors.push("wrangler.toml EWS_NOTIFY_DB must set a real database_id.");
    }
    if (!fs.existsSync(migrationsPath)) {
      errors.push(`wrangler.toml migrations_dir does not exist: ${migrationsDir}.`);
    } else {
      const migrationFiles = fs.readdirSync(migrationsPath).filter((fileName) => fileName.endsWith(".sql"));
      if (!migrationFiles.length) {
        errors.push(`wrangler.toml migrations_dir has no SQL migrations: ${migrationsDir}.`);
      }
    }
  }

  return { ok: errors.length === 0, d1DatabaseName, vars, errors };
}

function validateMaintenanceWranglerConfig(filePath = MAINTENANCE_WRANGLER_CONFIG_PATH) {
  const errors = [];
  let d1DatabaseName = "";
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      d1DatabaseName,
      errors: ["wrangler.maintenance.toml is required to resume queued alert fanout."],
    };
  }

  const configText = fs.readFileSync(filePath, "utf8");
  if (!getTomlString(configText, "name")) {
    errors.push("wrangler.maintenance.toml must set name.");
  }
  if (getTomlString(configText, "main") !== "workers/notification-maintenance.js") {
    errors.push("wrangler.maintenance.toml main must be workers/notification-maintenance.js.");
  }
  if (!/\bcrons\s*=\s*\[[^\]]+\]/.test(configText)) {
    errors.push("wrangler.maintenance.toml must configure a scheduled cron trigger.");
  }

  const d1Block = getD1DatabaseBlock(configText);
  if (!d1Block) {
    errors.push("wrangler.maintenance.toml must bind the EWS_NOTIFY_DB D1 database.");
  } else {
    d1DatabaseName = getTomlString(d1Block, "database_name");
    const databaseId = getTomlString(d1Block, "database_id");
    if (!d1DatabaseName) {
      errors.push("wrangler.maintenance.toml EWS_NOTIFY_DB must set database_name.");
    }
    if (!databaseId || databaseId === "replace-with-cloudflare-d1-database-id") {
      errors.push("wrangler.maintenance.toml EWS_NOTIFY_DB must set a real database_id.");
    }
  }

  return { ok: errors.length === 0, d1DatabaseName, errors };
}




function validateDashboardEnv(env) {
  return REQUIRED_DASHBOARD_ENV_VARS
    .map((name) => validateDashboardUrl(name, env[name]))
    .filter(Boolean);
}

function validateDeployEnv(env) {
  const missingNames = new Set(REQUIRED_DEPLOY_ENV_VARS.filter((name) => !env[name]));
  const missing = Array.from(missingNames).map((name) => `${name} is missing.`);

  const publicUrlError = missingNames.has("EWS_PUBLIC_URL") ? null : validatePublicUrl("EWS_PUBLIC_URL", env.EWS_PUBLIC_URL);

  const telnyxSenderConfigured =
    Boolean(env.TELNYX_NUMBER) || Boolean(env.TELNYX_FROM_PHONE) || Boolean(env.TELNYX_MESSAGING_PROFILE_ID);
  return [
    ...missing,
    publicUrlError,
    missingNames.has("EWS_ALERT_EVENTS_WEBHOOK_URL")
      ? null
      : validateAlertEventsWebhookUrl(env.EWS_ALERT_EVENTS_WEBHOOK_URL),
    missingNames.has("SENDGRID_WEBHOOK_URL")
      ? null
      : validateSendGridWebhookUrl(env.SENDGRID_WEBHOOK_URL),
    missingNames.has("NOTIFICATION_ENCRYPTION_KEY")
      ? null
      : validateNotificationEncryptionKey(env.NOTIFICATION_ENCRYPTION_KEY),
    missingNames.has("WEB_PUSH_VAPID_PUBLIC_KEY")
      ? null
      : validateBase64UrlKey("WEB_PUSH_VAPID_PUBLIC_KEY", env.WEB_PUSH_VAPID_PUBLIC_KEY, 65, { firstByte: 4 }),
    missingNames.has("WEB_PUSH_VAPID_PRIVATE_KEY")
      ? null
      : validateBase64UrlKey("WEB_PUSH_VAPID_PRIVATE_KEY", env.WEB_PUSH_VAPID_PRIVATE_KEY, 32),
    missingNames.has("WEB_PUSH_CONTACT") ? null : validateWebPushContact(env.WEB_PUSH_CONTACT),
    telnyxSenderConfigured
      ? null
      : "One of TELNYX_NUMBER, TELNYX_FROM_PHONE, or TELNYX_MESSAGING_PROFILE_ID is required.",
    ...validateDashboardEnv(env).filter((error) => {
      const name = error.split(" ")[0];
      return !missingNames.has(name);
    }),
  ].filter(Boolean);
}

module.exports = {
  REPO_ROOT,
  REQUIRED_DASHBOARD_ENV_VARS,
  REQUIRED_DEPLOY_ENV_VARS,
  SERVICE_ENV_PATH,
  PROJECT_ENV_PATH,
  WRANGLER_CONFIG_PATH,
  MAINTENANCE_WRANGLER_CONFIG_PATH,
  DEFAULT_DEPLOY_ENV_FILES,
  getDeployEnvFiles,
  getEnvWithDotEnv,
  readDotEnvFile,
  readDotEnvFiles,
  ensureWranglerConfig,
  validateDashboardEnv,
  validateDeployEnv,
  validateWranglerConfig,
  validateMaintenanceWranglerConfig,
};
