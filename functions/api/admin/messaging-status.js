import { getMessagingStatus } from "../../_lib/messaging-status.js";
import { handleError, jsonResponse } from "../../_lib/http.js";

export async function onRequestGet({ env }) {
  try {
    return jsonResponse(await getMessagingStatus(env), {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
