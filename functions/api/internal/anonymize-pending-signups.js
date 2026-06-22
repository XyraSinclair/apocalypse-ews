import { anonymizeExpiredPendingSignups } from "../../_lib/db.js";
import { handleError, jsonResponse } from "../../_lib/http.js";
import { requireInternalAuth } from "../../_lib/internal-auth.js";

export async function onRequestPost({ request, env }) {
  try {
    requireInternalAuth(request, env);
    const result = await anonymizeExpiredPendingSignups(env);
    return jsonResponse(result, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
