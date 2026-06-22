const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const REQUIRED_DASHBOARD_ENV_VARS = [
  "VITE_DASHBOARD_URL",
  "VITE_MILITARY_DASHBOARD_URL",
  "VITE_UNTRACKED_DASHBOARD_URL",
];
const REQUIRED_DEPLOY_ENV_VARS = [
  "CLOUDFLARE_API_TOKEN",
  ...REQUIRED_DASHBOARD_ENV_VARS,
];

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

function readDotEnvFile(filePath = path.join(REPO_ROOT, ".env")) {
  if (!fs.existsSync(filePath)) {
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

function getEnvWithDotEnv(baseEnv = process.env) {
  return {
    ...readDotEnvFile(),
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

function validateDashboardEnv(env) {
  return REQUIRED_DASHBOARD_ENV_VARS
    .map((name) => validateDashboardUrl(name, env[name]))
    .filter(Boolean);
}

function validateDeployEnv(env) {
  const missingNames = new Set(REQUIRED_DEPLOY_ENV_VARS.filter((name) => !env[name]));
  const missing = Array.from(missingNames).map((name) => `${name} is missing.`);

  return [
    ...missing,
    ...validateDashboardEnv(env).filter((error) => {
      const name = error.split(" ")[0];
      return !missingNames.has(name);
    }),
  ];
}

module.exports = {
  REPO_ROOT,
  REQUIRED_DASHBOARD_ENV_VARS,
  REQUIRED_DEPLOY_ENV_VARS,
  getEnvWithDotEnv,
  validateDashboardEnv,
  validateDeployEnv,
};
