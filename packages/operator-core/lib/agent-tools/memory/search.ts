/**
 * memory:search — semantic recall over the user's persistent memories.
 *
 * The route's pre-turn injection auto-surfaces relevant memories every
 * turn; brain only needs to call this for targeted lookup ("did I tell
 * you about X?"). Searches user-scoped + harness-scoped (current
 * harness if `harness_slug` is passed, every harness in the workspace
 * otherwise). The deprecated workspace-shared pool was drained (D-005).
 *
 * Storage rides the neutral `MemoryBackend` seam; per-scope fan-out and
 * merge live behind it. RESPONSE CONTRACT (byte-stable — the TUI Memory
 * tab consumes it): { ok, reason?, results: [{ id, memory, metadata,
 * score }], score_scale? }. Additive degraded stamps (EI-9031 / WI-4214): any failed or
 * reduced-fidelity recall carries `degraded: true` (+ `degraded_reason`,
 * and `fallback: 'lexical'` when the hits came from the embed-free
 * token-match fallback) so an empty/thin result is never mistaken for an
 * informative "nothing relevant exists".
 *
 * WI-36046 adds one more additive stamp: a hit whose extracted anchors no longer
 * resolve (per the nightly sweep — never computed inline) carries `staleness` AND a
 * one-line banner prepended to `memory`, so the same caveat CLAUDE.md pushes onto
 * per-agent discipline arrives with the hit instead. The field is emitted ONLY when
 * something is broken, so its absence MEANS "no dead anchors". Flagged
 * (MEMORY_STALENESS_IN_RECALL, default on); OFF restores the prior shape byte-for-byte.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  getMemoryBackend,
  MemoryUnavailableError,
  type MemoryEntry,
  type ScoreScale,
  type SearchLegStats,
} from '../../memory/backend';
import { isMemoryWorkspaceScopedRecallOn, keepUserPoolHitForWorkspace } from '../../memory/workspace-scope-recall';
import {
  MemoryTimeoutError,
  withMemoryToolTimeout,
  withMemoryTimeout,
  memoryLexicalFallbackTimeoutMs,
  embedFailureReason,
} from '../../memory/op-deadline';
import { isOpenAiEmbedInCooldown } from '../../memory/configure';
import { interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { getSessionUserOrDefault } from '../../auth';
import { loadHarnessRegistry } from '../../harness-registry';
import { isEphemeralBenchmarkHarnessSlug } from '../../harness/improvements/watchdog';
import { narrowHarnessSlugsToSessionHive } from '../../memory/hive-scope';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { systemDistinctId } from '../../flag-distinct-id';
import { resolveAgentIdentity } from '../coordination/identity';
import { packageRecallEligibility, shapeIdentityPackageHits, wearerPackageResourcesOrEmpty } from '../../blueprint/package-memory-visibility';
import { getOrgPg } from '@papercusp/db-org';

/**
 * Per-session-tier hit shaping (context-trimming-tiers P-024). This tool's
 * response is a BYTE-STABLE contract (the TUI Memory tab reads content[0].text
 * over a non-mcp transport), so it keeps the hand-rolled ToolResult and adapts
 * IN-HANDLER off ctx.contextTier — the coord:inbox precedent — instead of
 * declaring `shape`. No-tier callers (the TUI, hooks) get full, byte-identical
 * rows; a trimmed/standard LLM session gets each hit's text clipped (loud:
 * memory_truncated + memory_full_chars per row, payload_tier at the top) and,
 * at trimmed, metadata reduced to its `kind`. payloadTier:"full" per call
 * restores everything (the dispatch overlay threads it into ctx.contextTier).
 */
export const MEMORY_SEARCH_TIER_CAPS = {
  trimmed: { text: 280, metadataKindOnly: true },
  standard: { text: 500, metadataKindOnly: false },
} as const;

export function shapeMemoryHit(
  row: { id: string; memory: string; metadata?: Record<string, unknown>; score?: number },
  tier: keyof typeof MEMORY_SEARCH_TIER_CAPS,
): Record<string, unknown> {
  const c = MEMORY_SEARCH_TIER_CAPS[tier];
  const clipped = row.memory.length > c.text;
  const metadata = c.metadataKindOnly
    ? row.metadata?.kind !== undefined
      ? { kind: row.metadata.kind }
      : undefined
    : row.metadata;
  return {
    id: row.id,
    memory: clipped ? `${row.memory.slice(0, c.text - 1)}…` : row.memory,
    ...(clipped ? { memory_truncated: true, memory_full_chars: row.memory.length } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(row.score !== undefined ? { score: row.score } : {}),
  };
}

/** Map a neutral entry onto the stable wire row the surfaces consume.
 *  `kind` is materialized into `metadata.kind` — the TUI Memory tab reads
 *  it there, and non-mem0 backends (e.g. claude-file) carry kind only at
 *  the entry level. For mem0 rows this is a no-op (kind already matches). */
export function toWireRow(e: MemoryEntry): {
  id: string;
  memory: string;
  metadata?: Record<string, unknown>;
  score?: number;
} {
  const metadata = e.kind !== undefined ? { ...(e.metadata ?? {}), kind: e.kind } : e.metadata;
  return {
    id: e.id,
    memory: e.text,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(e.score !== undefined ? { score: e.score } : {}),
  };
}

export default defineTool({
  name: 'memory:search',
  capability: 'memory:read',
  description:
    "Search the user's persistent memories by semantic similarity. Returns matched facts ranked by relevance.",
  guidance: {
    when:
      'When the user references specific context from past sessions ("what did I tell you about pricing?"). Default recall returns only facts CURRENT now. For "what did we believe then?", pass `as_of:<ISO timestamp>`; for a lifecycle audit, pass `include_superseded:true` to include closed rows and inspect `metadata.validity` / `superseded_by`. Pre-turn auto-injection covers most current-fact lookups; call this for targeted or historical recall.',
    notWhen:
      "For lookups by exact metadata (kind), use memory:list — it's faster than vector search for filter-only queries.",
    chaining:
      'Pair with memory:remember { supersede:<old-id> } when a NEW fact replaces a recalled one; use memory:update for the SAME fact in place, or memory:forget for removal (soft when history should remain, hard for privacy). A hit carrying `staleness` has referents that no longer resolve (last nightly anchor sweep) — treat it as evidence to reconcile, never as binding guidance; absence of the field means no dead anchors.',
    seeAlso: [
      'memory:remember (write a new durable fact)',
      'memory:list (filter-only lookup by exact metadata — faster than vector search)',
      'memory:forget (drop a recalled hit the user contradicted)',
    ],
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so memory:search works from a psu
  // session instead of failing `workspace_required`. (EI: memory unreachable from psu.)
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
    harness_slug: z
      .string()
      .optional()
      .describe(
        'Scope the search to a single harness in addition to user memory. Omit to fan out across every harness in the workspace.',
      ),
    harnessOnly: z
      .boolean()
      .optional()
      .describe(
        "Scope to ONLY the named harness pool — EXCLUDE the user/personal pool. For ISOLATED per-run pools (e.g. a benchmark capability-injection arm) where the user's personal memories would be noise. Requires harness_slug; ignored without it.",
      ),
    workspace: z
      .string()
      .optional()
      .describe(
        'Superuser-only: from an UNSCOPED session, resolve harness fan-out within THIS workspace (the resolved workspace scopes the fan-out). Scoped/power-user sessions ignore it. Omit for personal (user-scoped) recall.',
      ),
    as_of: z
      .string()
      .max(64)
      .refine((v) => Number.isFinite(new Date(v).getTime()), 'as_of must be a parseable ISO 8601 timestamp')
      .optional()
      .describe(
        'TEMPORAL (temporal-lite): point-in-time recall — only memories whose UTC half-open validity window covers this ISO timestamp (valid_at <= as_of < invalid_at). When combined with include_superseded, this point-in-time window remains authoritative; the flag does not widen it. Hits carry metadata.validity.',
      ),
    include_superseded: z
      .boolean()
      .optional()
      .describe(
        'TEMPORAL (temporal-lite): without as_of, include superseded/soft-forgotten memories across the full lifecycle. With as_of, the UTC point-in-time window is authoritative. Superseded hits carry metadata.validity { status:"superseded", superseded_by }.',
      ),
  }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const limit = args.limit ?? 8;

    // Scope resolution — registry/flag reads only, never a memory-backend
    // call, so it sits AHEAD of the deadline-guarded region: the degraded
    // lexical fallback below needs the SAME scopes after the semantic leg
    // has already failed (WI-4214).
    let harnessSlugs: string[];
    if (args.harness_slug) {
      harnessSlugs = [args.harness_slug];
    } else {
      try {
        // The principal carries the resolved workspace (incl. a per-call
        // `workspace` pin from an unscoped SU session); the old
        // `ctx.workspaceId` read was never populated on principal-gated
        // handlers, so the fan-out silently degraded to user-pool-only (P-004).
        const reg = await loadHarnessRegistry(ctx.principal?.workspaceId ?? '');
        // P-016: exclude ephemeral/benchmark harness scopes from unscoped
        // production recall so benchmark memories don't pollute results.
        // Explicit harness_slug (above) bypasses this filter intentionally.
        harnessSlugs = reg.projects.map((p) => p.slug).filter((s) => !isEphemeralBenchmarkHarnessSlug(s));
        // P-018 (scoped-superuser-workspace-clamp / D-009 P-016b): confine the
        // DEFAULT fan-out to the session's hive subtree so a hive-confined
        // session (concrete `ctx.harnessSlug` — a bee or a hive-scoped su) does
        // NOT recall SIBLING hives' harness pools — a cross-hive recall bleed,
        // live now that the workspace runs multiple hives. A workspace/unscoped
        // session (harness '*') is left untouched (the workspace-scoped Queen
        // recalls across its hives). Gated by the clamp flag (rides its rollout;
        // a kill-switch). Fail-OPEN — a flag-read error keeps the full fan-out,
        // matching the clamp's fail-open-on-infra-error posture (no recall loss
        // on a flag hiccup; the worst case is over-broad recall, never a leak).
        try {
          if (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, systemDistinctId())) {
            harnessSlugs = narrowHarnessSlugsToSessionHive(reg.projects, harnessSlugs, ctx.harnessSlug);
          }
        } catch {
          /* fail-open: keep the full workspace fan-out */
        }
      } catch {
        harnessSlugs = [];
      }
    }

    // Scope: user-pool + harness-pool(s) normally. With harnessOnly (+ a harness_slug), scope to ONLY the
    // harness pool — drop the user pool — so an ISOLATED per-run pool (a benchmark capability-injection arm)
    // recalls just its own facts, not the user's personal memories (which would be noise / confound the
    // measurement). harnessOnly without harness_slug is meaningless (no pool to isolate to) → ignored.
    const harnessScopes = harnessSlugs.map((slug) => `harness:${slug}`);
    const scope = args.harnessOnly && args.harness_slug ? harnessScopes : [user.id, ...harnessScopes];

    // Temporal-lite read controls (P-006) — ride SearchOptions into the backend
    // (and the lexical fallback below, so a degraded point-in-time read keeps
    // its time semantics).
    const temporal = {
      ...(args.as_of !== undefined ? { asOf: args.as_of } : {}),
      ...(args.include_superseded ? { includeSuperseded: true } : {}),
    };

    // P-007 / D-021: identity-installed pack rows are archived; only the caller's
    // applied exact-version pins re-admit them, before ranking and inside the
    // pools above. Fails closed to "no pack rows", never to "no recall".
    let pinnedPackResources: ReadonlySet<string> = new Set();
    try {
      let wearer: string | null = null;
      try { wearer = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId ?? null; } catch { wearer = null; }
      if (wearer) {
        pinnedPackResources = await withMemoryTimeout(
          wearerPackageResourcesOrEmpty(getOrgPg().sql, { workspaceId: ctx.principal?.workspaceId ?? '', ownerId: wearer }),
          'memory:search package eligibility',
          memoryLexicalFallbackTimeoutMs(),
        );
      }
    } catch {
      pinnedPackResources = new Set();
    }
    const eligibility = packageRecallEligibility(pinnedPackResources);

    // B1 (infra-fail-fast-build-integrity-2026-06-19): bound EVERY backend call
    // with a deadline. `available()` itself can hang when the store is wedged
    // (the 2026-06-19 outage), so it is inside the guarded region too. A timeout
    // returns the same `{ ok:false, reason, results:[] }` envelope as a clean
    // "store down" probe — but with `memory_timeout` — instead of an infinite hang.
    let hits: MemoryEntry[];
    // WI-4214 (P-005 memory-public-release-hardening): set when the SEMANTIC leg
    // failed but the embed-free lexical fallback served the hits — the envelope
    // is stamped degraded + fallback:'lexical' so callers know these are token
    // matches (paraphrase recall is out), never a full-fidelity result.
    let overloadDegradedReason: string | null = null;
    // Which leg produced `hits` — they carry DIFFERENT score scales (P-036).
    // Tracked separately from `overloadDegradedReason` because that one is a
    // wire-envelope concern; this one decides what the telemetry row means.
    let usedLexicalFallback = false;
    // P-002's backend callback already powers the push/injection path. Capture
    // the same structured counts + timings here so direct memory:search rows do
    // not remain the observability blind half of the same retrieval backend.
    let legStats: SearchLegStats | null = null;
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:search available');
      if (!avail.ok) {
        // A down store is a DEGRADED recall, not an informative empty (same
        // EI-9031 posture as the embed-failure branch below).
        return {
          content: [
            { type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, degraded: true, results: [] }) },
          ],
        };
      }
      // The backend fans out per scope (limit applies per pool), merges,
      // de-dupes by id and sorts by score; we apply the global cap here.
      hits = await withMemoryToolTimeout(
        backend.search(args.query, {
          scope,
          limit,
          ...temporal,
          ...eligibility,
          // EI-21348316803580175: bound the query embed. memory:search was the
          // lone interactive holdout — semantic.ts, sessions:search, tools:find
          // and ask-knowledge-tier all already opt into this same policy — and
          // being unbounded it inherited the sidecar's 15s timeout, so a
          // saturated embedder took this tool's p50 from ~750ms to ~6.4s and
          // dragged every coord:orient (which rides this call) to 17-21s.
          //
          // On a budget miss the backend THROWS; the catch below classifies it
          // and degrades to the embed-free lexical leg (WI-4214). A partial,
          // fast recall beats a full one that blows the caller's deadline.
          embedTimeoutMs: interactiveEmbedAcquireBudgetMs(),
          onLegStats: (stats) => {
            legStats = stats;
          },
        }),
        'memory:search search',
      );
    } catch (err) {
      // Classify the failure to a CLEAN reason (mem0-timeout-fix-2026-06-24 /
      // EI-9031 / WI-4183): a hang → memory_timeout; a clean store-down probe
      // mid-flight → its own reason (previously an opaque handler_error); an
      // embed failure (429/5xx/stall/sidecar) → its classified reason.
      const reason =
        err instanceof MemoryTimeoutError
          ? 'memory_timeout'
          : err instanceof MemoryUnavailableError
            ? err.reason
            : embedFailureReason(err);
      if (!reason) throw err;
      // WI-4214: the semantic leg is unusable (saturated/overloaded embedder,
      // or an embed-path failure) but the store itself may be fine — attempt
      // the EMBED-FREE lexical fallback under its own short deadline before
      // giving up. Feature-tested: a backend without the capability (or a
      // fallback that itself fails/times out) degrades to the honest empty
      // envelope below, exactly as before.
      const lexical = backend.searchLexical?.bind(backend);
      let fallbackHits: MemoryEntry[] | null = null;
      if (lexical) {
        try {
          fallbackHits = await withMemoryTimeout(
            lexical(args.query, { scope, limit, ...temporal, ...eligibility }),
            'memory:search lexical fallback',
            memoryLexicalFallbackTimeoutMs(),
          );
        } catch {
          fallbackHits = null;
        }
      }
      if (fallbackHits === null) {
        // EI-9031: a failed recall is a DEGRADED recall, not an informative
        // empty — stamp it loudly (in addition to the reason) so agents /
        // orient never read the `[]` as "nothing relevant exists".
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason, degraded: true, results: [] }) }],
        };
      }
      // Lexical hits ride the NORMAL post-processing below (workspace-scope
      // filter, feedback rerank, tier shaping) — degraded recall still honors
      // every hygiene/scoping invariant of the healthy path.
      hits = fallbackHits;
      usedLexicalFallback = true;
      // The fallback is a separate, embed-free retrieval call. Any stats a
      // failed semantic attempt happened to report do not describe these hits.
      legStats = null;
      overloadDegradedReason = reason;
    }
    // D-021: exact-version dedupe, pinned boost and provenance over eligible hits.
    hits = shapeIdentityPackageHits(hits, pinnedPackResources);

    // data-scoping-audit P-006 / D-004 / D-012 (dark cutover): workspace-scope the USER
    // pool — drop `project` hits tagged with a different workspace; keep owner-tier +
    // legacy NULL-workspace. harness pools (scope `harness:*`) pass through untouched.
    if (await isMemoryWorkspaceScopedRecallOn()) {
      const activeWs = ctx.principal?.workspaceId;
      hits = hits.filter((h) => h.scope !== user.id || keepUserPoolHitForWorkspace(h, activeWs));
    }

    // memory_feedback consumer (EI-366 / consume-edges P-031): drop hits the
    // user deleted (tombstones — the lexical projection has no per-delete
    // reconciliation) and demote re-extractions of deleted content. Hygiene,
    // never load-bearing — any failure skips the pass.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { loadFeedbackSignals, applyFeedbackRerank } = await import('../../memory/feedback-rerank');
      hits = applyFeedbackRerank(hits, await loadFeedbackSignals(getOrgPg().sql));
    } catch {
      /* best-effort */
    }

    // EI-9031: when the production embedder (OpenAI) is in its post-exhaustion
    // cooldown, the 'auto' cascade has silently fallen back to the local vec table
    // — older OpenAI-embedded memories live in a DIFFERENT per-mode table, so an
    // empty/short result in this window is NOT reliably "nothing relevant exists".
    // Stamp the recall `degraded` so agents (and coord:orient, which folds this)
    // don't treat a possibly-false MISS as informative context. A recall hit is
    // binding — the dual is that a recall miss informs decisions too, and a fake
    // miss corrupts that inference for every agent for the whole outage.
    const embeddingDegraded = isOpenAiEmbedInCooldown();

    // The scale travels with the response so compound consumers can apply
    // scale-sensitive admission. A lexical fallback has a different scale
    // from the backend's normal search path; never infer it from magnitudes.
    const scoreScale: ScoreScale | undefined = usedLexicalFallback
      ? backend.lexicalScoreScale
      : backend.scoreScale;

    const wireRows = hits.slice(0, limit).map(toWireRow);
    // Session-tier hit shaping (P-024) — see MEMORY_SEARCH_TIER_CAPS above.
    // No-tier callers (the TUI Memory tab, hooks) take the full branch.
    const sessionTier = (ctx as { contextTier?: 'trimmed' | 'standard' | 'full' }).contextTier;
    let results: Array<Record<string, unknown>> =
      sessionTier === 'trimmed' || sessionTier === 'standard'
        ? wireRows.map((r) => shapeMemoryHit(r, sessionTier))
        : wireRows;

    // WI-36046 (workstream A): fold in the nightly anchor sweep's STORED verdict, so
    // a memory whose referents provably no longer resolve renders as evidence to
    // reconcile rather than as binding guidance. The verdict has existed per-memory
    // since migration 085 and reached only the human settings UI; this is the
    // hand-off. Notable-only (a healthy memory is untouched and costs nothing), and
    // applied AFTER tier shaping so the banner is never itself clipped away — see
    // lib/memory/recall-staleness.ts for why the banner rides the BODY.
    //
    // Best-effort in exactly the sense the feedback rerank above is: a dynamic
    // import, a bounded read over the ids we are already returning, and any failure
    // (flag read, sweep never ran, table absent, PG down) skips the pass and returns
    // today's byte-identical shape. Recall is never blocked by it.
    try {
      if (await getFlag(FLAGS.MEMORY_STALENESS_IN_RECALL, systemDistinctId())) {
        const ids = results.map((r) => (typeof r.id === 'string' ? r.id : null)).filter((v): v is string => v !== null);
        if (ids.length > 0) {
          const { getOrgPg } = await import('@papercusp/db-org');
          const { loadMemoryStaleness, applyMemoryStaleness } = await import('../../memory/recall-staleness');
          results = applyMemoryStaleness(results, await loadMemoryStaleness(getOrgPg().sql, ids));
        }
      }
    } catch {
      /* best-effort */
    }

    // Result count into tool_invocations.metadata_json (mirrors plans:search):
    // the negative-space miner (self-learning-frontier P-010) detects zero-hit
    // searches by `metadata_json->>'count'`; the query rides in args_json.
    (ctx as { metadata?: (d: Record<string, unknown>) => void }).metadata?.({ count: results.length });

    // Recall telemetry (migration 240) — zero-hit-rate + score distribution
    // for the Learning tab memory-health card. Fire-and-forget.
    // P-001 (orient-recall-quality-2026-07-12): a compound fold stamps its own
    // surface on the inner ctx (inProcessCall's telemetrySurface — e.g. 'orient')
    // so per-entry-point recall quality is separable from generic search; the
    // cast-borne read is the contextTier house pattern. Direct calls stay 'search'.
    const telemetrySurface = (ctx as { telemetrySurface?: string }).telemetrySurface ?? 'search';
    void (async () => {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { recordRecallStats } = await import('../../memory/recall-stats');
        // P-036 / migration 705: which scale these scores are on. The two
        // branches above return DIFFERENT scales from the SAME backend — the
        // healthy path is `search()` (rrf under the hybrid backend, cosine
        // under mem0), the WI-4214 degraded path is `searchLexical()` (raw
        // token-overlap). Recording the branch's own scale is the whole point:
        // a fallback recall must not be pooled with a healthy one.
        await recordRecallStats(getOrgPg().sql, {
          surface: telemetrySurface,
          entries: hits,
          scoreScale: usedLexicalFallback ? (backend.lexicalScoreScale ?? null) : (backend.scoreScale ?? null),
          // P-041 / migration 706: what was ASKED. The pull path has no session
          // identity on its ctx, so `sessionId` stays NULL here and per-session
          // duplicate detection covers the push path only — which is where the
          // Phase 11 defect lives.
          query: args.query,
          legs: legStats,
        });
      } catch {
        /* swallow — telemetry never fails a recall */
      }
    })();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            results,
            ...(scoreScale !== undefined ? { score_scale: scoreScale } : {}),
            // Loud degraded markers. WI-4214 (most specific first): the semantic
            // leg failed outright and these hits came from the embed-free lexical
            // fallback — token matches only, paraphrase recall is out, so a thin/
            // empty `results` may be a false miss. Else EI-9031: the embedder is
            // on a reduced-breadth fallback (cooldown), same false-miss caveat.
            ...(overloadDegradedReason
              ? { degraded: true, degraded_reason: overloadDegradedReason, fallback: 'lexical' }
              : embeddingDegraded
                ? { degraded: true, degraded_reason: 'embedding_backend_degraded' }
                : {}),
            // Loud tier marker (D-004): a non-full session sees WHY hits are
            // clipped and how to widen (payloadTier:"full").
            ...(sessionTier === 'trimmed' || sessionTier === 'standard' ? { payload_tier: sessionTier } : {}),
          }),
        },
      ],
    };
  },
});
