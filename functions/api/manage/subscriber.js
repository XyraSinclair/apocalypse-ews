import {
  cancelManualSubscriber,
  getSubscriberById,
  hydrateSubscriberContacts,
  markStripeSubscriptionCancelAtPeriodEnd,
  updateSubscriberContactSettings,
} from "../../_lib/db.js";
import { getPhoneCountryName, isSupportedSmsPhone } from "../../_lib/contacts.js";
import { verifyAccountManagementToken } from "../../_lib/customer-portal.js";
import { handleError, HttpError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { updateStripeSubscriptionCancelAtPeriodEnd } from "../../_lib/stripe.js";

const STRIPE_BILLING_PORTAL_URL = "https://billing.stripe.com/p/login/6oU7sL14I6ewbuL2dJ4ow00";

function safelyIsSupportedSmsPhone(phone) {
  try {
    return Boolean(phone && isSupportedSmsPhone(phone));
  } catch {
    return false;
  }
}

async function loadAuthorizedSubscriber(env, subscriberId, token) {
  if (!subscriberId || !token) {
    throw new HttpError(400, "Missing account management token.");
  }

  const subscriber = await getSubscriberById(env, subscriberId);
  if (!subscriber) {
    throw new HttpError(404, "Subscriber not found.");
  }

  const tokenMatches = await verifyAccountManagementToken(env, subscriber, token);
  if (!tokenMatches) {
    throw new HttpError(403, "Invalid account management token.");
  }

  return subscriber;
}

async function mapManagedSubscriber(env, subscriber) {
  const hydrated = await hydrateSubscriberContacts(env, subscriber);
  const smsSupported = safelyIsSupportedSmsPhone(hydrated.phone);
  return {
    id: hydrated.id,
    status: hydrated.status,
    source: hydrated.source,
    accountEmail: hydrated.accountEmail,
    email: hydrated.email,
    phone: hydrated.phone,
    phoneCountry: hydrated.phoneCountry,
    phoneCountryName: getPhoneCountryName(hydrated.phoneCountry),
    smsSupported,
    wantsEmail: hydrated.wantsEmail,
    wantsSms: hydrated.wantsSms,
    currentPeriodEnd: hydrated.current_period_end,
    stripeCancelAtPeriodEnd: hydrated.stripeCancelAtPeriodEnd,
    hasStripeSubscription: Boolean(hydrated.stripe_subscription_id),
    stripeBillingPortalUrl: hydrated.stripe_subscription_id ? STRIPE_BILLING_PORTAL_URL : null,
    welcomeEmailSentAt: hydrated.welcome_email_sent_at,
    welcomeSmsSentAt: hydrated.welcome_sms_sent_at,
  };
}

async function updateRenewalPreference(env, subscriber, renewSubscription) {
  if (!subscriber.stripe_subscription_id) {
    throw new HttpError(400, "This subscriber does not have a Stripe subscription.");
  }

  const cancelAtPeriodEnd = !renewSubscription;
  const currentCancelAtPeriodEnd = Number(subscriber.stripe_cancel_at_period_end || 0) === 1;
  if (currentCancelAtPeriodEnd === cancelAtPeriodEnd) {
    return;
  }

  await updateStripeSubscriptionCancelAtPeriodEnd(env, subscriber.stripe_subscription_id, cancelAtPeriodEnd);
  await markStripeSubscriptionCancelAtPeriodEnd(env, subscriber.stripe_subscription_id, cancelAtPeriodEnd);
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const subscriber = await loadAuthorizedSubscriber(
      env,
      url.searchParams.get("subscriber") || "",
      url.searchParams.get("token") || "",
    );

    return jsonResponse(
      {
        ok: true,
        subscriber: await mapManagedSubscriber(env, subscriber),
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

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);
    const subscriber = await loadAuthorizedSubscriber(env, payload.subscriber || "", payload.token || "");
    const action = String(payload.action || "").trim();

    if (action === "save") {
      if (subscriber.status === "canceled") {
        throw new HttpError(400, "This account has been canceled.");
      }
      const updated = await updateSubscriberContactSettings(env, subscriber.id, payload);
      if (subscriber.stripe_subscription_id && typeof payload.renewSubscription === "boolean") {
        await updateRenewalPreference(env, subscriber, payload.renewSubscription);
      }
      const current = await getSubscriberById(env, updated.id);
      return jsonResponse({ ok: true, subscriber: await mapManagedSubscriber(env, current) });
    }

    if (action === "delete_account") {
      if (subscriber.source !== "manual") {
        throw new HttpError(400, "Paid subscriptions can be canceled by turning off renewal.");
      }
      await cancelManualSubscriber(env, subscriber.id);
      const updated = await getSubscriberById(env, subscriber.id);
      return jsonResponse({ ok: true, subscriber: await mapManagedSubscriber(env, updated) });
    }

    throw new HttpError(400, "Unknown account management action.");
  } catch (error) {
    return handleError(error);
  }
}
