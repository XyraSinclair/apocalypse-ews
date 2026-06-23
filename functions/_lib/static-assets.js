import { HttpError } from "./http.js";

export async function readPublishedJson(request, env, pathname) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
    throw new HttpError(503, "Static asset binding is unavailable.");
  }

  const assetUrl = new URL(pathname, request.url);
  const response = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!response.ok) {
    throw new HttpError(response.status === 404 ? 404 : 502, `Could not read ${pathname}.`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) {
    throw new HttpError(502, `${pathname} is not a JSON asset.`);
  }
  return response.json();
}
