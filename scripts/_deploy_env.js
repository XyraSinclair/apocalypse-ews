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
const REQUIRED_DEPLOY_ENV_VARS = [
  "CLOUDFLARE_API_TOKEN",
  "INTERNAL_ALERT_TOKEN",
  "EWS_PUBLIC_URL",
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

function getEnvWithDotEnv(baseEnv = process.env, options = {}) {
  const envFiles = options.envFiles || getDeployEnvFiles(options.extraEnvFiles || []);
  return {
    ...readDotEnvFiles(envFiles),
    ...baseEnv,
  };
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


function getTomlString(block, key) {
  const match = block.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match ? match[1].trim() : "";
}

function getD1DatabaseBlock(configText) {
  const blocks = configText.match(/\[\[d1_databases\]\][\s\S]*?(?=\n\[\[|\n\[|$)/g) || [];
  return blocks.find((block) => getTomlString(block, "binding") === "EWS_NOTIFY_DB") || "";
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




function validateDashboardEnv(env) {
  return REQUIRED_DASHBOARD_ENV_VARS
    .map((name) => validateDashboardUrl(name, env[name]))
    .filter(Boolean);
}

function validateDeployEnv(env) {
  const missingNames = new Set(REQUIRED_DEPLOY_ENV_VARS.filter((name) => !env[name]));
  const missing = Array.from(missingNames).map((name) => `${name} is missing.`);

  const publicUrlError = missingNames.has("EWS_PUBLIC_URL") ? null : validatePublicUrl("EWS_PUBLIC_URL", env.EWS_PUBLIC_URL);

  return [
    ...missing,
    publicUrlError,
    missingNames.has("NOTIFICATION_ENCRYPTION_KEY")
      ? null
      : validateNotificationEncryptionKey(env.NOTIFICATION_ENCRYPTION_KEY),
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
  DEFAULT_DEPLOY_ENV_FILES,
  getDeployEnvFiles,
  getEnvWithDotEnv,
  readDotEnvFile,
  readDotEnvFiles,
  validateDashboardEnv,
  validateDeployEnv,
  validateWranglerConfig,
};
