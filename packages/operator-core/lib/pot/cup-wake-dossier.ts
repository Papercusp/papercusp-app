/**
 * cup-wake-dossier — the cup's precomputed per-task work-item dossier
 * (bee-context-efficiency-2026-06-14 Phase 2 / P-007, D-004 / D-008 / D-009).
 *
 * The cup translation of `computeMugWakeBrief` (mug-brief.ts): the precomputed
 * WORLD-STATE a cup would otherwise gather through `work_items:get` / `plans:get` /
 * `coord:presence` round-trips at the start of every task. Injected in the VOLATILE
 * TAIL (a sibling of the mug brief + the work-item checkpoint), NEVER the
 * cacheable preamble (D-004) — so it never invalidates the fleet-shared cached prefix.
 *
 * SCOPE — the D-009 one-seam boundary, ratified with su-0de71 + su-7b271:
 *   - THIS module = precomputed WORLD-STATE: the work-item text, its linked plan
 *     item, its outgoing `blocks` edges (what it gates downstream), its topics, and
 *     the D-008 pot-peer ROSTER snapshot.
 *   - NOT here (sibling volatile-tail sections the ONE hydration seam composes, with
 *     different sources + lifecycles, so they do NOT merge into the dossier):
 *       · the blocked-by PREDECESSOR completion summaries — the spawn-handoff
 *         (directed-wake `getSpawnHandoffContext`);
 *       · the cup's own in-flight CHECKPOINT (`getWorkItemCheckpoint`, su-0de71).
 *
 * Fail-soft (D-004): the CORE read = the work-item — null ⇒ null dossier ⇒ the cup
 * falls back to its read tools. Every ancillary section is best-effort: a flaky read
 * degrades THAT section, never the whole dossier. The renderer is PURE + deterministic
 * (no Date.now / Math.random), so it unit-tests with no DB and renders stable bytes.
 */
import type { WorkItem, WorkItemDetail } from '../work-items';
// Type-only (erased at runtime), so the standing-facts fold below keeps its
// DYNAMIC import of ../agent-facts/store — no new runtime dependency.
import type { FactSelector } from '../agent-facts/store';

/** A live pot peer in the roster snapshot (D-008), projected from a presence row. */
export interface CupRosterPeer {
  id: string;
  label?: string | null;
  role?: string | null;
  /** The peer's declared intent (short) — what it is doing. */
  doing?: string | null;
  alive: boolean;
}

/** Per-section caps so the dossier stays a DIGEST, never a raw dump (mirrors the mug brief). */
export interface CupDossierCaps {
  blocks: number;
  topics: number;
  comments: number;
  roster: number;
}
export const DEFAULT_CUP_DOSSIER_CAPS: CupDossierCaps = { blocks: 12, topics: 12, comments: 6, roster: 20 };

export interface CupDossierInput {
  /** The work-item (core — required). */
  item: WorkItem;
  /** The linked plan item ref/label, if any (from the item's plan_item edge). */
  planItem?: string | null;
  /** Ids/labels this item BLOCKS downstream (outgoing `blocks` edges). */
  blocks?: readonly string[];
  /** Topic tags on the item. */
  topics?: readonly string[];
  /** Recent thread comments on the item, newest-first, each a pre-trimmed `author: body`. */
  comments?: readonly string[];
  /** The pot-peer roster snapshot (D-008) — live peers the cup shares the pot with. */
  roster?: readonly CupRosterPeer[];
  /** STANDING FACTS (mug-memory-hybrid L1c) — pre-rendered deterministic fold
   *  (workspace + role:cup + harness + this work_item scopes). Verbatim delivery. */
  factsFold?: string | null;
  /** BACKGROUND RECALL (mug-memory-hybrid L1d) — fuzzy mem0 sibling of the facts
   *  fold above, pre-rendered via the shared buildMemoryContextBlock pipeline
   *  (harness + hive pools, relevance-floored, fail-soft). Verbatim delivery. */
  memoryFold?: string | null;
  caps?: Partial<CupDossierCaps>;
}

/**
 * Render the cup's work-item dossier as a deterministic markdown block. Pass the
 * result to the spawn/wake-hydration seam, which injects it in the volatile tail as
 * a `<system-reminder>` (a sibling of the checkpoint + handoff sections, D-009) — the
 * renderer does NOT add those tags; the prompt assembler does. PURE.
 */
export function renderCupDossier(input: CupDossierInput): string {
  const caps = { ...DEFAULT_CUP_DOSSIER_CAPS, ...input.caps };
  const it = input.item;
  const out: string[] = [];

  out.push('## Your work-item dossier — precomputed');
  out.push(
    'The work-item you are (re)spawning on, precomputed so you can start without the ' +
      'usual `work_items:get` / `plans:get` / `coord:presence` round-trips. Act on it; ' +
      'reach for a tool only for detail this digest omits.',
  );

  out.push('');
  out.push(`**${it.id}** — ${it.title} [${it.kind} · ${it.state}]${it.harness ? ` · ${it.harness}` : ''}`);
  if (it.origin === 'remote') {
    out.push(
      `_remote work · audit ${it.auditVerdict ?? 'pending'}` +
        `${it.verifiedAuthorGithubUserId != null ? ` · author gh:${it.verifiedAuthorGithubUserId}` : ''}_`,
    );
  }
  if (it.summary && it.summary.trim()) {
    out.push('');
    out.push(it.summary.trim());
  }

  if (input.planItem && input.planItem.trim()) {
    out.push('');
    out.push(`### Plan`);
    out.push(`- ${input.planItem.trim()}`);
  }

  const blocks = input.blocks ?? [];
  if (blocks.length > 0) {
    out.push('');
    out.push('### Blocks downstream (this item gates)');
    for (const b of blocks.slice(0, caps.blocks)) out.push(`- ${b}`);
    const overflow = blocks.length - caps.blocks;
    if (overflow > 0) out.push(`…+${overflow} more`);
  }

  const topics = input.topics ?? [];
  if (topics.length > 0) {
    out.push('');
    out.push('### Topics');
    out.push(topics.slice(0, caps.topics).join(', '));
  }

  const comments = input.comments ?? [];
  if (comments.length > 0) {
    out.push('');
    out.push('### Recent comments (newest first)');
    for (const c of comments.slice(0, caps.comments)) out.push(`- ${c}`);
    const overflow = comments.length - caps.comments;
    if (overflow > 0) out.push(`…+${overflow} more (work_items:get to read the full thread)`);
  }

  const roster = input.roster ?? [];
  if (roster.length > 0) {
    out.push('');
    out.push('### Pot peers (live roster snapshot)');
    for (const p of roster.slice(0, caps.roster)) {
      out.push(
        `- ${p.label || p.id}${p.role ? ` (${p.role})` : ''}${p.doing ? ` — ${p.doing}` : ''}${p.alive ? '' : ' [stale]'}`,
      );
    }
    const overflow = roster.length - caps.roster;
    if (overflow > 0) out.push(`…+${overflow} more (coord:presence to drill down)`);
  }

  // STANDING FACTS (L1c) — deterministic scoped conclusions, delivered verbatim.
  const factsFold = (input.factsFold ?? '').trim();
  if (factsFold) {
    out.push('');
    out.push(factsFold);
  }

  // BACKGROUND RECALL (L1d) — fuzzy mem0 sibling of the facts fold above.
  const memoryFold = (input.memoryFold ?? '').trim();
  if (memoryFold) {
    out.push('');
    out.push(memoryFold);
  }

  return out.join('\n');
}

// ───────────────────────── the compute (fail-soft IO over injectable deps) ─────────────────────────

/** The IO the compute orchestrates — injected so the function unit-tests with no DB. */
export interface CupDossierDeps {
  /** The work-item + its coord-substrate detail (links/topics). Throws ⇒ caught. */
  getDetail(id: string, harness: string): Promise<WorkItemDetail | null>;
  /** The bare work-item — the fallback when the detail read throws (core still renders). */
  getItem(id: string, harness: string): Promise<WorkItem | null>;
  /** The pot-peer roster (D-008), already projected to {@link CupRosterPeer}. */
  listRoster(workspaceId: string): Promise<CupRosterPeer[]>;
}

/** Best-effort label for a link's `dst` ObjectRef — id/slug/ref, else a compact JSON. */
function dstLabel(dst: unknown): string {
  const d = dst as { id?: string; slug?: string; ref?: string } | null | undefined;
  return d?.id ?? d?.slug ?? d?.ref ?? (d ? JSON.stringify(d).slice(0, 80) : '?');
}

/** Project a presence row to a roster peer — defensive (the exact PresenceRecord
 *  shape lives in another package; we read only the stable fields). */
export function presenceToRosterPeer(row: unknown): CupRosterPeer {
  const r = row as {
    ownerId?: string;
    ownerLabel?: string | null;
    agentRole?: string | null;
    intent?: string | null;
    stale?: boolean;
  };
  return {
    id: r.ownerId ?? '?',
    label: r.ownerLabel ?? null,
    role: r.agentRole ?? null,
    doing: r.intent ? r.intent.slice(0, 100) : null,
    alive: r.stale !== true,
  };
}

function defaultDeps(): CupDossierDeps {
  return {
    getDetail: async (id, harness) => (await import('../work-items')).getWorkItemDetail(id, harness),
    getItem: async (id, harness) => (await import('../work-items')).getWorkItem(id, harness),
    listRoster: async (workspaceId) => {
      const { listPresence } = await import('../agent-tools/coordination/presence');
      const rows = await listPresence({ workspaceId });
      return rows.map(presenceToRosterPeer);
    },
  };
}

export interface ComputeCupWakeDossierInput {
  workspaceId: string;
  harness: string;
  workItemId: string;
  /**
   * The SPAWNING agent's role, threaded from the spawn seam (EI-20089384158051187).
   * Selects the `role` leg of the standing-facts fold. OMITTED ⇒ that leg is skipped
   * entirely — folding facts for a role the agent is not is strictly worse than
   * folding none, so this never falls back to a guess.
   */
  role?: string;
  caps?: Partial<CupDossierCaps>;
  /** Injected for tests; defaults read PG. */
  deps?: Partial<CupDossierDeps>;
}

/**
 * Precompute the cup's work-item dossier (P-007). CORE = the work-item (null ⇒ null
 * dossier ⇒ the cup uses its read tools, D-004); the plan/links/topics ride the
 * detail read and the roster its own read, each best-effort. Returns the rendered
 * volatile-tail block, or null when the core item can't be read.
 */
export async function computeCupWakeDossier(input: ComputeCupWakeDossierInput): Promise<string | null> {
  const deps = { ...defaultDeps(), ...input.deps };
  const { harness, workItemId, workspaceId, role } = input;

  // CORE: prefer the detail (item + links + topics); if the detail read throws, fall
  // back to the bare item so the dossier still renders its header. Both null ⇒ no dossier.
  const detail = await deps.getDetail(workItemId, harness).catch(() => null);
  const item: WorkItem | null = detail ?? (await deps.getItem(workItemId, harness).catch(() => null));
  if (!item) return null;

  // ANCILLARY — each fail-soft. The detail's links carry the plan-item edge + the
  // outgoing `blocks` edges; topics come along too. The roster is its own read (D-008).
  const links = detail?.links ?? [];
  const planItem = links.find((l) => (l.dst as { kind?: string } | undefined)?.kind?.includes('plan'))?.dst;
  const blocks = links.filter((l) => l.rel === 'blocks').map((l) => dstLabel(l.dst));
  // Recent thread comments — newest-first (listPosts is chronological), each compacted.
  const comments = (detail?.posts ?? [])
    .slice()
    .reverse()
    .map((p) => {
      const who = p.author_id ?? 'someone';
      const body = (p.body ?? '').replace(/\s+/g, ' ').trim();
      return body ? `${who}: ${body.slice(0, 200)}` : '';
    })
    .filter(Boolean);

  // P-008 (work-item-chat-context-modernize-2026-07-18, from D-003 ground truth):
  // the roster read, the standing-facts fold, and the memory recall are three
  // INDEPENDENT reads — none consumes another's output — yet were previously
  // `await`ed one after another, so the total dossier latency was their SUM
  // (measured live: 10.35s, vs the chat route's 3s budget — the memory recall
  // alone routinely costs several seconds on a just-restarted operator, see
  // op-deadline.ts MEMORY_INJECT_TIMEOUT_MS + mem0-client.ts's 1h client-TTL
  // cache getting wiped every restart). Run them concurrently instead so the
  // total is bounded by the SLOWEST leg, not their sum. Each stays fail-soft
  // (its own .catch), so a slow/failed leg degrades only that section.
  const rosterP = deps.listRoster(workspaceId).catch(() => [] as CupRosterPeer[]);

  // STANDING FACTS (L1c) — fail-soft: a facts outage never blocks the dossier.
  //
  // The `role` leg is threaded from the spawn seam, NOT hardcoded (EI-20089384158051187).
  // It used to read `scopeRef: 'cup'` unconditionally, which matched ZERO rows on every
  // spawn — no role:cup fact has ever existed — while the facts for the role actually
  // being spawned (role:su had 12) were never folded. The bug was invisible because the
  // leg is fail-soft and an empty fold renders identically to "this agent has no facts".
  // When the role is unknown we OMIT the leg rather than guess.
  const factSelectors: FactSelector[] = [
    { scope: 'workspace' },
    ...(role ? [{ scope: 'role' as const, scopeRef: role }] : []),
    { scope: 'harness', scopeRef: harness },
    { scope: 'work_item', scopeRef: workItemId },
  ];
  // P-004 / D-006: render the fold WITH its per-selector census, so a truncated
  // dossier says so instead of presenting the newest N as the whole corpus. The
  // census rides the same statement as the rows, so this costs no extra query.
  const factsFoldP = import('../agent-facts/store')
    .then(async (m) => {
      const { facts, census } = await m.foldFactsWithCensus(factSelectors, { workspaceId });
      return m.renderFactsFold(facts, Date.now(), census);
    })
    .catch(() => '');

  // BACKGROUND RECALL (L1d, mug-memory-hybrid) — the cup translation of the Mug's
  // memoryFold (mug-brief-launch.ts): a fuzzy sibling of the facts fold above,
  // routed through the SAME buildMemoryContextBlock pipeline every other
  // memory-injection surface uses (relevance floor, per-turn dedup, muted-pack
  // filter, feedback tombstones), so the cup dossier gets the same quality bar
  // instead of a bespoke raw-search leg. Queried on the work-item's own title +
  // summary so the recall is scoped to THIS task, not a generic harness pull.
  // Fail-soft + timeout-bounded internally; never blocks the dossier.
  const memoryFoldP = (async () => {
    const { buildMemoryContextBlock } = await import('../memory/injection');
    const queryContext = [item.title, item.summary].filter(Boolean).join(' — ');
    if (!queryContext.trim()) return '';
    const block = await buildMemoryContextBlock({
      workspaceId,
      harnessSlugs: [harness],
      queryContext,
      // TOTAL across every pool (F-C / context-injection-audit-2026-07-28 D-011).
      // Before F-C this bound only the USER pool — which this caller never
      // requests — so the 3 was inert and the dossier silently took up to 6
      // (3 harness + 3 hive). It now means what it says.
      limit: 3,
      heading: 'Background recall (fuzzy memory — may be stale; the standing facts above are authoritative)',
    });
    return block ?? '';
  })().catch(() => '');

  const [roster, factsFold, memoryFold] = await Promise.all([rosterP, factsFoldP, memoryFoldP]);

  return renderCupDossier({
    item,
    planItem: planItem ? dstLabel(planItem) : null,
    blocks,
    topics: detail?.topics ?? [],
    comments,
    roster,
    factsFold,
    memoryFold,
    caps: input.caps,
  });
}
