const {
  REQUIRED_DEPLOY_ENV_VARS,
  getEnvWithDotEnv,
  validateDeployEnv,
  validateWranglerConfig,
} = require("./_deploy_env");

const env = getEnvWithDotEnv();
const envErrors = validateDeployEnv(env);
const wrangler = validateWranglerConfig();
const errors = [...envErrors, ...wrangler.errors];

for (const name of REQUIRED_DEPLOY_ENV_VARS) {
  console.log(`${name}=${env[name] ? "set" : "missing"}`);
}

console.log(`wrangler.toml=${wrangler.ok ? "ready" : "incomplete"}`);
console.log(`EWS_NOTIFY_DB=${wrangler.d1DatabaseName ? wrangler.d1DatabaseName : "missing"}`);

if (errors.length) {
  console.error("Deployment environment is incomplete:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}
