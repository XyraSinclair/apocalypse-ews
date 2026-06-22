import { HttpError } from "./http.js";

export function requireInternalAuth(request, env) {
  const expectedToken = String(env.INTERNAL_ALERT_TOKEN || "").trim();
  if (!expectedToken) {
    throw new HttpError(500, "Missing required secret: INTERNAL_ALERT_TOKEN.");
  }

  const authorization = request.headers.get("authorization") || "";
  if (authorization !== `Bearer ${expectedToken}`) {
    throw new HttpError(401, "Unauthorized.");
  }
}
