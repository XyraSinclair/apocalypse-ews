const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  REPO_ROOT,
  REQUIRED_DEPLOY_ENV_VARS,
  getEnvWithDotEnv,
  validateDeployEnv,
  validateWranglerConfig,
} = require("./_deploy_env");

const env = getEnvWithDotEnv();
const publicUrl = env.EWS_PUBLIC_URL || "https://ews.kylemcdonald.net/";
const projectName = env.CLOUDFLARE_PAGES_PROJECT || "apocalypse-ews";
const distDir = path.join(REPO_ROOT, "dist");
const publishedDir = path.join(REPO_ROOT, "data", "published");


function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
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

function copyPublishedAssets() {
  if (!fs.existsSync(publishedDir)) {
    throw new Error(`Published data directory does not exist: ${publishedDir}`);
  }
  fs.mkdirSync(distDir, { recursive: true });
  for (const fileName of fs.readdirSync(publishedDir)) {
    if (!fileName.endsWith(".json")) {
      continue;
    }
    fs.copyFileSync(path.join(publishedDir, fileName), path.join(distDir, fileName));
  }
  console.log(`Copied published JSON assets into ${distDir}.`);
}

function applyD1Migrations(databaseName) {
  run("npx", ["wrangler", "d1", "migrations", "apply", databaseName, "--remote"]);
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
  const wrangler = validateWranglerConfig();
  const errors = [...validateDeployEnv(env), ...wrangler.errors];
  const wranglerPublicUrl = normalizeBaseUrl(wrangler.vars?.EWS_PUBLIC_URL || "");
  const localPublicUrl = normalizeBaseUrl(publicUrl);
  if (wranglerPublicUrl && localPublicUrl && wranglerPublicUrl !== localPublicUrl) {
    errors.push(`EWS_PUBLIC_URL (${localPublicUrl}) must match wrangler.toml [vars] EWS_PUBLIC_URL (${wranglerPublicUrl}).`);
  }
  for (const name of REQUIRED_DEPLOY_ENV_VARS) {
    console.log(`${name}=${env[name] ? "set" : "missing"}`);
  }

  if (errors.length) {
    console.error("Refusing to deploy because required deployment environment is incomplete:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const smokePublicUrl = wranglerPublicUrl || localPublicUrl;
  run("npm", ["run", "build"]);
  copyPublishedAssets();
  await restoreCurrentRss(smokePublicUrl);
  run("npm", ["run", "verify:dashboard-urls"]);
  applyD1Migrations(wrangler.d1DatabaseName);

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

  run("npx", deployArgs);
  run("npm", ["run", "smoke:live", "--", smokePublicUrl]);
  run("npm", ["run", "smoke:pages-pipeline", "--", smokePublicUrl, "--require-providers"]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
