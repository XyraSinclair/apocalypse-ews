import {
  activateSubscriberFromCheckout,
  cancelPendingSubscriberByCheckout,
  cancelSubscriberBySubscription,
  updateSubscriberFromSubscription,
} from "../../_lib/db.js";
import { handleError, jsonResponse } from "../../_lib/http.js";
import { sendSignupConfirmationToSubscriber } from "../../_lib/notifications.js";
import { verifyStripeWebhook } from "../../_lib/stripe.js";

export async function onRequestPost({ request, env }) {
  try {
    const event = await verifyStripeWebhook(request, env);
    const object = event.data?.object || {};
    let signupConfirmation = null;

    if (event.type === "checkout.session.completed") {
      const subscriberId = await activateSubscriberFromCheckout(env, object);
      if (subscriberId) {
        try {
          signupConfirmation = await sendSignupConfirmationToSubscriber(env, subscriberId, {
            source: "stripe_webhook",
            skipAlreadySent: true,
          });
        } catch (error) {
          console.error("Could not send signup confirmation from Stripe webhook.", error);
          signupConfirmation = {
            ok: false,
            error: error.message,
          };
        }
      }
    } else if (event.type === "checkout.session.expired") {
      await cancelPendingSubscriberByCheckout(env, object);
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      await updateSubscriberFromSubscription(env, object);
    } else if (event.type === "customer.subscription.deleted") {
      await cancelSubscriberBySubscription(env, object);
    }

    return jsonResponse({
      received: true,
      type: event.type,
      signupConfirmation: signupConfirmation || undefined,
    });
  } catch (error) {
    return handleError(error);
  }
}
