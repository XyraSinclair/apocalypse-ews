import { unsubscribeWebPushSubscriber, upsertWebPushSubscriber } from "../../_lib/db.js";
import { getRequestUserAgent, handleError, HttpError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { getVapidPublicKey, isWebPushConfigured } from "../../_lib/web-push.js";

export async function onRequestPost({ request, env }) {
  try {
    if (!isWebPushConfigured(env)) {
      throw new HttpError(503, "Browser push is not configured.");
    }
    getVapidPublicKey(env);
    const payload = await readJsonRequest(request);
    const subscriber = await upsertWebPushSubscriber(env, payload, {
      userAgent: getRequestUserAgent(request),
    });
    return jsonResponse({
      ok: true,
      pushEnabled: true,
      subscriber,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function onRequestDelete({ request, env }) {
  try {
    if (!isWebPushConfigured(env)) {
      throw new HttpError(503, "Browser push is not configured.");
    }
    getVapidPublicKey(env);
    const payload = await readJsonRequest(request);
    const result = await unsubscribeWebPushSubscriber(env, payload);
    return jsonResponse({
      ok: true,
      ...result,
    });
  } catch (error) {
    return handleError(error);
  }
}
