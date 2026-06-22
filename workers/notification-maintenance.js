import { anonymizeExpiredPendingSignups } from "../functions/_lib/db.js";

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(anonymizeExpiredPendingSignups(env));
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
