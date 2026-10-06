/**
 * memory:remember — explicit add to the persistent memory store.
 *
 * Brain calls this when the user says "remember X" or when the brain
 * itself notices an error/preference that would recur without
 * persistence. The persona prompt instructs the brain to ALWAYS
 * inform the user out loud ("I'll remember that") — never ask.
 *
 * userId is resolved server-side from the session cookie. Brain does
 * NOT pass it; the route guarantees the memory lands on the right user.
 *
 * Storage goes through the neutral `MemoryBackend` seam
 * (generalize-memory-backend-swappable-2026-06-05) — which store
 * actually holds the fact is a config flip (`PAPERCUSP_MEMORY_BACKEND`),
 * not a handler concern. Dedup + conflict checking ride the neutral
 * `search` (scored entries); anchor extraction is operator-side.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { lexicalSimilarity } from '@papercusp/memory';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import { MemoryTimeoutError, memoryToolTimeoutMs, withMemoryTimeout, withMemoryToolTimeout, withMemoryWriteRetry, embedFailureReason } from '../../memory/op-deadline';
import { anchorMetadata } from '../../memory/anchors';
import { expandRefsForEmbed } from '../../memory/ref-expand';
import { getWorkItem } from '../../work-items';
import { checkConflicts, conflictCheckEnabled } from '../../memory/conflict-check';
import { warnConflictJudgeUnavailableOnce } from '../../memory/anthropic-judge';
import { resolveConflictJudge } from '../../memory/conflict-judge';
import { persistAnchorsSql } from '../../memory/persist-anchors';
import { journalPendingWrite, markJournalCommitted } from '../../memory/write-journal';
import { isMemoryPaused, MEMORY_PAUSED_REFUSAL } from '../../memory/memory-pause';
import { detectPossibleSecrets, possibleSecretWarning } from '../../memory/secret-detect';
import { getSessionUserOrDefault } from '../../auth';
import { resolveFactFederationSlug } from '../../agent-facts/store';
import { hardText, LIMITS } from '../limits';
import { coerceMemoryKind } from './remember-coerce';
import { trackDetached } from '../../detached-imports';
import { sealSharedText } from '../../personal-vault/shared-store-seal';
import { DisclosureRefused } from '../../personal-vault/disclosure-ledger';
import { disclosureSubject } from '../_disclosure-subject';

// The store holds only STABLE facts (docs-and-memory-as-projections-2026-06-05 D-006).
// The `ephemeral` kind was retired — ephemeral state belongs in coord (delta-
// delivered, never re-pushed), not in a semantic store.
//
// Taxonomy unified on the Claude-file generation (memory-taxonomy-and-debt-
// followups D-001): user (who they are) / feedback (how to work — corrections
// AND confirmed approaches) / project (ongoing work context) / reference
// (pointers + hard-won technical facts). The legacy mem0 kinds
// (identity/preference/correction) still read fine — typeForKind keeps their
// mappings — but new writes use the unified set.
const KINDS = ['user', 'feedback', 'project', 'reference'] as const;

/**
 * P-016: dedup-on-write similarity threshold. Tunable via env. A score
 * above this against the top-K nearest existing memory in the same
 * scope triggers a "similar_exists" rejection (bypassable via
 * `force: true`).
 *
 * Disabled by default (set PAPERCUSP_MEMORY_DEDUP=on to enable).
 * Ramp-up plan: ship off; turn on once Layer 1 audit reports the
 * actual dedup pressure isn't going to false-positive on real writes.
 *
 * Evaluated at call time (not module load) so tests can flip the env
 * per-test without resetting the module.
 */
function dedupEnabled(): boolean {
  return process.env.PAPERCUSP_MEMORY_DEDUP === 'on';
}

/**
 * EI-10048 write-time ref-expansion: resolve WI-/EI-/F-/D- refs in the body to
 * their titles and fold them into the EMBEDDED text (stored text unchanged) so
 * a ref-only memory also matches queries about the referenced item's topic.
 * Default ON; set PAPERCUSP_MEMORY_REF_EXPANSION=off for an instant kill switch
 * (best-effort + vector-only, so disabling it only reverts to baseline
 * embedding — it can never corrupt a write). Evaluated at call time so ops/tests
 * flip it without a module reset.
 */
function refExpansionEnabled(): boolean {
  return process.env.PAPERCUSP_MEMORY_REF_EXPANSION !== 'off';
}
/**
 * The similarity bar for a "similar_exists" refusal, on 0..1.
 *
 * EI-10544: this is compared against `lexicalSimilarity` (trigram-Jaccard, a
 * METRIC), NOT against the backend's `score`. The live hybrid backend scores by
 * RRF rank-fusion — an ORDINAL quantity, where the top hit is 1/(60+1) ≈ 0.0164
 * whether it is a byte-identical duplicate or merely the best of a bad lot. This
 * threshold's own 0..1 clamp encodes a cosine assumption the backend stopped
 * honouring, so the guard was unreachable: flipping PAPERCUSP_MEMORY_DEDUP=on
 * would have silently deduplicated NOTHING. No constant fixes that — re-tuning
 * into the RRF band would refuse EVERY write instead, since the top neighbour
 * always scores ~1/61. The quantity had to change, not the number.
 */
function dedupThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_DEDUP_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.9;
}
const DEDUP_TOP_K = 3;

/**
 * Cap on the TEXT used as the neighbour-search QUERY (P-008).
 *
 * The neighbour lookup used to pass the ENTIRE memory body as its query, which
 * meant the query vector — and therefore the write's latency — scaled with body
 * length. Measured 2026-07-26 (bench/write-latency-trace-cli.ts, live backend,
 * medians of 4): 982ms at 250 chars, 2,225ms at 1,200, 3,222ms at 3,000, against
 * a real-world body p50 of 1,189 chars and p95 of 2,553 (327 live writes/30d).
 *
 * This bound is the RECURRENCE GUARD for that cost class. The capability gate
 * below (skip the search when nothing can consume it) is not sufficient on its
 * own: the moment anyone sets ANTHROPIC_API_KEY the search comes back, and with
 * a real judge call on top of it. Bounding the query means enabling conflict-
 * check costs a bounded search, not a body-proportional one.
 *
 * Safe because the backend only RETRIEVES candidates here — it does not decide
 * anything. The dedup JUDGEMENT is made on the FULL text via `lexicalSimilarity`
 * (EI-10544: a fused RRF score is ordinal and cannot make that call), and the
 * conflict judge receives the full `newText` regardless. So the only effect is
 * on which neighbours get retrieved: a long body's opening ~512 chars carry the
 * subject it is about, and a near-duplicate of a long fact overwhelmingly shares
 * that opening. The trade is slightly weaker retrieval on the tail of very long
 * bodies, in exchange for removing the dominant term of the write path.
 *
 * Env-tunable, evaluated at call time so tests/ops can flip it without a module
 * reset; <= 0 restores the old unbounded behaviour.
 */
function neighbourQueryMaxChars(): number {
  const raw = Number(process.env.PAPERCUSP_MEMORY_NEIGHBOUR_QUERY_CHARS);
  return Number.isFinite(raw) ? raw : 512;
}

/** The bounded text handed to `backend.search` as the neighbour query. Exported
 *  for the P-009 recurrence test, which asserts a long body is NOT passed whole. */
export function neighbourSearchQuery(content: string): string {
  const max = neighbourQueryMaxChars();
  if (max <= 0 || content.length <= max) return content;
  return content.slice(0, max);
}

// EI-2032: memory↔agent-insights boundary nudge. Memory is for SHORT facts
// recalled semantically EVERY turn; long-form runbooks belong in agent-insights
// (versioned MDX, pulled on demand). A write that is large AND structured
// (markdown headers / many bullets / many lines) reads like a runbook parked in
// the wrong store — the exact overlap the audit found (36 memories >2KB). Return
// a NON-BLOCKING hint steering it to agent-insights (mirrors the Claude-local
// memory-boundary-check.mjs nudge); the write still lands. Tunable via env.
const RUNBOOK_HINT_MIN_CHARS = (() => {
  const raw = Number(process.env.PAPERCUSP_MEMORY_RUNBOOK_HINT_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1200;
})();
export function runbookShapeHint(content: string): string | null {
  if (!content || content.length < RUNBOOK_HINT_MIN_CHARS) return null;
  const lines = content.split('\n');
  const headers = lines.filter((l) => /^\s{0,3}#{1,6}\s/.test(l)).length;
  const bullets = lines.filter((l) => /^\s*(?:[-*]|\d+[.)])\s/.test(l)).length;
  const structured = headers >= 1 || bullets >= 3 || lines.length >= 6;
  if (!structured) return null;
  return (
    `This memory is ${content.length} chars and reads like a runbook (multi-section). ` +
    `Memory is for SHORT facts recalled every turn; long-form runbooks belong in ` +
    `agent-insights — author an MDX under apps/operator-docs/src/content/docs/agent-insights/ ` +
    `(or harness:docs) and keep the memory to a one-line takeaway + a pointer. ` +
    `(Stored anyway — this is a nudge, not a block.)`
  );
}

export default defineTool({
  name: 'memory:remember',
  capability: 'memory:write',
  description:
    'Store a STABLE fact about the user into persistent memory, kept VERBATIM as written. Use one of 4 kinds (user / feedback / project / reference). Write ONE tight, self-contained fact per call. For transient state, use coord — not memory.',
  guidance: {
    when:
      'When the user says "remember X" / "don\'t forget Y" / "next time…" / "from now on…", OR when YOU notice an error you made that would recur without persistence. ALWAYS inform the user out loud ("I\'ll remember that"). For project-specific facts, pass harness_slug — the fact then surfaces for anyone working in that harness. Write ONE self-contained fact per call, tightly phrased: it is stored EXACTLY as written (no server-side rewriting or condensing), so make it stand on its own, lead with the searchable terms/anchors (file paths, F-NNN, backticked symbols), and drop conversational preamble.',
    notWhen:
      'Default scope is per-user. Do not pass harness_slug for personal preferences. For IN-FLIGHT / ephemeral state (what you are doing right now), use coord (coord:declare-intent / coord:send) — it is delta-delivered, not a semantic store. Lifecycle choice: use `supersede:<old-id>` when this NEW fact replaces an old fact and history matters; use memory:update to correct the SAME fact in place while preserving its id; use memory:forget only for removal (hard for privacy, soft when history should remain without a replacement).',
    chaining:
      'After writing, the persona prompt will surface this entry on the next turn\'s pre-turn injection. No need to call memory:search to verify.',
    seeAlso: [
      'memory:search (recall / dedup before writing a new fact)',
      'memory:update (amend an existing memory instead of duplicating)',
      'coord:declare-intent (in-flight state belongs here, not in a durable memory)',
    ],
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // Cross-workspace store (see memory:search) — handler rides getMemoryBackend /
  // getOrgPg, never ctx.tx. crossWorkspace:true lets an UNSCOPED superuser (psu)
  // session write instead of failing `workspace_required`.
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  // WI-1982: normalise a mis-used `kind` (a legacy kind, a free-form label, or missing)
  // to the closest valid enum member BEFORE validation, so a durable fact is never
  // rejected+LOST on the enum. `content` is untouched (a genuinely-missing fact must
  // still fail — the double-encoded-args class is a separate dispatch-layer fix).
  args: z.preprocess(
    coerceMemoryKind,
    z.object({
    content: hardText(LIMITS.CONTENT),
    kind: z.enum(KINDS),
    harness_slug: z.string().optional()
      .describe('Scope to a specific harness (project). Anyone with access to that harness will see this memory in their recall. Omit for a personal (per-user) fact.'),
    hive_slug: z.string().optional()
      .describe("Scope to a Pot's SHARED pool (knowledge-packs P-004) — every agent in every member harness of that pot recalls it. Use for discovered project conventions (test command, build path, design system) the whole pot should inherit. Mutually exclusive with harness_slug."),
    force: z.boolean().optional()
      .describe('Bypass the dedup-on-write similarity check (P-016). Use only when knowingly writing a near-duplicate the agent has decided to keep separate. Default: false.'),
    supersede: z.string().uuid('supersede must be a valid memory UUID').optional()
      .describe('Write this fact as the replacement for the given memory id (temporal-lite): after the new row lands, close the old row\'s validity window with superseded_by = the new id. This is the one-call resolution for a conflict refusal.'),
    shareable: z.boolean().optional()
      .describe('OPT-IN federation egress (F0-2): true = this memory may federate to other hives. Default false — memories are hive-private.'),
    workspace: z.string().optional()
      .describe('Superuser-only: from an UNSCOPED session, tag the write under THIS workspace (the resolved workspace lands in metadata.workspace_id). Scoped/power-user sessions ignore it.'),
    }),
  ),
  async handler(args, ctx) {
    let user: Awaited<ReturnType<typeof getSessionUserOrDefault>>;
    try {
      user = await withMemoryTimeout(
        getSessionUserOrDefault(),
        'memory:remember user resolution',
        memoryToolTimeoutMs(),
      );
    } catch (err) {
      if (!(err instanceof MemoryTimeoutError)) throw err;
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          stored: false,
          reason: 'memory_timeout',
          step: 'user_resolution',
        }) }],
      };
    }
    // EI-10355: the user's "stop remembering things about me" switch. Checked
    // BEFORE journalPendingWrite() below — a paused write must leave NO pending
    // journal row, or the embed-backfill drain would resurrect it and store the
    // memory anyway on resume (a pause that merely defers is not a pause).
    let paused = false;
    try {
      paused = await withMemoryTimeout(
        isMemoryPaused(user.id),
        'memory:remember pause lookup',
        memoryToolTimeoutMs(),
      );
    } catch (err) {
      if (!(err instanceof MemoryTimeoutError)) throw err;
      // isMemoryPaused deliberately fails open on an unavailable PG read; a
      // timeout is the same unavailable-read case, and the write path keeps
      // the existing consent semantics while bounding the wait.
    }
    if (paused) {
      return {
        content: [{ type: 'text', text: JSON.stringify(MEMORY_PAUSED_REFUSAL) }],
      };
    }
    // P-006/D-002: `shareable: true` is a federation EGRESS request, so the
    // dark flag must guard the product path itself — registering the flag in
    // DARK_FLAGS without reading it here leaves the supposedly-OFF feature
    // fully live. Fail closed on both an explicit OFF and a flag-store error,
    // and refuse BEFORE the write-ahead journal so a later replay cannot
    // resurrect a federation request made while the feature was dark.
    if (args.shareable === true) {
      let federationEnabled = false;
      try {
        federationEnabled = await withMemoryTimeout(
          Promise.resolve()
            .then(() => getFlag(FLAGS.MEM0_FEDERATION_EGRESS, 'system'))
            .catch(() => false),
          'memory:remember federation egress flag',
          memoryToolTimeoutMs(),
        );
      } catch (err) {
        if (!(err instanceof MemoryTimeoutError)) throw err;
        // This flag is an egress safety rail: an unavailable read stays closed.
      }
      if (!federationEnabled) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            stored: false,
            reason: 'mem0_federation_disabled',
            message:
              'Shareable memory federation is disabled. Omit `shareable` to store ' +
              'this memory privately, or enable papercusp-mem0-federation-egress ' +
              'before retrying the federated write.',
          }) }],
        };
      }
    }
    const backend = getMemoryBackend();
    const invalidateSuperseded = args.supersede
      ? backend.invalidateEntry?.bind(backend)
      : undefined;
    // P-005: refuse before journaling/writing when this backend cannot honour
    // the requested lifecycle transition. A plain remember followed by an
    // unsupported invalidate would leave two current, contradictory facts.
    if (args.supersede && !invalidateSuperseded) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          ok: false,
          reason: 'supersede_unsupported',
          message: 'supersede requires a backend with validity-window support (temporal-lite unavailable)',
        }) }],
      };
    }
    if (args.harness_slug && args.hive_slug) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'harness_slug and hive_slug are mutually exclusive — pick the pool the fact belongs to.' }) }],
      };
    }
    let scopeKey: string;
    let scope: 'user' | 'harness' | 'hive';
    if (args.hive_slug) {
      // knowledge-packs P-004: the Hive's shared pool — recalled by every agent
      // in every member harness (injection resolves member→hive).
      scopeKey = `hive:${args.hive_slug}`;
      scope = 'hive';
    } else if (args.harness_slug) {
      scopeKey = `harness:${args.harness_slug}`;
      scope = 'harness';
    } else {
      scopeKey = user.id;
      scope = 'user';
    }

    // personal-data-reader-set-labels P-012 / D-006: a harness/hive pool is read by
    // every agent in it, so a writer holding a restricted Personal Vault disclosure
    // stores a sealed stub there. Sealed BEFORE anchor extraction and the
    // write-ahead journal, both of which persist the content. Owner-scoped (user)
    // memory is read only by its owner and is never sealed.
    if (scope !== 'user') {
      try {
        const sealed = await sealSharedText(() => getOrgPg().sql, {
          workspaceId: ctx.principal?.workspaceId ?? ctx.workspaceId,
          writerOwnerId: disclosureSubject(ctx),
          store: 'memory',
          text: args.content,
          context: { scope: scopeKey, kind: args.kind },
        });
        if (sealed.sealed) args = { ...args, content: sealed.text };
      } catch (error) {
        if (!(error instanceof DisclosureRefused)) throw error;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, stored: false, reason: error.code, message: error.message }) }],
        };
      }
    }

    // Supersession authorization/link-integrity preflight. The target must be
    // a real current memory in the exact pool this write is authorized to use;
    // UUID shape alone is not authority, and mem0 entity rows are not facts.
    if (args.supersede) {
      const target = await withMemoryToolTimeout(backend.get(args.supersede), 'memory:remember supersede preflight');
      if (!target) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'supersede_not_found' }) }] };
      }
      if (target.metadata?.entityType) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'supersede_entity_forbidden' }) }] };
      }
      if (!target.scope || target.scope !== scopeKey) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'supersede_scope_mismatch' }) }] };
      }
      const validity = target.metadata?.validity as { status?: unknown } | undefined;
      if (validity?.status === 'superseded') {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'supersede_already_closed' }) }] };
      }
    }

    const metadata: Record<string, unknown> = {
      scope,
      // The principal carries the resolved workspace (incl. a per-call
      // `workspace` pin from an unscoped SU session). The old read,
      // `ctx.workspaceId`, was never populated on principal-gated handlers
      // — every prior write stored workspace_id: undefined (P-004).
      workspace_id: ctx.principal?.workspaceId,
      created_by: user.id,
      display_name: user.display_name,
      // EI-10358: source attribution for the dominant (agent) write path.
      // `ctx.role` / `ctx.uiClientId` are ALREADY threaded onto every
      // UnifiedToolContext by the MCP dispatch layer (BuiltSpawnContext →
      // buildMcpToolContext, packages/operator-core/lib/endpoint-route/
      // routes/transport/_mcp-handler.ts) — no dispatch-spine plumbing was
      // actually required, only reading them here. `ctx.principal` always
      // resolves to the shared `system:superuser` principal on su sessions,
      // which is why that field alone couldn't answer "who wrote this" —
      // role/uiClientId carry the real per-session identity instead.
      source: 'agent',
      ...(ctx.role ? { source_role: ctx.role } : {}),
      ...(ctx.uiClientId ? { source_session: ctx.uiClientId } : {}),
    };
    if (args.harness_slug) metadata.harness_slug = args.harness_slug;
    if (args.hive_slug) metadata.hive_slug = args.hive_slug;
    if (ctx.uiClientId && ctx.principal?.workspaceId) {
      const { wornMemoryIdentityIds } = await import('../../knowledge-packs/identity-learning');
      try {
        metadata.worn_identity_ids = await withMemoryTimeout(
          wornMemoryIdentityIds(ctx.uiClientId, ctx.principal.workspaceId),
          'memory:remember identity provenance',
          memoryToolTimeoutMs(),
        );
      } catch (err) {
        if (!(err instanceof MemoryTimeoutError)) throw err;
        // Provenance stays fail-closed: if the applied identity cannot be read,
        // do not store an unstamped memory. Return promptly instead of leaving
        // the caller behind an unbounded pre-write lookup.
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            stored: false,
            reason: 'memory_timeout',
            step: 'identity_provenance',
          }) }],
        };
      }
    }

    // EI-10432 — federation egress needs a ROUTING KEY, and this path never set
    // one. `shareable: true` alone lands the row with memory_canonical.harness_slug
    // NULL (mem0's CanonicalVectorStore.insert writes only id/payload/timestamps),
    // the capture trigger enqueues the op under a NULL slug, and the drain selects
    // `WHERE harness_slug = $slug` — which NULL never matches. The op is captured,
    // stranded, and eventually reaped by the backstop GC: the memory federates to
    // nobody and NOTHING errors. assertFact (agent-facts/store.ts) already refuses
    // this exact hazard loudly ("captured then stranded ... Refuse LOUDLY rather
    // than silently strand"); mirror it here.
    //
    // The resolved slug rides `payload.fed_harness_slug`, which mig 587's BEFORE
    // INSERT trigger copies onto the row's harness_slug column — mem0 owns the
    // INSERT and writes only `payload`, so the payload is the only seam we have.
    // (The column canNOT be GENERATED from payload: the receive-side projection
    // inserts harness_slug explicitly, and Postgres rejects an explicit value for
    // a generated column — see the workspace_id note in p2p-memories.ts.)
    //
    // A hive-scoped memory rides that hive; a harness-scoped one rides its hive
    // HOME (a member harness resolves to the home its peers' projection is bound
    // to). A personal/user-scoped memory has no hive to ride, so it is REFUSED
    // rather than silently routed to "the workspace's only hive" — inferring an
    // egress target is exactly what the D-006 privacy default exists to prevent.
    if (args.shareable === true) {
      let fedSlug: string | null;
      try {
        fedSlug = args.hive_slug
          ? args.hive_slug
          : await withMemoryTimeout(
              Promise.resolve().then(() => resolveFactFederationSlug(args.harness_slug)),
              'memory:remember federation scope resolution',
              memoryToolTimeoutMs(),
            );
      } catch (err) {
        if (!(err instanceof MemoryTimeoutError)) throw err;
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            stored: false,
            reason: 'memory_timeout',
            step: 'federation_scope',
          }) }],
        };
      }
      if (!fedSlug) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            stored: false,
            reason: 'shareable_memory_needs_federation_scope',
            message:
              'A shareable memory must name the pool it federates to: pass hive_slug ' +
              '(the Pot whose peers should receive it) or harness_slug (a harness whose ' +
              'hive home it can ride). A personal, user-scoped memory has no hive to ' +
              'federate to — it would be captured, stranded, and dropped on every peer. ' +
              'Omit `shareable` to store it privately instead.',
          }) }],
        };
      }
      metadata.fed_harness_slug = fedSlug;
    }

    // Phase 4 P-015: extract structural anchors from the body so Layer 1
    // (P-019) can later validate them with zero LLM cost. Anchors are
    // stored in metadata AND persisted to harness_shared.memory_anchors
    // post-add (below) so the audit + UI paths can find them.
    const anchors = anchorMetadata(args.content);
    if (anchors) {
      metadata.anchors = anchors.anchors;
      metadata.anchor_count = anchors.anchor_count;
    }

    // EI-10371 stage 1: flag credential-shaped content at write time. Detection
    // only — the text is stored UNCHANGED (masking/refusing is a product-policy
    // fork; the flag makes the liability visible first). Stamped BEFORE
    // journaling so an outage-parked row replays with the flag intact.
    const secrets = detectPossibleSecrets(args.content);
    if (secrets.matched) {
      metadata.possible_secret = true;
      metadata.possible_secret_classes = secrets.classes;
    }

    // Write-ahead journal (memory-write-journal-auto-recovery P-002/D-001):
    // park the fact durably BEFORE any embedder-dependent step. A plain PG
    // INSERT has no embedder dependency, so every failure branch below —
    // probe-fail, probe-timeout, write-timeout, unavailable, embed-fail —
    // leaves the row `pending` for the embed-backfill tick to replay, and
    // tells the agent so (journaled/will_retry). Deliberate refusals
    // (dedup/conflict) CLOSE the row so the drain never resurrects a write
    // the tool refused. journalId === null ⇒ journaling degraded (e.g. the
    // migration hasn't applied) — behavior is then exactly the old lossy path.
    let journalId: string | null;
    try {
      journalId = await withMemoryTimeout(journalPendingWrite({
        scope: scopeKey,
        kind: args.kind,
        content: args.content,
        // The internal marker never reaches the stored memory payload. It lets
        // the journal drain finish the SAME supersession if the embed/store or
        // validity-close leg fails after this call has durably parked the write.
        metadata: args.supersede
          ? { ...metadata, __journal_supersede_of: args.supersede }
          : metadata,
        verbatim: true,
        shareable: args.shareable,
      }), 'memory:remember write-ahead journal', memoryToolTimeoutMs());
    } catch (err) {
      if (!(err instanceof MemoryTimeoutError)) throw err;
      // Journaling is best-effort by contract. A late INSERT is reconciled by
      // the drain's near-duplicate guard; do not let it hold up the live write.
      journalId = null;
    }
    const journaledFields = journalId
      ? {
          journaled: true,
          will_retry: true,
          journal_id: journalId,
          hint: 'Fact journaled durably; it will be stored automatically once the embedder recovers — do NOT re-fire this write.',
        }
      : {};

    // B1: bound the connectivity probe — `available()` itself hangs when the
    // store is wedged (the 2026-06-19 outage), so a deadline here is the
    // difference between a fast `memory_timeout` and an infinite hang.
    // (Runs AFTER journaling so an outage detected here still parks the fact.)
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:remember available');
      if (!avail.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, ...journaledFields }) }],
        };
      }
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout', ...journaledFields }) }],
        };
      }
      throw err;
    }

    // Phase 4 P-016: dedup-on-write. Search the same scope for
    // near-duplicates before inserting. If similarity exceeds the
    // threshold, refuse and surface the existing memory_id so the agent
    // can decide to merge / forget-then-rewrite / force-through.
    //
    // Defensive: any failure of the search falls through to insert. The
    // dedup check is a hygiene layer, never load-bearing. Same posture
    // as injection.ts (failures degrade silently).
    // EI-2032: run the neighbor search when EITHER dedup (opt-in) OR the
    // conflict-check (default ON) is enabled. Previously the conflict-check was
    // nested INSIDE `if (dedupEnabled())`, so with dedup off-by-default the
    // contradiction gate never fired — a new memory could silently contradict an
    // existing one. Decoupled here: dedup-rejection stays gated on dedupEnabled()
    // (it is false-positive-prone, hence opt-in), but the conflict-check runs
    // independently whenever it is enabled.
    // P-007: only pay for the neighbour search if something can actually CONSUME
    // it. Dedup consumes it when opt-in is on; the conflict-check consumes it only
    // when a REAL judge can be built — a keyless `createAnthropicJudge()` returns
    // an instant no-op, so gating on `conflictCheckEnabled()` alone bought a full
    // semantic search (85-95% of this handler's cost) to feed nothing at all.
    // Measured before/after in plan memory-write-latency-2026-07-26 (D-001/D-002).
    const dedupWanted = !args.force && dedupEnabled();
    const conflictWanted = !args.force && conflictCheckEnabled();
    // P-009 (D-016): Jev when a Jev key is stored, else Anthropic, else NO judge,
    // reported as such rather than as a no-op that looks like "nothing found".
    let conflictJudge: Awaited<ReturnType<typeof resolveConflictJudge>> | null = null;
    if (conflictWanted) {
      try {
        conflictJudge = await withMemoryTimeout(
          Promise.resolve().then(() => resolveConflictJudge()),
          'memory:remember conflict-judge resolution',
          memoryToolTimeoutMs(),
        );
      } catch (err) {
        if (!(err instanceof MemoryTimeoutError)) throw err;
        // Conflict checking is advisory; an unavailable judge must not block the write.
        conflictJudge = { available: false, reason: 'memory_timeout' };
      }
    }
    // Configured ON but inert — say so ONCE. That silence is what let a default-ON
    // contradiction guard sit dead in this operator (EI-18746586784230719).
    if (conflictJudge && !conflictJudge.available) warnConflictJudgeUnavailableOnce();
    const usableJudge = conflictJudge?.available ? conflictJudge.judge : null;
    const conflictUsable = usableJudge !== null;
    // P-010 (plan jev-performance-improvements-2026-09-30): the Jev judge also asks,
    // in the SAME request, whether the new memory carries concrete information; a
    // memory that only claims its own relevance or importance is refused here, once,
    // instead of being filtered out of every later turn. Jev only (the question and
    // threshold were measured on Jev); the flag is the kill switch. A flag-store error
    // skips the check (fail open), since this is hygiene, not a safety rail.
    let substanceRefusalEnabled = false;
    if (conflictJudge?.available === true && conflictJudge.backend === 'jev') {
      try {
        substanceRefusalEnabled = await withMemoryTimeout(
          Promise.resolve()
            .then(() => getFlag(FLAGS.MEMORY_CONTENT_FREE_REFUSAL, 'system'))
            .catch(() => false),
          'memory:remember content-free refusal flag',
          memoryToolTimeoutMs(),
        );
      } catch (err) {
        if (!(err instanceof MemoryTimeoutError)) throw err;
        // This hygiene flag is fail-open: skip the optional content check on timeout.
      }
    }
    const substanceWanted =
      conflictJudge?.available === true &&
      conflictJudge.backend === 'jev' &&
      substanceRefusalEnabled;
    // Fail open, but never silently: when the check was wanted and no valid verdict
    // came back (Jev error, timeout, malformed answer, or the neighbour search
    // failing first), the save proceeds and both the stored row and the result say
    // `substance_check: 'unchecked'`, so the content-free sweep (P-011) can find it.
    let substanceUnchecked = substanceWanted;

    if (dedupWanted || conflictUsable) {
      try {
        // B1: bounded — a search hang must not block the write. On timeout this
        // throws into the surrounding catch, which proceeds with the write
        // (degraded dedup/conflict), exactly as a search error already does.
        // P-008: the QUERY is length-capped (see neighbourSearchQuery) so this
        // stays bounded instead of scaling with the body.
        const neighbors = await withMemoryToolTimeout(
          backend.search(neighbourSearchQuery(args.content), {
            scope: scopeKey,
            limit: DEDUP_TOP_K,
          }),
          'memory:remember dedup-search',
        );
        // P-016 dedup-on-write (opt-in via PAPERCUSP_MEMORY_DEDUP): refuse a
        // near-duplicate above the similarity threshold. The backend RETRIEVES
        // the candidates; the duplicate JUDGEMENT is made on the text itself
        // (EI-10544 — a fused RRF score is ordinal and cannot make it). Scan
        // ALL neighbors for the MOST SIMILAR one rather than trusting
        // neighbors[0]: memory decay (recency ranking bias, mem0-backend.ts)
        // re-orders search results by freshness, so the first row is not
        // necessarily the closest one.
        if (dedupWanted) {
          let top: (typeof neighbors)[number] | undefined;
          let best = -Infinity;
          for (const n of neighbors) {
            // The caller explicitly chose this old row as the one being
            // replaced. Exclude only that row; a different near-duplicate
            // must still refuse instead of turning supersede into force.
            if (n.id === args.supersede) continue;
            const sim = lexicalSimilarity(args.content, n.text);
            if (sim > best) {
              best = sim;
              top = n;
            }
          }
          const topScore = top !== undefined ? best : null;
          if (
            top &&
            topScore !== null &&
            topScore >= dedupThreshold()
          ) {
            // Deliberate refusal — close the journal row (content is already
            // in the store as `top`) so the drain never replays it.
            if (journalId) void markJournalCommitted(journalId, top.id);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  reason: 'similar_exists',
                  similar_memory_id: top.id,
                  similar_score: topScore,
                  similar_text: top.text,
                  hint: 'Set force=true to write anyway, or call memory:forget on the similar memory first.',
                }),
              }],
            };
          }
        }

        // P-017: conflict-check on the top-K neighbors (default ON via
        // PAPERCUSP_MEMORY_CONFLICT_CHECK; checkConflicts self-gates + degrades).
        // Catches a new fact that directly CONTRADICTS a near neighbor (Haiku
        // judges) even when dedup similarity did not trip — runs independently of
        // the dedup flag now. Bypassable via force=true.
        // `conflictUsable` (not just `conflictCheckEnabled()`) — with no real
        // judge this call could only ever return an empty report, and we no
        // longer even have neighbours to hand it in that case.
        if (usableJudge && (neighbors.length > 0 || substanceWanted)) {
          const conflict = await checkConflicts({
            newText: args.content,
            neighbors: neighbors.map((n) => ({ id: n.id, text: n.text, score: n.score })),
            judge: usableJudge,
            ...(substanceWanted ? { checkSubstance: true } : {}),
          });
          if (conflict.substance) substanceUnchecked = false;
          // P-010: a content-free memory is refused before any conflict is considered;
          // `supersede` names a conflict to resolve, not a reason to store an empty claim.
          if (conflict.substance?.contentFree) {
            if (journalId) void markJournalCommitted(journalId, null);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  reason: 'content_free',
                  p_concrete: conflict.substance.pConcrete,
                  summary: conflict.substance.summary,
                  hint:
                    'This memory only claims its own relevance or importance. Rewrite it to state the fact, decision, procedure, preference or value itself, or pass force=true to write it anyway.',
                }),
              }],
            };
          }
          // `supersede:<id>` is an explicit resolution of THAT conflict, not a
          // blanket force-through: any other contradiction still refuses.
          const unresolvedConflicts = conflict.conflicts.filter(
            (c) => c.memory_id !== args.supersede,
          );
          if (unresolvedConflicts.length > 0) {
            // Deliberate refusal — the agent must resolve the contradiction;
            // the drain must not land the conflicting write behind its back.
            if (journalId) void markJournalCommitted(journalId, null);
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  ok: false,
                  reason: 'conflict',
                  conflicts: unresolvedConflicts,
                  resolution_hint: 'pass supersede:<id> to record the new fact as replacing the old one',
                  hint: 'New memory directly contradicts existing memories. memory:forget the contradicted entries first, or pass force=true to write anyway.',
                }),
              }],
            };
          }
        }
      } catch {
        // dedup or conflict check failed — proceed with the write (degraded mode).
      }
    }

    // `available()` is only a CONNECTIVITY probe (the cosine leg's
    // reachability) — a RUNTIME embedder failure surfaces here, where
    // `backend.remember` THROWS `MemoryUnavailableError` per the backend
    // contract (backend.ts: "available() is the non-throwing probe; every
    // other method throws when the store is unreachable"). Without this
    // catch the throw escapes to the MCP dispatch wrapper, which renders it
    // as `{ isError: true, content: 'handler_error: memory backend
    // unavailable: <reason>' }` — an opaque, crash-shaped result that hides
    // the structured `reason` the agent can act on. Map it back to the SAME
    // clean `{ ok: false, reason }` envelope the upfront-unavailable branch
    // returns, so a down embedder reads identically whether it trips at
    // probe time or call time. A NON-MemoryUnavailableError throw is a real
    // bug — let it propagate to the framework's handler_error envelope.
    //
    // NOTE: this only makes the FAILURE legible — the write is still LOST on
    // an embedder outage (no degrade-to-lexical / vector-deferral here). The
    // deeper fix lives in the BACKEND and is an owner design decision (see
    // the GAP-1 FLAG in the agent report); this handler catch does not
    // attempt it.
    // EI-10048: resolve work-item-class refs in the body to their titles and
    // fold them into the EMBEDDED text (stored text stays exactly args.content).
    // Best-effort + bounded (≤MAX_REFS PK lookups, each guarded) — never
    // load-bearing, mirroring the anchor/dedup posture already on this path; a
    // failure or a null resolve just leaves the baseline clean-text embedding.
    const embedText = refExpansionEnabled()
      ? await expandRefsForEmbed(args.content, async (id) => {
          const w = await getWorkItem(id);
          return w?.title ? { id, title: w.title } : null;
        }).catch(() => undefined)
      : undefined;

    if (substanceUnchecked) metadata.substance_check = 'unchecked';

    let ids: string[];
    try {
      // B1: bounded so a wedged embedder/store returns `memory_timeout` instead
      // of riding the ~55–60s transport cap out to an apparent infinite hang.
      // EI-6684: wrapped in withMemoryWriteRetry so a TRANSIENT write-path stall
      // (the reported "2x memory_timeout in a row") gets a bounded retry instead
      // of silently dropping the fact on the first timeout. Each retry re-issues
      // a fresh backend.remember (a factory) since a settled promise can't be
      // re-awaited. A sustained wedge fails fast (the degraded-latch skip).
      ({ ids } = await withMemoryWriteRetry(() => backend.remember(args.content, {
        scope: scopeKey,
        kind: args.kind,
        metadata,
        shareable: args.shareable,
        // EI-10048: enriched embed-text (clean body + resolved ref titles);
        // omitted when no refs resolved so the backend keeps baseline embedding.
        ...(embedText ? { embedText } : {}),
        // Store the agent's text VERBATIM (infer:false) — do NOT run mem0's
        // LLM fact-extraction/condense step on the explicit single-fact write
        // path. That step is an unbounded Anthropic (Haiku) call with no
        // timeout; under the busy-fleet 429 backoff it routinely outlived the
        // MCP client's request timeout (~60s) and dropped the transport
        // mid-call — the PG insert committed, but the caller saw "transport
        // dropped; response lost" and blind-retried into near-duplicates
        // (EI-178). An explicit remember is already a clean one-line fact the
        // agent wrote deliberately, so condensation adds little here; the
        // conversation-extraction path (backend.rememberConversation) keeps the
        // LLM extraction, where pulling facts out of a chat window earns it.
        verbatim: true,
      }), 'memory:remember remember'));
    } catch (err) {
      // Every legible write-failure class below leaves the journal row
      // `pending` — the embed-backfill tick replays it (with a near-dup
      // guard, since a timeout may mean the write actually landed and the
      // response was lost — the EI-178 blind-retry class).
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout', ...journaledFields }) }],
        };
      }
      if (err instanceof MemoryUnavailableError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err.reason, ...journaledFields }) }],
        };
      }
      // mem0-timeout-fix-2026-06-24: a fast-failed embed (org TPM 429 / 5xx / stall) surfaces
      // as a CLEAN reason so the agent narrates accurately instead of as an opaque handler_error.
      const embedReason = embedFailureReason(err);
      if (embedReason) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: embedReason, ...journaledFields }) }],
        };
      }
      throw err;
    }

    // P-005 one-call conflict resolution: the replacement must exist before
    // the old window closes, matching memory:update's established ordering.
    // A failed close leaves the write-ahead journal pending; its replay finds
    // this newly written fact via the near-dup guard and retries the close,
    // rather than losing the caller's supersession intent.
    let superseded: string | false | undefined;
    let supersedeNote: string | undefined;
    if (args.supersede && invalidateSuperseded) {
      const replacingId = ids[0];
      if (!replacingId) {
        superseded = false;
        supersedeNote = 'write returned no replacement id; old memory was not superseded';
      } else {
        try {
          const closed = await withMemoryToolTimeout(
            invalidateSuperseded(args.supersede, { supersededBy: replacingId }),
            'memory:remember supersede',
          );
          superseded = closed ? args.supersede : false;
          if (!closed) {
            const after = await withMemoryToolTimeout(backend.get(args.supersede), 'memory:remember supersede reconcile');
            const validity = after?.metadata?.validity as { superseded_by?: unknown } | undefined;
            if (validity?.superseded_by === replacingId) {
              superseded = args.supersede;
            } else {
              // Another immutable winner closed the old row first. Close this
              // losing replacement so the race cannot leave two current facts.
              await withMemoryToolTimeout(
                invalidateSuperseded(replacingId),
                'memory:remember supersede loser cleanup',
              );
              supersedeNote = 'another replacement won; this losing replacement was closed';
            }
          }
        } catch (err) {
          superseded = false;
          supersedeNote = `replacement stored but supersession will retry: ${
            err instanceof MemoryTimeoutError
              ? 'memory_timeout'
              : err instanceof Error
                ? err.message
                : String(err)
          }`;
        }
      }
    }

    // The write landed. Close the journal row only when no supersession was
    // requested or its validity close completed. A false/failed close stays
    // pending so the drain can reconcile it without another agent call.
    if (journalId && (!args.supersede || superseded === args.supersede)) {
      void markJournalCommitted(journalId, ids[0] ?? null);
    }

    // Live-refresh the settings memory page (userMemory.list sync query) —
    // fire-and-forget, never load-bearing (memory-settings-page-refresh P-008).
    void trackDetached(import('../../memory/invalidate-user-memory-views'))
      .then(({ invalidateUserMemoryViews }) => invalidateUserMemoryViews())
      .catch(() => { /* best-effort */ });

    // Phase 4 P-015: persist anchors to harness_shared.memory_anchors so
    // Layer 1 (audit-memory-anchors.ts) and the settings-UI broken_anchors
    // enrichment can find them. Fire-and-forget — never load-bearing on
    // the write path; same posture as bumpLastSurfacedSql in injection.ts.
    if (anchors && ids.length > 0) {
      void (async () => {
        try {
          const { sql } = getOrgPg();
          for (const id of ids) {
            await persistAnchorsSql(sql, id, anchors.anchors);
          }
        } catch {
          /* swallow — never load-bearing on the store write path */
        }
      })();
    }

    // EI-2032: nudge runbook-shaped writes toward agent-insights (non-blocking).
    const runbookHint = runbookShapeHint(args.content);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          ids,
          ...(args.supersede
            ? {
                superseded: superseded ?? false,
                ...(supersedeNote ? { supersede_note: supersedeNote } : {}),
                ...(journalId && superseded !== args.supersede
                  ? {
                      journaled: true,
                      will_retry: true,
                      journal_id: journalId,
                      retry_hint: 'Replacement stored; the journal will retry closing the old memory — do NOT re-fire this write.',
                    }
                  : {}),
              }
            : {}),
          // EI-10371: tell the agent out loud so it can tell the user — the
          // metadata stamp alone is invisible until someone opens settings.
          ...(secrets.matched
            ? {
                possible_secret: true,
                possible_secret_classes: secrets.classes,
                warning: possibleSecretWarning(secrets.classes),
              }
            : {}),
          ...(runbookHint ? { hint: runbookHint } : {}),
          ...(substanceUnchecked ? { substance_check: 'unchecked' } : {}),
        }),
      }],
    };
  },
});
