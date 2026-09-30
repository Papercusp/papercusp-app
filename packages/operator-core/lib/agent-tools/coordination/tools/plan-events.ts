/**
 * coord:plan-events — read the plan-event history feed.
 *
 * agent-coordination-architecture-v2 §8. plan_event records live on the
 * `plan-events` surface of the CoordEventLog (Postgres), NOT the
 * `messages` surface — so coord:inbox does not surface them. This tool is the read surface the
 * OMP turn-start extension uses to assemble the "plans changed since
 * you last read" reminder section (scoped by the watermark's
 * plan_events_since_ts pointer).
 */

import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../roles";
import { readPlanEvents } from "../plan-events";
import { cachedRead, type CachedReadCtx } from "../../../cache";

/**
 * SWR backstop for coord:plan-events (cache-expensive-tool-reads-round2-2026-06-23 P-003).
 * Caches the pure readPlanEvents derive (the rotation-file / coord_event_log scan). Tagged
 * with coord_event_log, whose per-event bump is DEBOUNCED (D-006) so the append storm can't
 * tank the hit-rate; this short soft TTL bounds worst-case staleness alongside the debounce.
 * Non-principal + workspace-scoped (the plan-events surface is read in the ALS-active
 * workspace; cachedRead namespaces by ctx.workspaceId). The hit-rate benefit concentrates on
 * BROAD calls (no / loose since_ts — the p95-heavy ones); the turn-start watermark caller
 * passes a per-agent advancing since_ts (high key cardinality) so those mostly MISS —
 * harmlessly: a miss just runs the factory exactly as before.
 */
const COORD_PLAN_EVENTS_SOFT_TTL_MS = 5_000;

/**
 * Per-session-tier DEFAULTS (context-trimming-tiers P-022). This tool keeps a
 * hand-rolled JSON ToolResult — the OMP coord-hook (turn-start reminder)
 * MCP-calls it and `JSON.parse`s the text, so a `{data}` conversion would
 * serve it TOON and break it (the coord:inbox hazard/precedent). Instead the
 * DEFAULT limit + per-event text clip adapt to `ctx.contextTier`; hook calls
 * carry no ctx_tier → full defaults → byte-identical. An explicit `limit`
 * arg always wins; `payloadTier:"full"` per call restores today's bytes.
 * Fat fields: `detail`/`after`/`before` (a now_updated event carries whole
 * Now-block texts). Clipped events stay loud via `payload_tier` + the clip
 * ellipsis; full bodies come from plans:get / a full-tier re-call.
 */
export const PLAN_EVENTS_TIER_DEFAULTS = {
  trimmed: { limit: 30, textChars: 200 },
  standard: { limit: 60, textChars: 400 },
  full: { limit: 100, textChars: 0 }, // 0 = no clip (today's behavior)
} as const;

const EVENT_CLIP_FIELDS = ["detail", "after", "before", "body"] as const;

function clipEventTexts(
  events: unknown[],
  maxChars: number,
): unknown[] {
  if (maxChars <= 0) return events;
  return events.map((ev) => {
    if (!ev || typeof ev !== "object") return ev;
    const out = { ...(ev as Record<string, unknown>) };
    for (const f of EVENT_CLIP_FIELDS) {
      const v = out[f];
      if (typeof v === "string" && v.length > maxChars) {
        out[f] = `${v.slice(0, maxChars - 1)}…`;
      }
    }
    return out;
  });
}

export default defineTool({
  name: "coord:plan-events",
  description:
    "Read the plan-event history — created / now_updated / decision_added / item_added / item_status_changed / promoted events across all plans. Returns the most-recent events first-bounded (a no-arg call is always size-capped so it never overflows the result), newest kept. Widen with `plan_slug` (one plan), `files_back` (N rotation files; 0 means the current rotation file), or `limit` (max events). Returns `{ events, total, truncated }`. Distinct from coord:inbox (which scans messages, not plan-events).",
  guidance: {
    when: "Turn start — the OMP coordination extension calls this to show which plans changed since the agent last read. Also ad-hoc, to review recent plan activity.",
    notWhen:
      "For messages / notifies / handoffs addressed to you — use coord:inbox.",
  },
  capability: "coord:read",
  requirePrincipal: false,
  // EI-20226779878046151: plan-event reads use their own cached/store path and
  // never read ctx.tx. coord:orient invokes this leg sequentially, so retaining
  // the ambient org-app transaction would starve other coordination reads.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan_slug: z.string().optional(),
    files_back: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Read the current rotation file when 0; otherwise read the most-recent N monthly rotation files."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max events returned (newest kept). Default 100 — keeps a no-arg call from overflowing the result cap.",
      ),
  }),
  async handler(args, ctx) {
    // Session-tier defaults (P-022) — see PLAN_EVENTS_TIER_DEFAULTS above.
    const sessionTier = (ctx as { contextTier?: "trimmed" | "standard" | "full" })
      .contextTier;
    const tierDefaults =
      PLAN_EVENTS_TIER_DEFAULTS[sessionTier ?? "full"] ??
      PLAN_EVENTS_TIER_DEFAULTS.full;
    const limit = args.limit ?? tierDefaults.limit;
    // Cache the pure read, keyed on the READ dimensions only — `limit` is a presentation
    // bound applied below, so two calls differing only in limit share one entry. Debounced
    // coord_event_log tag + short SWR (see the constant above).
    const all = await cachedRead(
      ctx as CachedReadCtx,
      {
        tool: "coord:plan-events",
        key: {
          plan_slug: args.plan_slug ?? null,
          files_back: args.files_back ?? null,
        },
        tags: ["coord_event_log"],
        softTtlMs: COORD_PLAN_EVENTS_SOFT_TTL_MS,
      },
      () =>
        readPlanEvents({
          planSlugs: args.plan_slug ? [args.plan_slug] : undefined,
          filesBack: args.files_back,
        }),
    );
    // readPlanEvents now bounds the STORAGE read to the newest READ_PLAN_EVENTS_BOUND
    // matching (EI-1737 / fleet-concurrency-first P-005 — since_ts/plan_slug pushed into
    // the coord_event_log index scan), so a no-arg call no longer serializes the whole
    // ~3.5MB history on the event loop ×fleet-size. We still apply the per-call
    // presentation `limit` here (newest `limit`, ts-ASCENDING); `total`/`truncated` tell
    // the caller more exist within the bounded window so they can widen by
    // since_ts/plan_slug/limit.
    const bounded = all.length > limit ? all.slice(-limit) : all;
    // Per-event text clip (trimmed/standard sessions only — textChars 0 = off).
    const events = clipEventTexts(bounded, tierDefaults.textChars);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            events,
            total: all.length,
            truncated: all.length > events.length,
            // Loud tier marker (D-004): a non-full session sees WHY the feed is
            // shorter/clipped and how to widen (limit arg / payloadTier:"full").
            ...(sessionTier && sessionTier !== "full"
              ? { payload_tier: sessionTier }
              : {}),
          }),
        },
      ],
    };
  },
});
