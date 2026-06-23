import { updateDeliveryByProviderMessageId } from "../../_lib/db.js";
import { utf8String } from "../../_lib/encoding.js";
import { handleError, HttpError } from "../../_lib/http.js";
import {
  getSendGridDeliveryError,
  getSendGridProviderMessageIds,
  getSendGridProviderStatus,
  hasSendGridWebhookVerificationKey,
  normalizeSendGridEventStatus,
  sendGridWebhookResponse,
  verifySendGridWebhook,
} from "../../_lib/sendgrid.js";

function parseSendGridEvents(rawBody) {
  let events;
  try {
    events = JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, "SendGrid webhook payload is not valid JSON.");
  }

  if (!Array.isArray(events)) {
    throw new HttpError(400, "SendGrid webhook payload must be an event array.");
  }

  return events;
}

async function handleSendGridEvent(env, event) {
  const status = normalizeSendGridEventStatus(event);
  if (!status) {
    return {
      event: event.event || null,
      ignored: true,
    };
  }

  const providerStatus = getSendGridProviderStatus(event);
  const error = getSendGridDeliveryError(event);
  const messageIds = getSendGridProviderMessageIds(event);
  for (const messageId of messageIds) {
    const deliveryUpdate = await updateDeliveryByProviderMessageId(env, messageId, {
      status,
      providerStatus,
      error,
    });
    if (deliveryUpdate) {
      return {
        event: event.event || null,
        messageId,
        status,
        updated: deliveryUpdate.changed === true,
        ignoredStale: deliveryUpdate.ignored === true,
        previousStatus: deliveryUpdate.previousStatus || null,
      };
    }
  }

  return {
    event: event.event || null,
    messageId: messageIds[0] || null,
    status,
    updated: false,
  };
}

export async function onRequestPost({ request, env }) {
  try {
    const rawBodyBytes = new Uint8Array(await request.arrayBuffer());
    if (!hasSendGridWebhookVerificationKey(env)) {
      return sendGridWebhookResponse({ ignored: true, reason: "missing_sendgrid_webhook_public_key" });
    }

    await verifySendGridWebhook(request, env, rawBodyBytes);

    const events = parseSendGridEvents(utf8String(rawBodyBytes));
    const results = [];
    for (const event of events) {
      results.push(await handleSendGridEvent(env, event));
    }

    return sendGridWebhookResponse({ eventCount: events.length, results });
  } catch (error) {
    return handleError(error);
  }
}
