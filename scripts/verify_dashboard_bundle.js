const fs = require("node:fs");
const path = require("node:path");
const {
  REPO_ROOT,
  REQUIRED_DASHBOARD_ENV_VARS,
  getEnvWithDotEnv,
  validateDashboardEnv,
} = require("./_deploy_env");

const env = getEnvWithDotEnv();
const errors = validateDashboardEnv(env);
const distAssetsDir = path.join(REPO_ROOT, "client", "dist", "assets");

if (!fs.existsSync(distAssetsDir)) {
  errors.push(`Built assets directory does not exist: ${distAssetsDir}`);
}

const jsFiles = fs.existsSync(distAssetsDir)
  ? fs.readdirSync(distAssetsDir)
      .filter((fileName) => fileName.endsWith(".js"))
      .map((fileName) => path.join(distAssetsDir, fileName))
  : [];

if (!jsFiles.length) {
  errors.push("No built JavaScript assets were found.");
}

const bundleText = jsFiles
  .map((filePath) => fs.readFileSync(filePath, "utf8"))
  .join("\n");

for (const name of REQUIRED_DASHBOARD_ENV_VARS) {
  const value = env[name];
  if (value && !bundleText.includes(value)) {
    errors.push(`Built bundle does not contain ${name}.`);
  }
}

const fallbackMatch = bundleText.match(/(["'`])\/(?:dashboard|military-dashboard|untracked-dashboard)\.json\1/);
if (fallbackMatch) {
  errors.push(`Built bundle still contains a root-relative dashboard fallback: ${fallbackMatch[0]}`);
}

if (errors.length) {
  console.error("Dashboard bundle verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Dashboard bundle verification passed.");
