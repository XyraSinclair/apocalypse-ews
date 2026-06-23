import { getMessagingStatus } from "../../_lib/messaging-status.js";
import { handleError, jsonResponse } from "../../_lib/http.js";
import { requireInternalAuth } from "../../_lib/internal-auth.js";

export async function onRequestGet({ request, env }) {
  try {
    requireInternalAuth(request, env);
    return jsonResponse(await getMessagingStatus(env), {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
