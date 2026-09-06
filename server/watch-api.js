const { getWatchSnapshot, getIncident, reviewIncident } = require("./watch-store");

function mountWatchRoutes(app, { getDb, requireInternalAuth, getAgentConfiguration }) {
  if (typeof getDb !== "function" || typeof requireInternalAuth !== "function" || (getAgentConfiguration != null && typeof getAgentConfiguration !== "function")) throw new TypeError("Watch routes require database and authentication functions.");
  function route(internal, handler) {
    return (request, response, next) => {
      response.set("Cache-Control", "no-store");
      response.set("X-Content-Type-Options", "nosniff");
      try {
        if (internal) requireInternalAuth(request);
        const db = getDb();
        if (!db) return response.status(503).json({ error: "Watch database is not initialized." });
        return handler(request, response, db);
      } catch (error) {
        if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) return response.status(error.status).json({ error: error.message });
        if (error.status === 503) return response.status(503).json({ error: "Watch service or operator authentication is not configured." });
        // Do not leak SQL, filesystem paths, upstream payloads, or credentials.
        console.error("Watch API failed:", error.code || error.name || "Error");
        return response.status(500).json({ error: "Watch data could not be read or updated." });
      }
    };
  }
  function incidentId(request, response) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id || "")) {
      response.status(404).json({ error: "Watch incident not found." });
      return null;
    }
    return request.params.id;
  }
  function snapshot(internal) {
    return route(internal, (request, response, db) => {
      if (Object.keys(request.query).some((key) => !["limit", "status", "cursor"].includes(key))) return response.status(400).json({ error: "Unknown watch query parameter." });
      const raw = request.query.limit;
      if (raw != null && (typeof raw !== "string" || !/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > 100)) return response.status(400).json({ error: "Watch limit must be an integer from 1 to 100." });
      const value = getWatchSnapshot(db, { internal, limit: raw == null ? 40 : Number(raw), status: request.query.status ?? "all", cursor: request.query.cursor ?? null });
      if (getAgentConfiguration) {
        const config = getAgentConfiguration();
        value.agent = { configured: config.configured === true, model: typeof config.model === "string" ? config.model : null, reason: typeof config.reason === "string" ? config.reason : null };
      }
      if (!value.sources.length) return response.status(503).json({ error: "Watch source registry has not been initialized." });
      return response.json(value);
    });
  }
  function detail(internal) {
    return route(internal, (request, response, db) => {
      if (Object.keys(request.query).length) return response.status(400).json({ error: "Incident detail does not accept query parameters." });
      const id = incidentId(request, response);
      if (!id) return;
      const value = getIncident(db, id, { internal });
      return value ? response.json(value) : response.status(404).json({ error: "Watch incident not found." });
    });
  }
  app.get("/api/watch", snapshot(false));
  app.get("/api/watch/incidents/:id", detail(false));
  app.get("/api/admin/watch", snapshot(true));
  app.get("/api/admin/watch/incidents/:id", detail(true));
  app.post("/api/admin/watch/incidents/:id/review", route(true, (request, response, db) => {
    const id = incidentId(request, response);
    if (!id) return;
    const body = request.body;
    if (Object.keys(request.query).length || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["status", "note", "publishEvidence", "expectedGeneration"].includes(key)) || !["open", "resolved"].includes(body.status) || typeof body.note !== "string" || !body.note.trim() || body.note.length > 4000 || (body.publishEvidence != null && typeof body.publishEvidence !== "boolean") || (body.expectedGeneration != null && (!Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 1)) || (body.publishEvidence === true && body.expectedGeneration == null)) return response.status(400).json({ error: "Review requires a status, a private note, and a matching expectedGeneration before publishing source evidence." });
    return response.json(reviewIncident(db, id, { ...body, publishEvidence: body.publishEvidence === true }));
  }));
}

module.exports = { mountWatchRoutes };
