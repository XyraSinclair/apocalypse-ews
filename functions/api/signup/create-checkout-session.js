import { normalizeSignupContacts } from "../../_lib/contacts.js";
import { anonymizeExpiredPendingSignups, createPendingSignup, recordCheckoutSession } from "../../_lib/db.js";
import { handleError, jsonResponse, getOriginBaseUrl, getRequestIp, getRequestUserAgent, HttpError, readJsonRequest } from "../../_lib/http.js";
import {
  createCheckoutSession,
  expireOpenCheckoutSession,
  getOpenCheckoutSession,
  getStripeProductId,
  resolveStripePriceId,
} from "../../_lib/stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!String(env.STRIPE_SECRET_KEY || "").trim()) {
      throw new HttpError(503, "Stripe checkout is not configured.");
    }
    await anonymizeExpiredPendingSignups(env);
    const payload = await readJsonRequest(request);
    const contacts = normalizeSignupContacts(payload);
    const pendingSignup = await createPendingSignup(env, contacts, {
      ip: getRequestIp(request),
      userAgent: getRequestUserAgent(request),
    });
    const previousCheckoutSession = pendingSignup.previousCheckoutSessionId
      ? await getOpenCheckoutSession(env, pendingSignup.previousCheckoutSessionId)
      : null;
    if (pendingSignup.canReusePreviousCheckout) {
      if (previousCheckoutSession?.url) {
        return jsonResponse({
          ok: true,
          checkoutUrl: previousCheckoutSession.url,
          sessionId: previousCheckoutSession.id,
          reused: true,
        });
      }
    }

    const priceId = await resolveStripePriceId(env);
    const checkoutSession = await createCheckoutSession(env, {
      signupId: pendingSignup.id,
      email: pendingSignup.email,
      priceId,
      baseUrl: getOriginBaseUrl(request, env),
    });

    await recordCheckoutSession(env, pendingSignup.id, checkoutSession, priceId, getStripeProductId(env));
    if (previousCheckoutSession && pendingSignup.previousCheckoutSessionId !== checkoutSession.id) {
      try {
        await expireOpenCheckoutSession(env, pendingSignup.previousCheckoutSessionId);
      } catch (error) {
        console.error("Could not expire replaced Stripe checkout session.", error);
      }
    }

    return jsonResponse({
      ok: true,
      checkoutUrl: checkoutSession.url,
      sessionId: checkoutSession.id,
    });
  } catch (error) {
    return handleError(error);
  }
}
