import { getNotificationPipelineStatus } from "../../_lib/db.js";
import { handleError, HttpError, jsonResponse } from "../../_lib/http.js";
import { requireInternalAuth } from "../../_lib/internal-auth.js";
import { readPublishedJson } from "../../_lib/static-assets.js";

function hasText(value) {
  return Boolean(String(value || "").trim());
}

function hasHttpsUrl(value) {
  return String(value || "").trim().startsWith("https://");
}

function hasTelnyxDeliveryStatusPath(env) {
  return (
    hasHttpsUrl(env.TELNYX_WEBHOOK_URL) ||
    hasHttpsUrl(env.APP_BASE_URL) ||
    hasHttpsUrl(env.EWS_PUBLIC_URL)
  );
}

function hasSendGridDeliveryStatusPath(env) {
  return (
    hasHttpsUrl(env.SENDGRID_WEBHOOK_URL) ||
    hasHttpsUrl(env.APP_BASE_URL) ||
    hasHttpsUrl(env.EWS_PUBLIC_URL)
  );
}

function hasBase64EncodedBytes(value, byteLength) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  try {
    return atob(normalized).length === byteLength;
  } catch {
    return false;
  }
}

function hasNotificationCrypto(env) {
  return hasText(env.NOTIFICATION_HASH_SECRET) && hasBase64EncodedBytes(env.NOTIFICATION_ENCRYPTION_KEY, 32);
}


function getProviderConfig(env) {
  return {
    sendgridConfigured: hasText(env.SENDGRID_API_KEY) && hasText(env.SENDGRID_FROM_EMAIL),
    sendgridWebhookVerificationConfigured: hasText(env.SENDGRID_WEBHOOK_PUBLIC_KEY),
    sendgridDeliveryStatusConfigured: hasText(env.SENDGRID_WEBHOOK_PUBLIC_KEY) && hasSendGridDeliveryStatusPath(env),
    telnyxConfigured:
      hasText(env.TELNYX_API_KEY) &&
      (hasText(env.TELNYX_NUMBER) || hasText(env.TELNYX_FROM_PHONE) || hasText(env.TELNYX_MESSAGING_PROFILE_ID)),
    telnyxWebhookVerificationConfigured: hasText(env.TELNYX_PUBLIC_KEY),
    telnyxDeliveryStatusConfigured: hasText(env.TELNYX_PUBLIC_KEY) && hasTelnyxDeliveryStatusPath(env),
    webPushConfigured:
      hasText(env.WEB_PUSH_VAPID_PUBLIC_KEY) && hasText(env.WEB_PUSH_VAPID_PRIVATE_KEY) && hasText(env.WEB_PUSH_CONTACT),
    stripeConfigured: hasText(env.STRIPE_SECRET_KEY) && hasText(env.STRIPE_WEBHOOK_SECRET) && hasText(env.STRIPE_PRICE_ID),
    telegramEmergencyConfigured: hasText(env.TELEGRAM_BOT_TOKEN) && hasText(env.TELEGRAM_CHANNEL),
  };
}

function summarizeFeedPayload(payload, itemKey) {
  if (!Array.isArray(payload[itemKey])) {
    return {
      available: false,
      error: `Published feed is missing the ${itemKey} array.`,
    };
  }

  return {
    available: true,
    generatedAt: payload.generatedAt || null,
    itemCount: payload[itemKey].length,
  };
}

function addFailure(failures, condition, code) {
  if (!condition) {
    failures.push(code);
  }
}

function buildReadinessFailures(status) {
  const failures = [];
  addFailure(failures, status.publicUrlConfigured, "missing_public_url");
  addFailure(failures, status.databaseBound, "missing_d1_binding");
  addFailure(failures, status.internalAuthConfigured, "missing_internal_alert_token");
  addFailure(failures, status.notificationCryptoConfigured, "missing_notification_crypto");
  addFailure(failures, status.alertEventBridgeAccepting, "alert_event_bridge_not_accepting");
  addFailure(failures, status.providerConfig.sendgridConfigured, "sendgrid_not_configured");
  addFailure(failures, status.providerConfig.sendgridWebhookVerificationConfigured, "sendgrid_webhook_verification_not_configured");
  addFailure(failures, status.providerConfig.sendgridDeliveryStatusConfigured, "sendgrid_delivery_status_not_configured");
  addFailure(failures, status.providerConfig.telnyxConfigured, "telnyx_not_configured");
  addFailure(failures, status.providerConfig.telnyxWebhookVerificationConfigured, "telnyx_webhook_verification_not_configured");
  addFailure(failures, status.providerConfig.telnyxDeliveryStatusConfigured, "telnyx_delivery_status_not_configured");
  addFailure(failures, status.providerConfig.webPushConfigured, "web_push_not_configured");
  addFailure(failures, status.providerConfig.stripeConfigured, "stripe_not_configured");
  addFailure(failures, status.feeds.alerts.available && Number(status.feeds.alerts.itemCount || 0) > 0, "alerts_feed_empty_or_unavailable");
  addFailure(failures, status.feeds.takeoffs.available && Number(status.feeds.takeoffs.itemCount || 0) > 0, "takeoffs_feed_empty_or_unavailable");
  addFailure(failures, status.feeds.eventSignals.available && Number(status.feeds.eventSignals.itemCount || 0) > 0, "event_signals_feed_empty_or_unavailable");
  addFailure(failures, status.notifications.available, "notifications_unavailable");
  const subscribers = status.notifications.subscribers || {};
  addFailure(failures, Number(subscribers.activeEmail || 0) > 0, "no_active_email_subscribers");
  addFailure(failures, Number(subscribers.activeSms || 0) > 0, "no_active_sms_subscribers");
  addFailure(failures, Number(subscribers.activePush || 0) > 0, "no_active_push_subscribers");
  return failures;
}

async function summarizeFeed(request, env, pathname, itemKey) {
  try {
    const payload = await readPublishedJson(request, env, pathname);
    return summarizeFeedPayload(payload, itemKey);
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        available: false,
        status: error.status,
        error: error.message,
      };
    }
    throw error;
  }
}

export async function onRequestGet({ request, env }) {
  try {
    requireInternalAuth(request, env);
    const databaseBound = Boolean(env.EWS_NOTIFY_DB);
    const internalAuthConfigured = hasText(env.INTERNAL_ALERT_TOKEN);
    const notificationCryptoConfigured = hasNotificationCrypto(env);
    const notifications = databaseBound
      ? { available: true, ...(await getNotificationPipelineStatus(env)) }
      : { available: false, reason: "missing_EWS_NOTIFY_DB" };
    const providerConfig = getProviderConfig(env);
    const publicUrlConfigured = hasHttpsUrl(env.APP_BASE_URL) || hasHttpsUrl(env.EWS_PUBLIC_URL);
    const alertEventBridgeAccepting = databaseBound && internalAuthConfigured && notificationCryptoConfigured;
    const feeds = {
      alerts: await summarizeFeed(request, env, "/alerts.json", "events"),
      takeoffs: await summarizeFeed(request, env, "/takeoffs.json", "events"),
      eventSignals: await summarizeFeed(request, env, "/event-signals.json", "records"),
    };
    const status = {
      now: new Date().toISOString(),
      publicUrlConfigured,
      databaseBound,
      internalAuthConfigured,
      notificationCryptoConfigured,
      alertEventBridgeAccepting,
      providerConfig,
      feeds,
      notifications,
    };
    const failures = buildReadinessFailures(status);

    return jsonResponse(
      {
        ok: failures.length === 0,
        readiness: {
          ok: failures.length === 0,
          failures,
        },
        ...status,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return handleError(error);
  }
}
