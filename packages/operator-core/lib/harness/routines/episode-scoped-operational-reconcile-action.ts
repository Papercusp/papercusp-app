/**
 * `system:episode-scoped-operational-reconcile` — P-009 of
 * silent-intake-central-resolution-2026-09-01 (audit R6).
 *
 * R6 (WI-2140277 thread post 80259): "episode-scoped operational items (gate-restore
 * tasks) should auto-close when their episode resolves (3/100 were dead episodes)."
 * The 3 examples — WI-38439, WI-39939, WI-40150 — are all issue-family rows carrying a
 * typed `payload.externalBlockers[]` entry (see `external-blockers.ts`) pointing at a
 * SPECIFIC historical green-checkpoint episode (`kind:'gate'`, `ref` matching
 * `green-checkpoint:<sha>` or `plan-lane:restore-*-green*`). Once the CURRENT gate has
 * gone green, that episode is over — however it was resolved — and the ticket exists
 * only to get main green again, which has already happened. Leaving it open forever
 * produces permanent stale "needs attention" noise.
 *
 * This bounded sweep detects that class (by typed blocker ref, with a title-pattern
 * fallback for older/malformed rows) and auto-closes ONLY when the gate's CURRENT
 * recorded verdict is a fresh, unambiguous green — never inferred, never guessed from
 * age. The gate read reuses `gitPipelineSnapshot()` (the same resolver behind
 * `gate.greenCheckpoint.verdict` / `dev:pipeline_position`), read ONCE per tick, never a
 * hand-rolled `harness_shared.routines` query (derived-truth-ladder convention).
 *
 * The actual close-write reuses `setIssueState(..., { skipCompletionGate: true })` —
 * the SAME system-close helper `harness/improvements/auto-close.ts` and
 * `orphaned-dispatch.ts` already use; there is no separate `closeWorkItemAsSystem`
 * primitive to introduce here (checked at implementation time — grepped for
 * `terminal_owner.*system:` / `closeWorkItemAsSystem`-shaped names, found none; the
 * FEATURE family's equivalent closer, `setWorkItemState`, is a different table
 * `harness_features_consolidated` and does not apply — these 3 examples are all
 * `item_kind: bug`, the issue family, which lives in `harness_shared.work_items`).
 *
 * Wiring/shape modeled on `legacy-needs-human-reconcile-action.ts` (bounded read +
 * `registerSystemAction`), with one deliberate difference: that action only STRIPS a
 * payload key (never changes status/ownership). This one performs a real terminal
 * transition, so the write is delegated to `setIssueState` per matched row rather than
 * a batch raw `UPDATE` — `setIssueState` already owns its own row lock + the
 * second-terminal-close guard (exempted for `skipCompletionGate`), so nesting it inside
 * this sweep's own transaction would just create redundant locking; the SELECT below is
 * a plain bounded read, and each close is its own atomic call.
 */
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { boundedOrgTxn } from '../../pg-bounded-txn';
import { readExternalBlockers, type ExternalBlockerRecord } from '../../external-blockers';
import { setIssueState } from '../../issues-engineer';
import { gitPipelineSnapshot, type GitPipelineSnapshot } from '../../git-pipeline-stats';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const EPISODE_SCOPED_OPERATIONAL_RECONCILE = 'episode-scoped-operational-reconcile';
export const DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP = 100;
export const MAX_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP = 500;

const ISSUE_FAMILY_KINDS = new Set(['bug', 'change', 'task']);
const TERMINAL_STATES = new Set(ANY_FAMILY_TERMINAL_STATES);

/** A typed blocker `ref` naming a specific historical green-checkpoint episode. */
const GATE_REF_PATTERNS: readonly RegExp[] = [/^green-checkpoint:/i, /^plan-lane:restore-.*-green/i];

/** Fallback for older/malformed rows carrying no typed `externalBlockers` at all. */
const TITLE_PATTERNS: readonly RegExp[] = [
  /^green-checkpoint red/i,
  /restore .* main green/i,
  /refresh .* green checkpoint/i,
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * PURE. Reads the writer's OWN stated last verdict rather than inferring one, and
 * fails closed on every axis that could make `recordedVerdict: 'green'` misleading:
 * an aborted tick (`inconclusive`), a wedged ticker (`fireStale`), an unmeasured
 * counter (`countersUnknown`), or a verdict that may already describe an abandoned
 * candidate (`verdictStale`). Any of those ⇒ NOT confirmed green — this sweep never
 * closes on an ambiguous read. `mainBehindStaging` (buffered vs current) is
 * deliberately irrelevant here: this cell is `callerRelativity: { kind: 'global' }`
 * and this sweep only asks "is the gate green right now", not "is the buffer caught
 * up" — see `assessGateVerdict` in `git-pipeline-position.ts` for the richer,
 * buffer-aware assessment this deliberately does NOT reuse (it answers a different,
 * per-caller question and would need buffer inputs this sweep has no use for).
 */
export function isGateConfirmedGreen(gate: GitPipelineSnapshot['gate']): boolean {
  return (
    gate.inconclusive === null &&
    gate.fireStale === false &&
    gate.countersUnknown === null &&
    gate.verdictStale === false &&
    gate.recordedVerdict === 'green'
  );
}

export interface EpisodeScopedOperationalCandidate {
  workspaceId: string;
  harnessSlug: string | null;
  id: string;
  status: string | null;
  itemKind: string | null;
  title: string | null;
  payload: unknown;
}

export type EpisodeScopedOperationalKeepReason =
  | 'not-issue-family'
  | 'terminal-history'
  | 'observation-lane'
  | 'not-episode-scoped-class'
  | 'gate-not-confirmed-green';

export type EpisodeScopedOperationalDecision =
  | { action: 'close'; reason: 'gate-currently-green'; matchedRef: string }
  | { action: 'keep'; reason: EpisodeScopedOperationalKeepReason };

/**
 * Which typed/fallback signal put this row in the episode-scoped-operational class,
 * or `undefined` when it does not match at all. Only an `active` gate blocker counts
 * — a `cleared` one means somebody already resolved it through the ordinary path.
 */
function matchEpisodeScopedClass(candidate: EpisodeScopedOperationalCandidate): string | undefined {
  const blockers: ExternalBlockerRecord[] = readExternalBlockers(candidate.payload);
  for (const blocker of blockers) {
    if (blocker.kind !== 'gate' || blocker.status !== 'active') continue;
    if (GATE_REF_PATTERNS.some((pattern) => pattern.test(blocker.ref))) return blocker.ref;
  }
  if (candidate.title && TITLE_PATTERNS.some((pattern) => pattern.test(candidate.title as string))) {
    return 'title-pattern';
  }
  return undefined;
}

/**
 * Pure, total decision over one live row plus the tick's already-resolved gate
 * greenness (read ONCE per sweep, never per row — see the module header). Every
 * keep branch is intentionally conservative: this sweep closes a superseded
 * episode-tracking ticket; it is never the authority that resolves a real blocker.
 */
export function decideEpisodeScopedOperationalReconcile(
  candidate: EpisodeScopedOperationalCandidate,
  gateConfirmedGreen: boolean,
): EpisodeScopedOperationalDecision {
  if (!candidate.itemKind || !ISSUE_FAMILY_KINDS.has(candidate.itemKind)) {
    return { action: 'keep', reason: 'not-issue-family' };
  }
  if (candidate.status && TERMINAL_STATES.has(candidate.status)) {
    return { action: 'keep', reason: 'terminal-history' };
  }
  const payload = record(candidate.payload);
  if (payload.lane === 'observation' || payload._lane === 'observation') {
    return { action: 'keep', reason: 'observation-lane' };
  }
  const matchedRef = matchEpisodeScopedClass(candidate);
  if (!matchedRef) return { action: 'keep', reason: 'not-episode-scoped-class' };
  if (!gateConfirmedGreen) return { action: 'keep', reason: 'gate-not-confirmed-green' };
  return { action: 'close', reason: 'gate-currently-green', matchedRef };
}

export interface EpisodeScopedOperationalReconcileResult {
  scanned: number;
  closed: number;
  closedIds: string[];
  deferredToNextTick: boolean;
  gateConfirmedGreen: boolean;
}

export function episodeScopedOperationalReconcileCap(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP;
  return Math.min(parsed, MAX_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP);
}

interface CandidateRow {
  workspace_id: string;
  harness_slug: string | null;
  feature_id: string;
  status: string | null;
  item_kind: string | null;
  title: string | null;
  payload: unknown;
}

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Bounded read + per-row close. The SELECT is a plain capped read (no `FOR UPDATE
 * SKIP LOCKED`): unlike `legacy-needs-human-reconcile-action.ts`'s batch payload-only
 * UPDATE, the actual close here is delegated per-row to `setIssueState`, which opens
 * its OWN row lock inside its own transaction — nesting a second lock here would be
 * redundant, and `setIssueState` is safe to call twice on an already-terminal row
 * (the second-terminal-close guard is deliberately exempted under
 * `skipCompletionGate`), so two concurrent ticks racing the same row is harmless.
 */
export async function reconcileEpisodeScopedOperationalRows(input: {
  workspaceId: string;
  installSlug: string;
  cap?: number;
  sql?: OrgSql;
  readGateSnapshot?: (slug: string) => Promise<GitPipelineSnapshot>;
  closeIssue?: (id: string, completionRef: string) => Promise<unknown>;
}): Promise<EpisodeScopedOperationalReconcileResult> {
  const cap = episodeScopedOperationalReconcileCap(input.cap);
  const workspaceIds = [...new Set([input.workspaceId, 'default'])];
  const readGateSnapshot = input.readGateSnapshot ?? gitPipelineSnapshot;
  const closeIssue =
    input.closeIssue ??
    ((id: string, completionRef: string) =>
      setIssueState(id, 'resolved', EPISODE_SCOPED_OPERATIONAL_RECONCILE, completionRef, {
        skipCompletionGate: true,
      }));

  // Read the gate's current verdict ONCE for this whole tick — never per row (module
  // header). A resolver failure must never be read as "green"; propagate as false.
  const snapshot = await readGateSnapshot(input.installSlug).catch(() => null);
  const gateConfirmedGreen = snapshot ? isGateConfirmedGreen(snapshot.gate) : false;

  const rows = await boundedOrgTxn(
    async (tx) => {
      // The SQL prefilter mirrors the classifier's fail-closed shape (issue-family,
      // non-terminal, not an observation-lane row, carrying either a typed active
      // gate blocker matching the episode-scoped ref patterns or a title-pattern
      // fallback) so a busy workspace's unrelated backlog cannot consume the cap.
      // The pure decision re-runs below as the final authority.
      return tx<CandidateRow[]>`
        SELECT workspace_id, harness_slug, feature_id, status, item_kind, title, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ANY(${workspaceIds}::text[])
           AND item_kind = ANY(ARRAY['bug','change','task'])
           AND status <> ALL(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])
           AND COALESCE(payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
           AND COALESCE(payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
           AND (
             (
               jsonb_typeof(COALESCE(payload, '{}'::jsonb) -> 'externalBlockers') = 'array'
               AND EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(payload -> 'externalBlockers') b
                  WHERE b ->> 'kind' = 'gate'
                    AND lower(COALESCE(b ->> 'status', '')) = 'active'
                    AND (
                      (b ->> 'ref') ~* '^green-checkpoint:'
                      OR (b ->> 'ref') ~* '^plan-lane:restore-.*-green'
                    )
               )
             )
             OR title ~* '^green-checkpoint red'
             OR title ~* 'restore .* main green'
             OR title ~* 'refresh .* green checkpoint'
           )
         ORDER BY updated_ts ASC NULLS FIRST, harness_slug ASC NULLS FIRST, feature_id ASC
         LIMIT ${cap + 1}`;
    },
    input.sql ? { client: input.sql } : {},
  );

  const deferredToNextTick = rows.length > cap;
  const candidates = rows.slice(0, cap).map(
    (row): EpisodeScopedOperationalCandidate => ({
      workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug,
      id: row.feature_id,
      status: row.status,
      itemKind: row.item_kind,
      title: row.title,
      payload: row.payload,
    }),
  );

  const closedIds: string[] = [];
  for (const candidate of candidates) {
    const decision = decideEpisodeScopedOperationalReconcile(candidate, gateConfirmedGreen);
    if (decision.action !== 'close') continue;
    const completionRef =
      `Episode-scoped operational item auto-closed (EI-R6, silent-intake-central-resolution-2026-09-01 P-009): ` +
      `its recorded blocker episode (${decision.matchedRef}) is superseded — the green-checkpoint gate's ` +
      `current recorded verdict is a fresh, unambiguous green.`;
    await closeIssue(candidate.id, completionRef);
    closedIds.push(candidate.id);
  }

  return {
    scanned: candidates.length,
    closed: closedIds.length,
    closedIds: closedIds.sort(),
    deferredToNextTick,
    gateConfirmedGreen,
  };
}

export interface EpisodeScopedOperationalReconcileActionDeps {
  reconcile: (input: { workspaceId: string; installSlug: string; cap: number }) => Promise<EpisodeScopedOperationalReconcileResult>;
  log: (message: string) => void;
}

export function makeEpisodeScopedOperationalReconcileAction(
  overrides: Partial<EpisodeScopedOperationalReconcileActionDeps> = {},
) {
  const deps: EpisodeScopedOperationalReconcileActionDeps = {
    reconcile: ({ workspaceId, installSlug, cap }) =>
      reconcileEpisodeScopedOperationalRows({ workspaceId, installSlug, cap, sql: getOrgPg().sql }),
    log: (message) => console.log(`[${EPISODE_SCOPED_OPERATIONAL_RECONCILE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const cap = episodeScopedOperationalReconcileCap(ctx.triggerConfig?.cap);
    const result = await deps.reconcile({ workspaceId: ctx.workspaceId, installSlug: ctx.installSlug, cap });
    if (result.closed === 0 && !result.deferredToNextTick) return;
    deps.log(
      `${ctx.installSlug}: scanned=${result.scanned} closed=${result.closed} gateGreen=${result.gateConfirmedGreen}` +
        (result.deferredToNextTick ? ` cap=${cap} reached; more deferred` : '') +
        (result.closedIds.length > 0 ? ` ids=${result.closedIds.join(',')}` : ''),
    );
  };
}

registerSystemAction(EPISODE_SCOPED_OPERATIONAL_RECONCILE, makeEpisodeScopedOperationalReconcileAction());
