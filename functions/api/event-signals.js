import { handleError, jsonResponse } from "../_lib/http.js";
import { readPublishedJson } from "../_lib/static-assets.js";

export async function onRequestGet({ request, env }) {
  try {
    const payload = await readPublishedJson(request, env, "/event-signals.json");
    return jsonResponse(payload, {
      headers: {
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
