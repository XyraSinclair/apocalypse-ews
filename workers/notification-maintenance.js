import { anonymizeExpiredPendingSignups } from "../functions/_lib/db.js";
import { continueAlertFanoutBatch } from "../functions/_lib/notifications.js";

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(anonymizeExpiredPendingSignups(env));
    ctx.waitUntil(continueAlertFanoutBatch(env));
  },

  async fetch() {
    return new Response("Not found.", {
      status: 404,
      headers: {
        "cache-control": "no-store",
      },
    });
  },
};
