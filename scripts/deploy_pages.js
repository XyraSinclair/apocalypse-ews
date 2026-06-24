const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  REPO_ROOT,
  REQUIRED_DEPLOY_ENV_VARS,
  getEnvWithDotEnv,
  ensureWranglerConfig,
  validateDeployEnv,
  validateMaintenanceWranglerConfig,
  validateWranglerConfig,
  validateSharedD1Binding,
} = require("./_deploy_env");
const { REQUIRED_PUBLISHED_ASSETS, copyPublishedAssets } = require("./copy_published_assets");

const env = getEnvWithDotEnv();
const publicUrl = env.EWS_PUBLIC_URL || "https://ews.kylemcdonald.net/";
const projectName = env.CLOUDFLARE_PAGES_PROJECT || "apocalypse-ews";
const distDir = path.join(REPO_ROOT, "dist");
const MAINTENANCE_WORKER_SECRET_NAMES = [
  "APP_BASE_URL",
  "EWS_PUBLIC_URL",
  "EWS_NOTIFICATION_URL",
  "NOTIFICATION_HASH_SECRET",
  "NOTIFICATION_ENCRYPTION_KEY",
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_CONTACT",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_WEBHOOK_URL",
  "TELNYX_API_KEY",
  "TELNYX_NUMBER",
  "TELNYX_FROM_PHONE",
  "TELNYX_MESSAGING_PROFILE_ID",
  "TELNYX_WEBHOOK_URL",
  "TELNYX_WEBHOOK_FAILOVER_URL",
];
const PAGES_FUNCTION_SECRET_NAMES = [
  "INTERNAL_ALERT_TOKEN",
  "NOTIFICATION_HASH_SECRET",
  "NOTIFICATION_ENCRYPTION_KEY",
  "WEB_PUSH_VAPID_PUBLIC_KEY",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
  "WEB_PUSH_CONTACT",
  "SENDGRID_API_KEY",
  "SENDGRID_FROM_EMAIL",
  "SENDGRID_FROM_NAME",
  "SENDGRID_WEBHOOK_PUBLIC_KEY",
  "SENDGRID_WEBHOOK_URL",
  "TELNYX_API_KEY",
  "TELNYX_PUBLIC_KEY",
  "TELNYX_NUMBER",
  "TELNYX_FROM_PHONE",
  "TELNYX_MESSAGING_PROFILE_ID",
  "TELNYX_WEBHOOK_URL",
  "TELNYX_WEBHOOK_FAILOVER_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRODUCT_ID",
  "STRIPE_PRICE_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL",
];


function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getPagesPipelineSmokeArgs(targetPublicUrl) {
  return ["run", "smoke:pages-pipeline", "--", targetPublicUrl, "--require-providers", "--require-test-delivery"];
}

function getMissingPublishedAssets() {
  const publishedDir = path.join(REPO_ROOT, "data", "published");
  if (!fs.existsSync(publishedDir)) {
    return [...REQUIRED_PUBLISHED_ASSETS];
  }
  const available = new Set(
    fs
      .readdirSync(publishedDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );
  return REQUIRED_PUBLISHED_ASSETS.filter((fileName) => !available.has(fileName));
}

function ensurePublishedAssets() {
  const missingAssets = getMissingPublishedAssets();
  if (!missingAssets.length) {
    return;
  }
  console.log(`Published data missing ${missingAssets.join(", ")}; refreshing live snapshots before build.`);
  run("npm", ["run", "refresh:all", "--", "--skip-alerts"]);
}


function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function getCommitHash() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return undefined;
  }

  return result.stdout.trim();
}


function applyD1Migrations(databaseName) {
  run("npx", ["wrangler", "d1", "migrations", "apply", databaseName, "--remote"]);
}

function deployMaintenanceWorker() {
  run("npx", ["wrangler", "deploy", "--config", "wrangler.maintenance.toml"]);
}

function putMaintenanceWorkerSecret(name, value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return;
  }
  console.log(`$ npx wrangler secret put ${name} --config wrangler.maintenance.toml`);
  const result = spawnSync("npx", ["wrangler", "secret", "put", name, "--config", "wrangler.maintenance.toml"], {
    cwd: REPO_ROOT,
    env,
    input: `${normalizedValue}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function configureMaintenanceWorkerSecrets(targetPublicUrl) {
  const derivedEnv = {
    ...env,
    EWS_PUBLIC_URL: env.EWS_PUBLIC_URL || targetPublicUrl,
    APP_BASE_URL: env.APP_BASE_URL || targetPublicUrl,
    EWS_NOTIFICATION_URL: env.EWS_NOTIFICATION_URL || targetPublicUrl,
  };
  for (const name of MAINTENANCE_WORKER_SECRET_NAMES) {
    putMaintenanceWorkerSecret(name, derivedEnv[name]);
  }
}

function putPagesFunctionSecret(projectName, name, value) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return;
  }
  console.log(`$ npx wrangler pages secret put ${name} --project-name ${projectName}`);
  const result = spawnSync("npx", ["wrangler", "pages", "secret", "put", name, "--project-name", projectName], {
    cwd: REPO_ROOT,
    env,
    input: `${normalizedValue}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function configurePagesFunctionSecrets(projectName) {
  for (const name of PAGES_FUNCTION_SECRET_NAMES) {
    putPagesFunctionSecret(projectName, name, env[name]);
  }
}


async function restoreCurrentRss(targetPublicUrl) {
  const rssUrl = env.EWS_RSS_URL || new URL("/rss.xml", targetPublicUrl).toString();
  const response = await fetch(rssUrl);
  if (!response.ok) {
    throw new Error(`Unable to restore current RSS feed from ${rssUrl}: ${response.status}`);
  }

  const rssXml = await response.text();
  const rssPath = path.join(distDir, "rss.xml");
  fs.mkdirSync(path.dirname(rssPath), { recursive: true });
  fs.writeFileSync(rssPath, rssXml);
  console.log(`Restored current RSS feed from ${rssUrl}.`);
}

async function main() {
  ensureWranglerConfig(env);
  const wrangler = validateWranglerConfig();
  const maintenanceWrangler = validateMaintenanceWranglerConfig();
  const errors = [
    ...validateDeployEnv(env),
    ...wrangler.errors,
    ...maintenanceWrangler.errors,
    ...validateSharedD1Binding(wrangler, maintenanceWrangler),
  ];
  const wranglerPublicUrl = normalizeBaseUrl(wrangler.vars?.EWS_PUBLIC_URL || "");
  const localPublicUrl = normalizeBaseUrl(publicUrl);
  if (wranglerPublicUrl && localPublicUrl && wranglerPublicUrl !== localPublicUrl) {
    errors.push(`EWS_PUBLIC_URL (${localPublicUrl}) must match wrangler.toml [vars] EWS_PUBLIC_URL (${wranglerPublicUrl}).`);
  }
  for (const name of REQUIRED_DEPLOY_ENV_VARS) {
    console.log(`${name}=${env[name] ? "set" : "missing"}`);
  }
  console.log(`wrangler.maintenance.toml=${maintenanceWrangler.ok ? "ready" : "incomplete"}`);

  if (errors.length) {
    console.error("Refusing to deploy because required deployment environment is incomplete:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const smokePublicUrl = wranglerPublicUrl || localPublicUrl;
  ensurePublishedAssets();
  run("npm", ["run", "build"]);
  copyPublishedAssets();
  await restoreCurrentRss(smokePublicUrl);
  run("npm", ["run", "verify:dashboard-urls"]);
  applyD1Migrations(wrangler.d1DatabaseName);
  deployMaintenanceWorker();
  configureMaintenanceWorkerSecrets(smokePublicUrl);

  const deployArgs = [
    "wrangler",
    "pages",
    "deploy",
    "dist",
    "--project-name",
    projectName,
    "--branch",
    "main",
  ];
  const commitHash = getCommitHash();
  if (commitHash) {
    deployArgs.push("--commit-hash", commitHash);
  }

  configurePagesFunctionSecrets(projectName);
  run("npx", deployArgs);
  run("npm", ["run", "smoke:live", "--", smokePublicUrl]);
  run("npm", getPagesPipelineSmokeArgs(smokePublicUrl));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  MAINTENANCE_WORKER_SECRET_NAMES,
  PAGES_FUNCTION_SECRET_NAMES,
  getPagesPipelineSmokeArgs,
};
