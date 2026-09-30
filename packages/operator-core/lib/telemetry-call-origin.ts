/**
 * Who CHOSE a tool call — the model, or per-turn harness automation? (EI-20267598379696870)
 *
 * `harness_shared.tool_invocations` is named for the TOOL, not for who chose it. Its rows LOOK
 * like agent behavior, and every dedicated provenance column (`principal_kind`,
 * `principal_auth_method`, `principal_trust`, `role`, `transport`) is identical — usually NULL —
 * for hook-emitted and model-chosen calls alike. Measured 2026-08-12 across 3h of mcp rows:
 * 37,121 of ~50,400 (74%) came from per-turn hooks, across 182 owners, spanning only 9 tool
 * names, all coordination verbs. Because hooks emit only coordination verbs and never work
 * verbs, the resulting error in any behavior metric is DIRECTIONAL — it never averages out, and
 * it always renders agents as coordinating instead of working.
 *
 * ── Why this module DECLARES rather than infers ──────────────────────────────────────────────
 * The bug was born from inference, so the fix cannot be a better inference. Every hook client is
 * our own code and knows what it is at the moment it calls, so it SAYS so (`&origin=hook` on the
 * MCP url, or an `x-papercusp-call-origin` header). Derivation exists only to cover callers that
 * have not declared yet — a hook running from an older checkout during a deploy, or a client we
 * do not own — and every derived verdict is stamped as such.
 *
 * That `source` field is the load-bearing half. The reason this bug survived long enough to
 * corrupt published findings is that a WRONG classification was indistinguishable from a right
 * one; a consumer needing certainty filters `source === 'declared'`, and one needing coverage
 * takes both while knowing which half it is trusting.
 *
 * `'unknown'` is likewise a real verdict, not a failure: refusing to classify is strictly better
 * than a confident guess, and it makes the un-declared population visible so it can shrink.
 *
 * Pure + dependency-free so the sink can call it inline on every dispatch.
 */

export type CallOrigin = "agent" | "hook" | "ui" | "system" | "unknown";
export type CallOriginSource = "declared" | "derived";

export interface CallOriginVerdict {
  origin: CallOrigin;
  /** How `origin` was reached. Never omit it downstream — see the module note. */
  source: CallOriginSource;
}

/** The query param a caller sets to declare itself: `…/api/mcp?superuser=1&origin=hook`. */
export const CALL_ORIGIN_QUERY_PARAM = "origin";
/** The header equivalent, for callers that cannot shape their URL. */
export const CALL_ORIGIN_HEADER = "x-papercusp-call-origin";

/** Values a caller may declare. `unknown` is ours to write, never theirs to claim. */
const DECLARABLE: ReadonlySet<string> = new Set<CallOrigin>([
  "agent",
  "hook",
  "ui",
  "system",
]);

/**
 * Query params that only a MODEL client's persistent MCP url carries — psu bakes the seeded tool
 * list / profile / context tier into the url it hands the CLI at launch. A hook posts a bare
 * one-shot url (`?superuser=1&client=…`) and never carries these.
 *
 * This is the strongest derived signal because it keys on the LAUNCH SHAPE rather than on a
 * client's name, so it holds for any model client psu launches, including ones that do not exist
 * yet.
 */
const MODEL_CLIENT_LAUNCH_PARAMS = ["tools", "profile", "ctx_tier"] as const;

/**
 * User-agent prefixes, as a FALLBACK only.
 *
 * Deliberately not the primary rule: a UA list is a maintenance liability that fails silently
 * (a hook rewritten in another runtime would quietly join the model population), and the
 * measured data already contains a population it cannot resolve — `node`, 2,078 rows over 3h
 * across 75 owners and 92 tool names, which splits both ways on every other signal. That
 * population is exactly why unmatched UAs must return `unknown` instead of a default.
 */
const MODEL_CLIENT_UA_PREFIXES = ["claude-code/", "codex-mcp-client/"] as const;
/** Hook POST clients (the cc hook scripts' `urllib.request`). Superseded by declaration. */
const HOOK_CLIENT_UA_PREFIXES = ["python-urllib/"] as const;

/** The desktop command-palette / dock bridge stamps this spawn id (see isPaletteUiPollRead). */
const PALETTE_SPAWN_ID = "palette";

export interface CallOriginInput {
  requestOrigin?: {
    query?: Record<string, string> | null;
    headers?: Record<string, string> | null;
  } | null;
  spawnId?: string | null;
}

function declaredOrigin(input: CallOriginInput): CallOrigin | null {
  const ro = input.requestOrigin;
  if (!ro) return null;
  const raw = (
    ro.query?.[CALL_ORIGIN_QUERY_PARAM] ??
    ro.headers?.[CALL_ORIGIN_HEADER] ??
    ""
  )
    .trim()
    .toLowerCase();
  return DECLARABLE.has(raw) ? (raw as CallOrigin) : null;
}

/**
 * Classify one dispatch. Pure; never throws — telemetry is best-effort and must never be able to
 * fail a tool call, so a malformed requestOrigin degrades to `unknown`/`derived`.
 */
export function classifyCallOrigin(input: CallOriginInput): CallOriginVerdict {
  const declared = declaredOrigin(input);
  if (declared) return { origin: declared, source: "declared" };

  if ((input.spawnId ?? "") === PALETTE_SPAWN_ID) {
    return { origin: "ui", source: "derived" };
  }

  const ro = input.requestOrigin;
  if (!ro) return { origin: "unknown", source: "derived" };

  const query = ro.query ?? {};
  if (MODEL_CLIENT_LAUNCH_PARAMS.some((p) => typeof query[p] === "string")) {
    return { origin: "agent", source: "derived" };
  }

  const ua = (ro.headers?.["user-agent"] ?? "").trim().toLowerCase();
  if (ua) {
    if (MODEL_CLIENT_UA_PREFIXES.some((p) => ua.startsWith(p))) {
      return { origin: "agent", source: "derived" };
    }
    if (HOOK_CLIENT_UA_PREFIXES.some((p) => ua.startsWith(p))) {
      return { origin: "hook", source: "derived" };
    }
  }

  return { origin: "unknown", source: "derived" };
}
