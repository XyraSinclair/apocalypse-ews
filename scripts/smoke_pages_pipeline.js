#!/usr/bin/env node

const { getEnvWithDotEnv } = require('./_deploy_env');

const env = getEnvWithDotEnv();
const args = process.argv.slice(2);
const requireProviders = args.includes('--require-providers');
const positionalArgs = args.filter((arg) => !arg.startsWith('--'));
const targetUrl = normalizeBaseUrl(
  positionalArgs[0] || process.env.EWS_SMOKE_URL || env.EWS_PUBLIC_URL || 'https://ews.kylemcdonald.net/',
);
const token = String(process.env.INTERNAL_ALERT_TOKEN || env.INTERNAL_ALERT_TOKEN || '').trim();

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return { response, payload, text };
}

async function expectPublicJson(pathname, itemKey) {
  const { response, payload, text } = await readJson(`${targetUrl}${pathname}`);
  assert(response.ok, `${pathname} returned HTTP ${response.status}: ${text}`);
  const items = Array.isArray(payload?.[itemKey]) ? payload[itemKey] : null;
  assert(items, `${pathname} did not return a ${itemKey} array.`);
  return items.length;
}

async function main() {
  assert(token, 'INTERNAL_ALERT_TOKEN is required for the Pages pipeline smoke.');

  const unauthorized = await fetch(`${targetUrl}/api/admin/pipeline-status`);
  assert(unauthorized.status === 401, `Unauthenticated pipeline status returned HTTP ${unauthorized.status}, not 401.`);

  const { response, payload, text } = await readJson(`${targetUrl}/api/admin/pipeline-status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(response.ok, `Authenticated pipeline status returned HTTP ${response.status}: ${text}`);
  assert(payload?.ok === true, 'Pipeline status did not return ok=true.');
  assert(payload.databaseBound === true, 'Pipeline status reports missing EWS_NOTIFY_DB binding.');
  assert(payload.alertEventBridgeAccepting === true, 'Pipeline status reports that alert event bridge is not accepting events.');
  assert(payload.feeds?.alerts?.available === true, 'Pipeline status reports alerts feed unavailable.');
  assert(payload.feeds?.takeoffs?.available === true, 'Pipeline status reports takeoffs feed unavailable.');
  assert(payload.feeds?.eventSignals?.available === true, 'Pipeline status reports event signals feed unavailable.');
  assert(payload.notifications?.available === true, 'Pipeline status reports notifications unavailable.');

  if (requireProviders) {
    assert(payload.publicUrlConfigured === true, 'Pipeline status reports missing public URL.');
    assert(payload.providerConfig?.sendgridConfigured === true, 'Pipeline status reports SendGrid unavailable.');
    assert(payload.providerConfig?.telnyxConfigured === true, 'Pipeline status reports Telnyx unavailable.');
  }

  const alertCount = await expectPublicJson('/api/alerts?limit=1', 'events');
  const takeoffCount = await expectPublicJson('/api/takeoffs?limit=1', 'events');
  const signalCount = await expectPublicJson('/api/event-signals', 'records');

  console.log(JSON.stringify({
    ok: true,
    targetUrl,
    requireProviders,
    feeds: {
      alerts: alertCount,
      takeoffs: takeoffCount,
      eventSignals: signalCount,
    },
    subscribers: payload.notifications.subscribers,
    providers: payload.providerConfig,
  }));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
