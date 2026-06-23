import { requireInternalAuth } from "../../_lib/internal-auth.js";
import { handleError, HttpError, jsonResponse, readJsonRequest } from "../../_lib/http.js";
import { sendAlertEventNotifications } from "../../_lib/notifications.js";

export async function onRequestPost({ request, env }) {
  try {
    requireInternalAuth(request, env);
    const payload = await readJsonRequest(request);
    const events = Array.isArray(payload.events) ? payload.events : payload.event ? [payload.event] : [];
    if (!events.length) {
      throw new HttpError(400, "Provide at least one alert event.");
    }

    const results = [];
    for (const event of events) {
      results.push(await sendAlertEventNotifications(env, event, { source: payload.source || "alert_event_bridge" }));
    }

    const ok = results.every((result) => result.ok);
    return jsonResponse({ ok, results }, { status: ok ? 200 : 502 });
  } catch (error) {
    return handleError(error);
  }
}
