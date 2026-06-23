import { handleError, jsonResponse } from "../_lib/http.js";
import { readPublishedJson } from "../_lib/static-assets.js";

function limitEvents(events, rawLimit, maxLimit) {
  const limit = Math.min(Math.max(Number(rawLimit) || maxLimit, 1), maxLimit);
  return Array.isArray(events) ? events.slice(0, limit) : [];
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const payload = await readPublishedJson(request, env, "/alerts.json");
    return jsonResponse(
      {
        ...payload,
        events: limitEvents(payload.events, url.searchParams.get("limit"), 200),
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
