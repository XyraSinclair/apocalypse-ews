import { normalizeSignupContacts } from "../../_lib/contacts.js";
import { createPublicSubscriber } from "../../_lib/db.js";
import { handleError, jsonResponse, getRequestIp, getRequestUserAgent, readJsonRequest } from "../../_lib/http.js";
import { sendSignupConfirmationToSubscriber } from "../../_lib/notifications.js";

function mapPublicSubscriber(subscriber) {
  return {
    id: subscriber.id,
    emailEnabled: Boolean(subscriber.wantsEmail),
    smsEnabled: Boolean(subscriber.wantsSms),
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const payload = await readJsonRequest(request);
    const contacts = normalizeSignupContacts(payload);
    const subscriber = await createPublicSubscriber(env, contacts, {
      ip: getRequestIp(request),
      userAgent: getRequestUserAgent(request),
    });
    const signupConfirmation = await sendSignupConfirmationToSubscriber(env, subscriber.id, {
      source: "public_signup",
      skipAlreadySent: true,
    });

    return jsonResponse({
      ok: true,
      subscriber: mapPublicSubscriber(subscriber),
      emailEnabled: Boolean(subscriber.wantsEmail),
      smsEnabled: Boolean(subscriber.wantsSms),
      managementPath: null,
      signupConfirmation,
    });
  } catch (error) {
    return handleError(error);
  }
}
