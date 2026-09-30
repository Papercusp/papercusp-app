/**
 * Production wiring for the curation loop (plan curator-operator-2026-06-04).
 *
 * Adapts the LANDED coord readers + work_item (hfc) reads into the injectable
 * `FleetReaders` / `CurationDeps` the pure loop consumes. This is the only file
 * coupled to the concrete sources — the loop, salience policy, gather, and state
 * stay source-agnostic + unit-testable.
 *
 * Source map (all read-only; never edits work-items.ts):
 *   escalations  → coord listEscalations({status:'open'})  (severity split in fleet-signals)
 *   blocked      → coord getAllBlockedPlanItems() (plan-items blocked by open issues)
 *                  + hfc/work_items rows with status='blocked' (P-001,
 *                  curation-signal-gaps-2026-07-17 — an item an agent parked
 *                  blocked via work_items:set_state/set_blocker was previously
 *                  invisible to the digest unless a plan item also named it)
 *   decisions    → coord handoffs-to-human + hfc needs_human_review / needs_design
 *   completions  → hfc status='done' (recent), provenance via created_by_github_user_id
 *   progress     → coord plan-events (recent, discrete transitions)
 *   health       → computeSystemHealth panels at warn/crit (P-002,
 *                  curation-signal-gaps-2026-07-17 — the deterministic Health-tab
 *                  aggregation, read via the cached `getSystemHealth()` surface;
 *                  never a second aggregation, D-006/plan-decision)
 *   deadClaims   → work_items.taken_by joined against the liveness ORACLE
 *                  (P-005, curation-signal-gaps-2026-07-17 — resolveSessionStates,
 *                  not a bare heartbeat check; complements the claim-reconciler
 *                  gap EI-11035 without touching the claim itself)
 *
 * NOTE (v1): coord readers operate on the coord workspace; hfc reads on the
 * active workspace. On the single-workspace dev box these coincide. The work_item
 * subscribe→inject path (collapse-delegate-into-workitems, in-flight) will make
 * `progress`/`completions` richer once the operator subscribes to its assigned
 * work_items — the gather interface is already shaped for it.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { listEscalations } from '../agent-tools/coordination/escalations';
import { listHandoffs } from '../agent-tools/coordination/handoffs';
import { readPlanEvents } from '../agent-tools/coordination/plan-events';
import { getAllBlockedPlanItems } from '../issue-blocks-merge';
import { activeExternalBlockers } from '../external-blockers';
import { loadRecentSurfaced, recordSurfaced, loadOpenRecoverable } from './curation-log';
import { surfaceCuratedMessage } from './curation-surface';
import { planEventProgressTitle } from './plan-event-title';
import { getSystemHealth } from '../system-health/compute';
import type { SystemHealth } from '../system-health/types';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { WORK_ITEM_NON_REQUEUE_STATES } from '../work-items-stale-claims';
import type {
  FleetReaders,
  RawEscalation,
  RawBlockedItem,
  RawDecision,
  RawCompletion,
  RawProgress,
  RawHealthPanel,
  RawDeadClaim,
} from './fleet-signals';
import type { CurationDeps } from './curation-loop';

/** Completions/decisions are only "fresh" within this window (older ones the
 *  curation-log already remembers surfacing, but this bounds the scan). */
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMPLETION_SIGNAL_STATUSES = ['done', 'passed', 'resolved', 'closed'] as const;

async function readEscalations(): Promise<RawEscalation[]> {
  const open = await listEscalations({ status: 'open' });
  return open.map((e) => ({
    msgId: e.msg_id,
    severity: e.severity,
    summary: e.summary ?? '(escalation)',
    from: e.from,
    planSlug: e.plan_slug,
    ts: e.ts,
  }));
}

/** Cap for the direct work_items status='blocked' scan (P-001) — mirrors the
 *  ~50-row bound the other structured-status readers (readDecisions,
 *  readCompletions) already use, so the digest never floods on a large backlog. */
const BLOCKED_WORK_ITEMS_LIMIT = 50;

/** Blocked work_items (P-001, curation-signal-gaps-2026-07-17): rows an agent
 *  parked `status='blocked'` directly (work_items:set_state / set_blocker),
 *  independent of whether a plan item names them — the existing
 *  getAllBlockedPlanItems() source only sees a block that flows through an
 *  open engineer_issue → coord_links 'blocks' → plan_item edge, so a bare
 *  blocked feature/work-item with no plan-item link was invisible to the
 *  digest. `reason` prefers the typed external-blocker summaries
 *  (work_items:set_blocker) — the actual "why" — falling back to the item's
 *  own summary/description, then a generic marker.
 */
async function readBlockedWorkItems(): Promise<RawBlockedItem[]> {
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; feature_id: string; title: string | null; summary: string | null; payload: unknown; updated_ts: string | null }[]
  >`
    SELECT harness_slug, feature_id, title, summary, payload, updated_ts::text
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws}
       AND status = 'blocked'
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT ${BLOCKED_WORK_ITEMS_LIMIT}
  `;
  return rows.map((r) => {
    const active = activeExternalBlockers(r.payload);
    const reason = active.length > 0
      ? active.map((b) => b.summary).join('; ')
      : (r.summary?.trim() || 'marked blocked');
    return {
      // BARE `<harness>#<id>` — fleet-signals.ts's blk mapping unconditionally
      // prepends 'wi:' itself (`ref: \`wi:${b.ref}\``, mirroring the existing
      // plan-item-blocked source's bare ref). Prefixing here too double-stamped
      // the drill-in ref as `wi:wi:<harness>#<id>` (caught live on staging via
      // curation:feed against a real blocked WI-3388 row, P-004 verification).
      ref: `${r.harness_slug}#${r.feature_id}`,
      harness: r.harness_slug,
      title: r.title?.trim() || r.feature_id,
      reason,
      workItemId: r.feature_id,
      ts: r.updated_ts ? new Date(Number(r.updated_ts)).toISOString() : undefined,
    };
  });
}

async function readBlocked(): Promise<RawBlockedItem[]> {
  const [blocked, workItemBlocked] = await Promise.all([
    getAllBlockedPlanItems(),
    readBlockedWorkItems(),
  ]);
  const out: RawBlockedItem[] = [];
  for (const [ref, issueIds] of blocked) {
    out.push({
      ref,
      title: ref,
      reason: `blocked by ${issueIds.length} open issue${issueIds.length === 1 ? '' : 's'}: ${issueIds.join(', ')}`,
    });
  }
  out.push(...workItemBlocked);
  return out;
}

async function readDecisions(): Promise<RawDecision[]> {
  const out: RawDecision[] = [];

  // (a) Handoffs addressed to the human — needs human pickup.
  const handoffs = await listHandoffs({ status: 'open' });
  for (const h of handoffs) {
    const rec = h.record;
    if (!Array.isArray(rec.to) || !rec.to.includes('human')) continue;
    out.push({
      id: `handoff:${rec.msg_id}`,
      title: rec.summary ?? 'handoff',
      ref: `coord:handoff:${rec.msg_id}`,
      ts: rec.ts,
    });
  }

  // (b) Features flagged needs_human_review / needs_design (design pending).
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; feature_id: string; title: string | null; needs_design: boolean; updated_ts: string | null }[]
  >`
    SELECT harness_slug, feature_id, title, needs_design, updated_ts::text
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${ws}
       AND (needs_human_review = true OR (needs_design = true AND design_status = 'pending'))
       AND COALESCE(status, '') <> 'deprecated'
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT 50
  `;
  for (const r of rows) {
    out.push({
      id: `review:${r.harness_slug}#${r.feature_id}`,
      harness: r.harness_slug,
      title: r.title ?? r.feature_id,
      detail: r.needs_design ? 'design review' : 'review',
      workItemId: r.feature_id,
      ref: `wi:${r.harness_slug}#${r.feature_id}`,
      ts: r.updated_ts ? new Date(Number(r.updated_ts)).toISOString() : new Date().toISOString(),
    });
  }
  return out;
}

async function readCompletions(): Promise<RawCompletion[]> {
  const ws = activeWorkspaceId();
  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; feature_id: string; title: string | null; created_by_github_user_id: string | null; updated_ts: string | null }[]
  >`
    SELECT harness_slug, feature_id, title, created_by_github_user_id::text, updated_ts::text
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws}
       AND status = ANY(${[...COMPLETION_SIGNAL_STATUSES]}::text[])
       AND terminal_owner IS NOT NULL AND terminal_owner <> ''
       AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
       AND updated_ts IS NOT NULL
       AND updated_ts > ${cutoff}
     ORDER BY updated_ts DESC
     LIMIT 50
  `;
  return rows.map((r) => ({
    workItemId: `${r.harness_slug}#${r.feature_id}`,
    harness: r.harness_slug,
    title: r.title ?? r.feature_id,
    // Completion-integrity gate (WI-1403/WI-1405): only evidence-backed terminal
    // rows count as "work landed" here. The human-provenance heuristic still rides
    // created_by_github_user_id on the unified row.
    userRequested: r.created_by_github_user_id != null,
    ref: `wi:${r.harness_slug}#${r.feature_id}`,
    ts: r.updated_ts ? new Date(Number(r.updated_ts)).toISOString() : new Date().toISOString(),
  }));
}

async function readProgress(): Promise<RawProgress[]> {
  // Recent discrete plan transitions — the routine batch. Plan-event envelopes
  // carry kind='plan_event'; the specific type is the `event` field, filtered
  // server-side. Most-recent rotation file only; window-filtered + capped so the
  // digest never floods.
  const cutoff = Date.now() - FRESH_WINDOW_MS;
  const events = await readPlanEvents({ events: ['item_status_changed'], filesBack: 1 });
  const out: RawProgress[] = [];
  for (const e of events) {
    const ts = typeof e.ts === 'string' ? e.ts : new Date().toISOString();
    const t = Date.parse(ts);
    if (Number.isFinite(t) && t < cutoff) continue;
    const planSlug = typeof e.plan_slug === 'string' ? e.plan_slug : undefined;
    // WI-5040 (owner report 2026-07-16): emitPlanEvent never writes `summary`,
    // so the old `e.summary ?? 'plan update'` fallback was the 100% path and
    // every progress bullet rendered as the contentless literal "plan update".
    // planEventProgressTitle composes a real title from the envelope fields
    // the emitter DOES write, e.g. "my-plan-2026-07-16 P-003: todo → wip".
    const summary = planEventProgressTitle(e);
    out.push({
      id: `plan-event:${e.msg_id}`,
      title: summary,
      ref: planSlug ? `plan:${planSlug}` : undefined,
      ts,
    });
  }
  return out.slice(0, 25);
}

/**
 * PURE mapper: `SystemHealth` panels → `RawHealthPanel[]` (P-002). Only
 * `warn`/`crit` panels are signal-worthy (an `ok`/`unknown` panel emits
 * nothing — "stay silent", mirroring the salience policy's own stance); a
 * panel covered by an active owner ack (`applyHealthAcks`, health-tab-v2
 * P-004) is excluded too — the owner already acknowledged it, so re-nagging
 * every curation tick would defeat the ack. Exported + pure so it's directly
 * unit-testable with a fake `SystemHealth` object (no PG / no
 * `computeSystemHealth`'s 20-collector aggregation needed).
 */
export function mapHealthPanelsToRaw(health: SystemHealth): RawHealthPanel[] {
  const ts = new Date(health.evaluatedAt).toISOString();
  const out: RawHealthPanel[] = [];
  for (const panel of Object.values(health.panels)) {
    if (panel.ack) continue;
    if (panel.status !== 'warn' && panel.status !== 'crit') continue;
    out.push({ panelId: panel.key, status: panel.status, label: panel.label, summary: panel.summary, ts });
  }
  return out;
}

/** System-health source (P-002): reads the SAME cached `SystemHealth`
 *  snapshot the Health tab renders (`getSystemHealth()` — a live tick only
 *  when the cache is stale; D-006, never a second aggregation). Fail-soft:
 *  `getSystemHealth` returns null when the `SYSTEM_HEALTH_TAB` flag is off,
 *  and any thrown error is caught by `gatherFleetSignals`'s `safe()` wrapper
 *  — either way this degrades to `[]`, never killing the curation tick. */
async function readHealth(): Promise<RawHealthPanel[]> {
  const health = await getSystemHealth();
  if (!health) return [];
  return mapHealthPanelsToRaw(health);
}

/** Bounds the raw claimed-rows scan (P-005) — mirrors BLOCKED_WORK_ITEMS_LIMIT's
 *  "capped ~50" convention for the other structured-status readers, but wider
 *  since most claimed rows will have a LIVE holder and get filtered out before
 *  the final signal count. */
const DEAD_CLAIM_SCAN_LIMIT = 200;
/** Final signal cap, after the liveness-oracle filter — matches the ~50 convention. */
const DEAD_CLAIM_SIGNAL_LIMIT = 50;

/**
 * Dead-session-held claims sentinel (P-005, curation-signal-gaps-2026-07-17):
 * open+claimed work_items whose holder's session is genuinely `ended` per the
 * liveness ORACLE (`resolveSessionStates`), not the bare heartbeat-freshness
 * check `work-items-stale-claims.ts`'s reclaim sweep uses — exactly the gap
 * EI-11035 reported (a session can read heartbeat-fresh yet its richer
 * `sessionState` is already `ended`, so the reconciler never frees it). This
 * is a READ-ONLY signal — it never mutates `taken_by`/`status`; fixing the
 * reconciler itself is EI-11035's own scope, this only complements it with
 * visibility.
 */
async function readDeadSessionClaims(): Promise<RawDeadClaim[]> {
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const rows = await sql<
    { harness_slug: string; feature_id: string; title: string | null; taken_by: string; updated_ts: string | null }[]
  >`
    SELECT harness_slug, feature_id, title, taken_by, updated_ts::text
      FROM harness_shared.work_items
     WHERE workspace_id = ${ws}
       AND taken_by IS NOT NULL AND taken_by <> ''
       AND status <> ALL(${WORK_ITEM_NON_REQUEUE_STATES}::text[])
     ORDER BY updated_ts DESC NULLS LAST
     LIMIT ${DEAD_CLAIM_SCAN_LIMIT}
  `;
  if (rows.length === 0) return [];
  // Bare ownerIds only (no heartbeat/host/pid on hand) — hydratePerId fills
  // every leg from each subject's own coord_presence row, so this bare-id
  // call carries the SAME legs a full roster verdict would (per the oracle's
  // own doc comment for exactly this "only ownerIds" caller shape).
  const owners = [...new Set(rows.map((r) => r.taken_by))];
  const verdicts = await resolveSessionStates(
    owners.map((ownerId) => ({ ownerId })),
    { hydratePerId: true },
  );
  const out: RawDeadClaim[] = [];
  for (const r of rows) {
    if (verdicts.get(r.taken_by)?.sessionState !== 'ended') continue;
    out.push({
      ref: `${r.harness_slug}#${r.feature_id}`,
      harness: r.harness_slug,
      title: r.title?.trim() || r.feature_id,
      holder: r.taken_by,
      workItemId: r.feature_id,
      ts: r.updated_ts ? new Date(Number(r.updated_ts)).toISOString() : undefined,
    });
  }
  return out.slice(0, DEAD_CLAIM_SIGNAL_LIMIT);
}

/** The production source bag. */
export function buildFleetReaders(): FleetReaders {
  return {
    escalations: readEscalations,
    blocked: readBlocked,
    decisions: readDecisions,
    completions: readCompletions,
    progress: readProgress,
    health: readHealth,
    deadClaims: readDeadSessionClaims,
  };
}

/** The full deps for `runCurationTick` in production. */
export function buildCurationDeps(): CurationDeps {
  return {
    readers: buildFleetReaders(),
    loadSurfaced: (windowMs) => loadRecentSurfaced(windowMs),
    recordSurfaced: (entries, policyVersion) => recordSurfaced(entries, policyVersion),
    surface: (text, report) => surfaceCuratedMessage(text, report),
    // P-003 recovery close-the-loop: escalation/blocker signals still OPEN
    // per the curation-log flap guard, diffed against this tick's gather.
    loadOpenRecoverable: () => loadOpenRecoverable(),
  };
}
