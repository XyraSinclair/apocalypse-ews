const {
  REQUIRED_DEPLOY_ENV_VARS,
  getDeployEnvFiles,
  getEnvWithDotEnv,
  ensureWranglerConfig,
  validateDeployEnv,
  validateWranglerConfig,
  validateMaintenanceWranglerConfig,
} = require("./_deploy_env");

function parseArgs(argv) {
  const envFiles = [];
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env-file") {
      const filePath = argv[index + 1];
      if (!filePath) {
        throw new Error("--env-file requires a path.");
      }
      envFiles.push(filePath);
      index += 1;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      envFiles.push(arg.slice("--env-file=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { envFiles };
}

const args = parseArgs(process.argv);
const env = getEnvWithDotEnv(process.env, { envFiles: getDeployEnvFiles(args.envFiles) });
ensureWranglerConfig(env);
const envErrors = validateDeployEnv(env);
const wrangler = validateWranglerConfig();
const maintenanceWrangler = validateMaintenanceWranglerConfig();
const errors = [...envErrors, ...wrangler.errors, ...maintenanceWrangler.errors];

for (const name of REQUIRED_DEPLOY_ENV_VARS) {
  console.log(`${name}=${env[name] ? "set" : "missing"}`);
}

console.log(`wrangler.toml=${wrangler.ok ? "ready" : "incomplete"}`);
console.log(`EWS_NOTIFY_DB=${wrangler.d1DatabaseName ? wrangler.d1DatabaseName : "missing"}`);
console.log(`wrangler.maintenance.toml=${maintenanceWrangler.ok ? "ready" : "incomplete"}`);
console.log(`EWS_NOTIFY_DB_MAINTENANCE=${maintenanceWrangler.d1DatabaseName ? maintenanceWrangler.d1DatabaseName : "missing"}`);

if (errors.length) {
  console.error("Deployment environment is incomplete:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
}
