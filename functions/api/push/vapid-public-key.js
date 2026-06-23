import { getVapidPublicKey, isWebPushConfigured } from "../../_lib/web-push.js";
import { handleError, HttpError, jsonResponse } from "../../_lib/http.js";

export async function onRequestGet({ env }) {
  try {
    if (!isWebPushConfigured(env)) {
      throw new HttpError(503, "Browser push is not configured.");
    }
    return jsonResponse(
      {
        ok: true,
        configured: isWebPushConfigured(env),
        publicKey: getVapidPublicKey(env),
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
