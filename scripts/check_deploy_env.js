const {
  REQUIRED_DEPLOY_ENV_VARS,
  getEnvWithDotEnv,
  validateDeployEnv,
} = require("./_deploy_env");

const env = getEnvWithDotEnv();
const errors = validateDeployEnv(env);

for (const name of REQUIRED_DEPLOY_ENV_VARS) {
  console.log(`${name}=${env[name] ? "set" : "missing"}`);
}

if (errors.length) {
  console.error("Deployment environment is incomplete:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}
