/**
 * Per-sync-RESOURCE delta config (agent-tool-delta-client-rollout-2026-06-23 P-006).
 *
 * A sync resource (a `resolveNamedQueryV2` name) opts into the rows-delta protocol by
 * declaring how to KEY its rows: `itemKeyField` (a simple, stable field access) + a
 * `schemaVersion` that invalidates in-flight client cursors when the row shape changes.
 * The rest-query handler negotiates full|delta (via `negotiateRowsDelta`) for a cursor-
 * sending (delta-aware) client; a resource WITHOUT a config always serves full — today's
 * behavior, byte-identical.
 *
 * Only high-cost, frequently-re-fetched LIST resources need this. `plans.attention`
 * (~633KB re-fetched on every plans-table invalidation) is the headline ~327GB/3d win:
 * it returns one AttentionGroup per plan, so a single-plan write re-sends only that group.
 *
 * Correctness is not at stake here: the negotiated response carries the full-view checksum,
 * the client verifies its merge against it and refetches a full on any mismatch — so a wrong
 * or stale `itemKeyField` can only cost a refetch (no win), never a wrong view.
 */
export interface ResourceDeltaConfig {
  /** Field uniquely + stably identifying a row (e.g. AttentionGroup.key, plan.slug). */
  itemKeyField: string;
  /** Bumped when the row shape changes — invalidates in-flight client cursors. */
  schemaVersion: string;
}

const CONFIG: Readonly<Record<string, ResourceDeltaConfig>> = {
  // plans.attention resolves to AttentionGroup[] (one group per plan + an alerts group);
  // keyed by `key`. A single-plan write changes only that group's content-hash → re-send 1 of N.
  // v2 (WI-7039 / D-025): the UI projection now omits null-valued keys, which
  // changes every row's content hash. The bump makes in-flight cursors take ONE
  // clean full instead of reporting the whole view as `updated`.
  'plans.attention': { itemKeyField: 'key', schemaVersion: 'plans-attention-v2' },
  // plans.list resolves to the plan rows, keyed by `slug` (same key the plans:list tool uses).
  // v2 (WI-7045 / D-025): the UI projection now omits null-valued keys here too,
  // which changes every row's content hash. Same reason as the attention bump —
  // without it an in-flight cursor reports the entire view as `updated` instead of
  // taking ONE clean full.
  'plans.list': { itemKeyField: 'slug', schemaVersion: 'plans-list-v2' },
  // plans.byHive resolves to the SAME rows as plans.list (it reuses that read with the
  // hive's member-slug set), so it takes the same `slug` key. It could not have one
  // before WI-7083: the harness_slugs fan-out fabricated one copy of the hive's plan set
  // PER MEMBER, so `slug` had 910 distinct values across 1,820 rows and no single field
  // was unique. With the fan-out deduped on the resolved PLAN SCOPE, one hive reads one
  // plan set and `slug` is unique again.
  //
  // If a caller ever assembles a slug set spanning two DIFFERENT hive homes, `slug` could
  // collide across them — that costs a refetch, never a wrong view (the response carries
  // the full-view checksum and the client refetches on mismatch; see the header note).
  'plans.byHive': { itemKeyField: 'slug', schemaVersion: 'plans-byhive-v1' },
  // codeRecipes resolves to the recipe corpus for /admin/recipes, keyed by `id` — the
  // PRIMARY KEY of harness_shared.code_recipes, and measured distinct on 1000/1000 live
  // rows. The corpus is re-fetched whole on every recipe write (capture-recipe,
  // recipes:sweep and recipes:merge all fire notifySyncInvalidate('codeRecipes')), and a
  // capture changes exactly ONE row — so this is the same re-send shape plans.attention
  // has, at 1,000 rows a poll.
  'codeRecipes': { itemKeyField: 'id', schemaVersion: 'code-recipes-v1' },
  // ── no-http-anywhere-2026-07-28 D-091: the three fattest CONFIG-LESS resources on the
  // /adv/harnesses route family. Each was re-sending its whole view on every 180s SSE
  // drift-repair tick (measured on :3170 2026-08-08 via rest-query, args as the call sites
  // send them). Key uniqueness was MEASURED on the live rows, not assumed — a wrong key
  // costs a refetch, never a wrong view (see the header note), but a COLLIDING key costs
  // the whole win, so it is checked rather than hoped for.
  //
  // workItems.byHarness — 500 rows / 225,536 B; `id` distinct 500/500.
  // Several arg shapes exist (AdvChatPanel states+perState, DepGraphPanel limit, HudView's
  // fair per-status slice). Each is its own viewKey (the route keys on `name:argsJson`), and
  // `id` is unique within any of them because a work-item holds exactly one state.
  'workItems.byHarness': { itemKeyField: 'id', schemaVersion: 'work-items-byharness-v1' },
  // agentRunsConsolidated.bySlug — P-008 reduced each request to a 250-row keyset page;
  // `runId` remains distinct within every workspace/harness page. (`sessionId` and
  // `featureId` both collide, so neither is a valid delta key.)
  'agentRunsConsolidated.bySlug': { itemKeyField: 'runId', schemaVersion: 'agent-runs-consolidated-v1' },
  // featuresConsolidated.bySlug — WI-7209 bounds this compatibility view to
  // 500 latest rows after moving its last live consumers to detail + exact
  // stats. `featureId` stays unique within every limit-keyed view.
  'featuresConsolidated.bySlug': { itemKeyField: 'featureId', schemaVersion: 'features-consolidated-v1' },
  // ── D-092: the last two over-budget reads without a config. With these, ALL 9 eligible
  // entries in sync-read-audit's accepted-over-budget allowlist are delta-negotiated; the
  // tenth (`featuresConsolidated.byHive`) is permanently ineligible — see below.
  //
  // coord.plans — 932 rows / 385,366 B; `slug` distinct 932/932 measured live.
  // ⚠ This resolver takes NO args and loads the coord-wide plan set, so `slug` is unique by
  // DATA, not by construction: plans key on (workspace_id, harness_slug, slug), and two
  // harnesses could hold the same slug. The projection carries no harness field, so `slug` is
  // the only identity this view HAS — a same-slug pair is already indistinguishable here with
  // or without a delta. Same precedent as `plans.byHive`: a collision costs a REFETCH (the
  // response carries the full-view checksum and the client refetches on mismatch), never a
  // wrong view.
  'coord.plans': { itemKeyField: 'slug', schemaVersion: 'coord-plans-v1' },
  // conversations.agentMessageList — 100 rows / 233,489 B; `msg_id` distinct 100/100.
  // ⚠ Unlike every other entry here this is a FIXED 100-row SLIDING WINDOW over the
  // append-only coord_event_log, so it churns by construction: each tick admits new rows and
  // drops equally-old ones. The delta is therefore proportional to MESSAGE ARRIVAL RATE, not
  // to the corpus — a removal is just an id (cheap), an addition carries ~2.3 KB. It is still
  // strictly ≤ the full re-send, but do NOT expect the ~1000x of the static views; measure it
  // rather than quoting a ratio from the others.
  'conversations.agentMessageList': { itemKeyField: 'msg_id', schemaVersion: 'agent-message-list-v1' },
};

/** The delta config for a sync resource name, or undefined → serve full (today's behavior). */
export function resourceDeltaConfig(name: string): ResourceDeltaConfig | undefined {
  return CONFIG[name];
}

/**
 * Every resource that delta-negotiates SERVER-side — the authoritative set the client codec
 * must mirror (apps/operator/providers/sync-delta-codec.ts `DELTA_RESOURCES`).
 *
 * Exported because the two halves DRIFTED and silently cost the win twice: the client gates on
 * its own literal (`query-fetcher.ts:468` — `!codec.enabled(name)` ⇒ no cursor is sent ⇒ the
 * server serves full), so a resource configured here but missing there can NEVER take a delta.
 * Measured 2026-08-08: this file gained `plans.byHive` (WI-7083, which deduped the harness_slugs
 * fan-out specifically to make `slug` unique so it COULD have an entry) and `codeRecipes`
 * (2026-08-02), while the client set had not changed since 2026-06-23 — so both fixes were inert.
 * `sync-delta-codec.test.ts` now asserts parity against this export so it cannot recur silently.
 */
export const RESOURCE_DELTA_NAMES: readonly string[] = Object.freeze(Object.keys(CONFIG));
