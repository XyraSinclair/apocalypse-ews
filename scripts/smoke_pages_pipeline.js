#!/usr/bin/env node

const { getEnvWithDotEnv } = require('./_deploy_env');

const env = getEnvWithDotEnv();
const parsedArgs = parseArgs(process.argv.slice(2));
const requireProviders = parsedArgs.flags.has('require-providers');
const requireTestDelivery = parsedArgs.flags.has('require-test-delivery');
const targetUrl = normalizeBaseUrl(
  parsedArgs.positionals[0] || process.env.EWS_SMOKE_URL || env.EWS_PUBLIC_URL || 'https://ews.kylemcdonald.net/',
);
const token = String(process.env.INTERNAL_ALERT_TOKEN || env.INTERNAL_ALERT_TOKEN || '').trim();
const testEmail = String(parsedArgs.options.testEmail || process.env.EWS_SMOKE_TEST_EMAIL || env.EWS_SMOKE_TEST_EMAIL || '').trim();
const testPhone = String(parsedArgs.options.testPhone || process.env.EWS_SMOKE_TEST_PHONE || env.EWS_SMOKE_TEST_PHONE || '').trim();

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function parseArgs(argv) {
  const flags = new Set();
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--require-providers') {
      flags.add('require-providers');
      continue;
    }
    if (arg === '--require-test-delivery') {
      flags.add('require-test-delivery');
      continue;
    }
    if (arg === '--test-email') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--test-email requires an email address.');
      }
      options.testEmail = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--test-email=')) {
      options.testEmail = arg.slice('--test-email='.length);
      continue;
    }
    if (arg === '--test-phone') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--test-phone requires a phone number.');
      }
      options.testPhone = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--test-phone=')) {
      options.testPhone = arg.slice('--test-phone='.length);
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    positionals.push(arg);
  }
  return { flags, options, positionals };
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
const WEBHOOK_EVIDENCE_STATUSES = new Set(['sent', 'delivered', 'failed', 'undelivered', 'unconfirmed']);

function hasWebhookStatusEvidence(delivery) {
  return Boolean(
    delivery?.provider_message_id &&
      delivery?.provider_status &&
      WEBHOOK_EVIDENCE_STATUSES.has(String(delivery.delivery_status || '').trim()) &&
      delivery.delivery_created_at &&
      delivery.delivery_updated_at &&
      delivery.delivery_updated_at !== delivery.delivery_created_at,
  );
}

async function pollTestDeliveryEvidence(alertId, requestedChannels) {
  const startedAt = Date.now();
  let latestDeliveries = [];
  while (Date.now() - startedAt < 180_000) {
    const { response, payload, text } = await readJson(`${targetUrl}/api/admin/test-alert?limit=100`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert(response.ok, `Delivery history returned HTTP ${response.status}: ${text}`);
    latestDeliveries = Array.isArray(payload?.deliveries) ? payload.deliveries : [];
    const matchingDeliveries = latestDeliveries.filter((delivery) => delivery.alert_id === alertId);
    const observedChannels = new Set(
      matchingDeliveries
        .filter(hasWebhookStatusEvidence)
        .map((delivery) => delivery.channel),
    );
    if (requestedChannels.every((channel) => observedChannels.has(channel))) {
      return matchingDeliveries.filter((delivery) => requestedChannels.includes(delivery.channel));
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  const latestChannels = latestDeliveries
    .filter((delivery) => delivery.alert_id === alertId)
    .map((delivery) => `${delivery.channel}:${delivery.delivery_status}:${delivery.provider_status || 'no_provider_status'}`)
    .join(', ');
  throw new Error(`Timed out waiting for provider webhook status evidence for ${alertId}: ${latestChannels || 'no matching deliveries'}.`);
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
  const readinessFailures = Array.isArray(payload?.readiness?.failures) ? payload.readiness.failures : [];
  assert(payload?.ok === true, `Pipeline status did not return ok=true. Failures: ${readinessFailures.join(', ') || 'unknown'}.`);
  assert(readinessFailures.length === 0, `Pipeline readiness failures: ${readinessFailures.join(', ')}.`);
  assert(payload.databaseBound === true, 'Pipeline status reports missing EWS_NOTIFY_DB binding.');
  assert(payload.alertEventBridgeAccepting === true, 'Pipeline status reports that alert event bridge is not accepting events.');
  assert(payload.feeds?.alerts?.available === true, 'Pipeline status reports alerts feed unavailable.');
  assert(payload.feeds?.takeoffs?.available === true, 'Pipeline status reports takeoffs feed unavailable.');
  assert(payload.feeds?.eventSignals?.available === true, 'Pipeline status reports event signals feed unavailable.');
  assert(payload.notifications?.available === true, 'Pipeline status reports notifications unavailable.');

  const subscriberSummary = payload.notifications?.subscribers || {};
  if (requireProviders) {
    assert(payload.publicUrlConfigured === true, 'Pipeline status reports missing public URL.');
    assert(payload.providerConfig?.sendgridConfigured === true, 'Pipeline status reports SendGrid unavailable.');
    assert(
      payload.providerConfig?.sendgridWebhookVerificationConfigured === true,
      'Pipeline status reports SendGrid webhook verification unavailable.',
    );
    assert(
      payload.providerConfig?.sendgridDeliveryStatusConfigured === true,
      'Pipeline status reports SendGrid delivery status unavailable.',
    );
    assert(payload.providerConfig?.telnyxConfigured === true, 'Pipeline status reports Telnyx unavailable.');
    assert(
      payload.providerConfig?.telnyxWebhookVerificationConfigured === true,
      'Pipeline status reports Telnyx webhook verification unavailable.',
    );
    assert(
      payload.providerConfig?.telnyxDeliveryStatusConfigured === true,
      'Pipeline status reports Telnyx delivery status unavailable.',
    );
    assert(Number(subscriberSummary.activeEmail || 0) > 0, 'Pipeline status reports no active email subscribers.');
    assert(Number(subscriberSummary.activeSms || 0) > 0, 'Pipeline status reports no active SMS subscribers.');
  }

  if (requireTestDelivery && requireProviders) {
    assert(testEmail, 'A test email recipient is required: set EWS_SMOKE_TEST_EMAIL or pass --test-email.');
    assert(testPhone, 'A test SMS recipient is required: set EWS_SMOKE_TEST_PHONE or pass --test-phone.');
  } else if (requireTestDelivery) {
    assert(testEmail || testPhone, 'A test recipient is required: set EWS_SMOKE_TEST_EMAIL/EWS_SMOKE_TEST_PHONE or pass --test-email/--test-phone.');
  }

  let testDelivery = null;
  if (testEmail || testPhone) {
    const { response: testResponse, payload: testPayload, text: testText } = await readJson(`${targetUrl}/api/admin/test-alert`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: testEmail || undefined,
        phone: testPhone || undefined,
      }),
    });
    assert(testResponse.ok, `Test alert returned HTTP ${testResponse.status}: ${testText}`);
    assert(testPayload?.ok === true, `Test alert delivery failed: ${testText}`);
    if (testEmail) {
      assert(Number(testPayload.emailSentCount || 0) > 0, 'Test alert did not send an email.');
    }
    if (testPhone) {
      assert(Number(testPayload.smsSentCount || 0) > 0, 'Test alert did not send an SMS.');
    }
    if (requireTestDelivery) {
      assert(testPayload.alertId, 'Test alert did not return an alertId for webhook evidence polling.');
    }
    const requestedChannels = [
      testEmail ? 'email' : null,
      testPhone ? 'sms' : null,
    ].filter(Boolean);
    const webhookDeliveries = requireTestDelivery
      ? await pollTestDeliveryEvidence(testPayload.alertId, requestedChannels)
      : [];
    testDelivery = {
      ok: true,
      alertId: testPayload.alertId || null,
      emailSentCount: Number(testPayload.emailSentCount || 0),
      smsSentCount: Number(testPayload.smsSentCount || 0),
      errorCount: Number(testPayload.errorCount || 0),
      evidence: requireTestDelivery ? 'provider_webhook_status' : 'provider_api_acceptance',
      webhookDeliveryCount: webhookDeliveries.length,
    };
  }

  const alertCount = await expectPublicJson('/api/alerts?limit=1', 'events');
  const takeoffCount = await expectPublicJson('/api/takeoffs?limit=1', 'events');
  const signalCount = await expectPublicJson('/api/event-signals', 'records');

  console.log(JSON.stringify({
    ok: true,
    targetUrl,
    requireProviders,
    requireTestDelivery,
    feeds: {
      alerts: alertCount,
      takeoffs: takeoffCount,
      eventSignals: signalCount,
    },
    subscribers: subscriberSummary,
    providers: payload.providerConfig,
    testDelivery,
  }));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
