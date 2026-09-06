const SUPPORTED_MODEL = "google/gemini-2.5-flash-lite";
const DEFAULT_DAILY_BUDGET_NANO = 100000000;
const MAX_CALL_NANO = 24000 * 100 + 1600 * 400;
const ROLES = Object.freeze({ investigation: ["specialist", "skeptic", "synthesis"], triage: ["triage"] });

function reservationNano(kind) {
  if (!Object.hasOwn(ROLES, kind)) throw new TypeError("Unknown watch inference kind");
  return ROLES[kind].length * MAX_CALL_NANO;
}

// Provider-price estimate, not Scry's funding/settlement or a surcharge claim.
// Missing calls retain their full reservation, including after failure/expiry.
function chargeNano(kind, audit, { complete = false } = {}) {
  const reservation = reservationNano(kind);
  if (audit?.model !== SUPPORTED_MODEL || !Array.isArray(audit?.usage?.calls)) return reservation;
  const calls = audit.usage.calls;
  if (calls.length > ROLES[kind].length || calls.some((call) => !ROLES[kind].includes(call?.role))) return reservation;
  const count = (value) => Number.isSafeInteger(value) && value >= 0;
  let total = 0;
  for (const role of ROLES[kind]) {
    const matches = calls.filter((call) => call.role === role);
    const call = matches.length === 1 ? matches[0] : null;
    const usage = call?.usage;
    const input = usage?.input_tokens ?? usage?.prompt_tokens;
    const output = usage?.output_tokens ?? usage?.completion_tokens;
    const reasoning = usage?.reasoning_tokens ?? usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    // A positive prompt is required: a missing provider usage frame can report zeros.
    if (call?.model !== SUPPORTED_MODEL || call?.servedModel !== SUPPORTED_MODEL || usage?.usage_known === false || !count(input) || input === 0 || !count(output) || !count(reasoning)) {
      total += MAX_CALL_NANO;
      continue;
    }
    // OpenRouter completion_tokens includes its nested reasoning count. Scry's
    // separate reasoning count is conservatively additional unless explicitly known.
    const included = usage.reasoning_included === true || (usage.completion_tokens != null && usage.completion_tokens_details?.reasoning_tokens != null && usage.reasoning_tokens == null);
    const actual = input * 100 + (output + (included ? 0 : reasoning)) * 400;
    if (!Number.isSafeInteger(actual)) return Number.MAX_SAFE_INTEGER;
    total += actual;
  }
  // `complete` identifies the lifecycle state, not permission to forgive missing meters.
  void complete;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

module.exports = { SUPPORTED_MODEL, DEFAULT_DAILY_BUDGET_NANO, reservationNano, chargeNano };
