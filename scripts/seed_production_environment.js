#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = 'XyraSinclair/apocalypse-ews';
const ENVIRONMENT = 'production';
const DEFAULT_SECRET_FILE = path.join(process.env.HOME || process.cwd(), 'Desktop', 'ews-prod-secrets.env');

const REQUIRED_SECRETS = [
  'CLOUDFLARE_API_TOKEN',
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_WEBHOOK_PUBLIC_KEY',
  'TELNYX_API_KEY',
  'TELNYX_PUBLIC_KEY',
  'EWS_SMOKE_TEST_EMAIL',
  'EWS_SMOKE_TEST_PHONE',
];

const TELNYX_SENDER_SECRETS = [
  'TELNYX_NUMBER',
  'TELNYX_FROM_PHONE',
  'TELNYX_MESSAGING_PROFILE_ID',
];

const PRODUCTION_VARIABLES = {
  EWS_PUBLIC_URL: 'https://ews.kylemcdonald.net/',
  APP_BASE_URL: 'https://ews.kylemcdonald.net',
  EWS_NOTIFICATION_URL: 'https://ews.kylemcdonald.net',
  CLOUDFLARE_PAGES_PROJECT: 'apocalypse-ews',
  SENDGRID_FROM_NAME: 'Apocalypse EWS',
  SENDGRID_WEBHOOK_URL: 'https://ews.kylemcdonald.net/api/sendgrid/webhook',
  TELNYX_WEBHOOK_URL: 'https://ews.kylemcdonald.net/api/telnyx/webhook',
  EWS_ALERT_EVENTS_WEBHOOK_URL: 'https://ews.kylemcdonald.net/api/internal/alert-events',
  VITE_DASHBOARD_URL: 'https://ews.kylemcdonald.net/dashboard.json',
  VITE_MILITARY_DASHBOARD_URL: 'https://ews.kylemcdonald.net/military-dashboard.json',
  VITE_UNTRACKED_DASHBOARD_URL: 'https://ews.kylemcdonald.net/untracked-dashboard.json',
};

function parseArgs(argv) {
  const args = {
    file: DEFAULT_SECRET_FILE,
    dispatch: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--file') {
      args.file = argv[++index];
    } else if (value === '--dispatch') {
      args.dispatch = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  return args;
}

function parseEnvFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const env = new Map();
  const text = fs.readFileSync(resolvedPath, 'utf8');

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key) {
      env.set(key, value);
    }
  }

  return env;
}

function isFilled(value) {
  return Boolean(value && value !== '...');
}

function requireSecrets(env) {
  const missing = REQUIRED_SECRETS.filter((key) => !isFilled(env.get(key)));
  const hasTelnyxSender = TELNYX_SENDER_SECRETS.some((key) => isFilled(env.get(key)));

  if (!hasTelnyxSender) {
    missing.push(TELNYX_SENDER_SECRETS.join(' or '));
  }

  if (missing.length) {
    throw new Error(`Missing required production secret values: ${missing.join(', ')}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: 'utf8',
    stdio: options.input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function ensureProductionEnvironment() {
  run('gh', ['api', '--method', 'PUT', `repos/${REPO}/environments/${ENVIRONMENT}`, '--input', '-'], {
    input: '{}',
  });
}

function setSecret(key, value) {
  run('gh', ['secret', 'set', key, '--env', ENVIRONMENT, '--repo', REPO], {
    input: value,
  });
  console.log(`set secret ${key}`);
}

function setVariable(key, value) {
  run('gh', ['variable', 'set', key, '--env', ENVIRONMENT, '--repo', REPO, '--body', value]);
  console.log(`set variable ${key}`);
}

function main() {
  const args = parseArgs(process.argv);
  const env = parseEnvFile(args.file);
  requireSecrets(env);

  ensureProductionEnvironment();

  for (const key of REQUIRED_SECRETS) {
    setSecret(key, env.get(key));
  }
  for (const key of TELNYX_SENDER_SECRETS) {
    if (isFilled(env.get(key))) {
      setSecret(key, env.get(key));
    }
  }

  for (const [key, value] of Object.entries(PRODUCTION_VARIABLES)) {
    setVariable(key, value);
  }

  if (args.dispatch) {
    run('gh', ['workflow', 'run', 'Deploy Cloudflare Pages', '--repo', REPO]);
    console.log('dispatched Deploy Cloudflare Pages');
  } else {
    console.log('production environment seeded; rerun with --dispatch to start deployment');
  }
}

main();
