/**
 * embed-space-self-check — EI-8913 detector half (WI-3644): a cheap periodic
 * check that the CURRENTLY resolved embedder actually reproduces the vector
 * already stored for a real row's own text, at ~0 cosine distance — so an
 * embedding-space desync (a stale mode label, an embedder version/config
 * drift, a vector written by the wrong cascade) is DETECTED rather than
 * silently served as ranking noise.
 *
 * WHY re-embed-and-compare a REAL row, not a fixed external canary string: a
 * canary only proves the current embedder is internally self-consistent
 * call-to-call — it says nothing about whether previously STORED rows (the
 * actual thing memory:search / semantic recall rank against) still match
 * what the active embedder would produce for them today. Reusing a row from
 * one of embed-backfill's own TARGETS (same tables, same `<col>_mode`
 * discriminator — WI-3616) tests the exact invariant search relies on: "a
 * stored vector, under its claimed mode, is what the active embedder for
 * that mode actually produces for this text right now".
 *
 * Resolves the embedder through the SAME governed cascade the backfill sweep
 * uses (resolveBackfillEmbedder, EI-8913's consolidation half) — never a
 * separately-derived one, or this detector could itself desync from what
 * memory:search is actually querying against.
 *
 * Best-effort + fail-soft: never throws, never blocks the worker it runs on.
 * A read/embed/escalate failure just skips the tick; the next scheduled tick
 * retries.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { ResolvedEmbedder } from '@papercusp/memory';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  DEFAULT_DESYNC_DISTANCE_THRESHOLD,
  cosineDistance,
  createSelfCheckMemo,
  parseVectorText,
  runStoredRowSelfCheck,
  type SelfCheckMemo,
} from '@papercusp/search';
import { resolveBackfillEmbedder, TARGETS, modeColOf, type BackfillTarget } from './embed-backfill';
import {
  openEscalation,
  resolveEscalation,
  listEscalationsPaginated,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const EMBED_SPACE_SELF_CHECK_IDENTITY: AgentIdentity = {
  ownerId: 'system:embed-space-self-check',
  ownerLabel: 'system · embed-space-self-check',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

// Durable escalation dedup identity (escalations.ts bumps an existing OPEN
// record sharing these rather than opening a new one each tick — no separate
// in-memory debounce needed here, unlike condition-staleness-alarm's stale-
// reminder shape).
const DEDUP_KIND = 'embed-space-desync';
const SUBJECT_SIGNATURE = 'embed-space-self-check';

/**
 * Not ~0 — a real embedder re-run of identical text lands well under this
 * (float noise / minor backend nondeterminism); a genuine desync (wrong
 * space, a stale/foreign vector, a dimension mismatch) lands far above it.
 */
export const DEFAULT_DISTANCE_ALERT_THRESHOLD = DEFAULT_DESYNC_DISTANCE_THRESHOLD;

export interface EmbedSpaceSelfCheckResult {
  ok: boolean;
  skipped?: string;
  table?: string;
  keyLabel?: string;
  distance?: number;
  mode?: string;
}

/** The vector math and the alert rule live in @papercusp/search's stored-row
 * self-check (shared-vector-search-libraries P-001); re-exported for the
 * existing papercusp importers. */
export { cosineDistance, parseVectorText };

export interface CanaryRow {
  target: BackfillTarget;
  body: string;
  storedVectorText: string;
  keyLabel: string;
}

/**
 * Find one already-embedded row, in the ACTIVE space (`<col>_mode = mode`),
 * from embed-backfill's own TARGETS list — trying each table in order and
 * skipping any that error (pre-migration column missing, etc). Returns null
 * when nothing in the active space is found (a cold DB, or the active mode
 * just switched and nothing has been backfilled into it yet — not a desync,
 * just "nothing to check this tick").
 */
export async function pickCanaryRow(sql: Sql, mode: string): Promise<CanaryRow | null> {
  for (const target of TARGETS) {
    const modeCol = modeColOf(target);
    try {
      const rows = await sql.unsafe<Array<{ body: string; vec: string; k0: string }>>(
        `SELECT (${target.bodySql}) AS body, ${target.embedCol}::text AS vec, ${target.keyCols[0]}::text AS k0
           FROM ${target.table}
          WHERE ${target.embedCol} IS NOT NULL
            AND ${modeCol} = $1
            AND length(${target.bodySql}) > 0
          ORDER BY ${target.keyCols[0]} DESC
          LIMIT 1`,
        [mode],
      );
      if (rows.length) {
        return {
          target,
          body: rows[0].body,
          storedVectorText: rows[0].vec,
          keyLabel: `${target.table}#${rows[0].k0 ?? '?'}`,
        };
      }
    } catch {
      // Column/table not present yet (pre-migration DB) or another read
      // error on this target — try the next one; a single bad target must
      // never sink the whole tick.
      continue;
    }
  }
  return null;
}

export interface EmbedSpaceSelfCheckDeps {
  sql?: Sql;
  resolveEmbedder?: () => Promise<ResolvedEmbedder>;
  pickCanary?: (sql: Sql, mode: string) => Promise<CanaryRow | null>;
  escalate?: (input: {
    severity: 'blocker' | 'question' | 'advisory';
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  listOpen?: () => Promise<EscalationRecord[]>;
  resolveOpen?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  distanceThreshold?: number;
  /** Last healthy pass. Defaults to one per process, so a restart (the moment
   * an embedder change takes effect) always re-embeds. */
  memo?: SelfCheckMemo;
  maxAgeMs?: number;
  now?: () => number;
}

// The 15-minute tick used to re-embed the same row with the same embedder on
// every run. On an idle Server that reloaded the embedding model each time
// (WI-10005523, measured on cap-p011 2026-10-02), so no idle reclaim of the
// model could last more than a quarter hour. The memo skips the embed while
// nothing that could change the answer has changed.
const selfCheckState = pinModuleState('@papercusp/operator-core.embed-space-self-check', () => ({
  memo: createSelfCheckMemo(),
}));

/** Everything about the resolved embedder that decides the vectors it makes. */
function embedderIdentityOf(resolved: Exclude<ResolvedEmbedder, { mode: 'disabled' }>): string {
  return JSON.stringify({ mode: resolved.mode, dims: resolved.dims, profile: resolved.profile });
}

function findOpenSelfCheckEscalation(recs: EscalationRecord[]): EscalationRecord | null {
  return (
    recs.find((r) => {
      const meta = r as Record<string, unknown>;
      return meta.dedupKind === DEDUP_KIND && meta.subjectSignature === SUBJECT_SIGNATURE;
    }) ?? null
  );
}

/**
 * One tick: resolve the active embedder, pick a real already-embedded row in
 * that space, re-embed its own text fresh, and compare the fresh vector to
 * what's stored. Auto-resolves a prior desync escalation once healthy again;
 * opens (or bumps, via escalations.ts's own dedup) one when the distance
 * exceeds the threshold.
 */
export async function runEmbedSpaceSelfCheckTick(
  deps: EmbedSpaceSelfCheckDeps = {},
): Promise<EmbedSpaceSelfCheckResult> {
  const resolveEmbedder = deps.resolveEmbedder ?? resolveBackfillEmbedder;
  const pickCanary = deps.pickCanary ?? pickCanaryRow;
  const escalate =
    deps.escalate ?? ((input) => openEscalation(EMBED_SPACE_SELF_CHECK_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      // EI-19403159016550818: scope the read to THIS check server-side — see the
      // note in condition-staleness-alarm.ts. This was the most exposed instance
      // of the class: a 50-row oldest-first page against a 607-row workspace open
      // set, so its own row (measured 2026-08-03 at position 525) could never
      // appear and its auto-resolve could never fire. Scoping makes the read
      // complete for this author regardless of the workspace-wide backlog.
      const { escalations } = await listEscalationsPaginated({
        status: 'open',
        maxRecords: 50,
        from: EMBED_SPACE_SELF_CHECK_IDENTITY.ownerId,
      });
      return escalations;
    });
  const resolveOpen =
    deps.resolveOpen ??
    ((msg_id, choice, note) =>
      resolveEscalation({ msg_id, choice, note, resolver: EMBED_SPACE_SELF_CHECK_IDENTITY.ownerId }));
  const threshold = deps.distanceThreshold ?? DEFAULT_DISTANCE_ALERT_THRESHOLD;

  let resolved: ResolvedEmbedder;
  try {
    resolved = await resolveEmbedder();
  } catch {
    return { ok: false, skipped: 'embedder_resolve_failed' };
  }
  if (resolved.mode === 'disabled') return { ok: true, skipped: 'embedder_disabled' };

  let sql: Sql;
  try {
    sql = deps.sql ?? getOrgPg().sql;
  } catch {
    return { ok: false, skipped: 'pg_unavailable' };
  }

  // The measurement and the alert rule are @papercusp/search's; this host keeps
  // the embedder, the canary SQL and the escalation plumbing. A length
  // mismatch reads as maximal distance there, so a width drift alerts too.
  let canary: CanaryRow | null = null;
  const result = await runStoredRowSelfCheck({
    embedderIdentity: embedderIdentityOf(resolved),
    memo: deps.memo ?? selfCheckState.memo,
    maxAgeMs: deps.maxAgeMs,
    now: deps.now,
    embed: (text) => resolved.embed(text),
    pickCanary: async () => {
      canary = await pickCanary(sql, resolved.mode);
      return canary ? { body: canary.body, storedVector: canary.storedVectorText, keyLabel: canary.keyLabel } : null;
    },
    threshold,
    clear: async ({ canary: c, distance }) => {
      let openRec: EscalationRecord | null = null;
      try {
        openRec = findOpenSelfCheckEscalation(await listOpen());
      } catch {
        openRec = null;
      }
      if (!openRec) return;
      await resolveOpen(
        openRec.msg_id,
        'auto-resolved',
        `embed-space self-check healthy again (distance=${distance.toFixed(4)} on ${c.keyLabel})`,
      );
    },
    alert: ({ canary: c, distance }) => {
      const target = (canary as CanaryRow).target;
      return escalate({
        severity: 'advisory',
        summary:
          `[embed-space-desync] re-embedding ${c.keyLabel}'s own stored text under the ACTIVE ` +
          `'${resolved.mode}' space produced a vector ${distance.toFixed(4)} cosine-distant from what's ` +
          `on disk (expected ~0)`,
        body:
          `EI-8913 detector (WI-3644): the embedder resolved for mode='${resolved.mode}' does not ` +
          `reproduce the stored vector for a row already tagged as living in that space ` +
          `(${target.table}.${modeColOf(target)}). memory:search / semantic recall ` +
          `against this table is ranking against at least one mismatched vector — likely a wider ` +
          `embedder/version/config drift, not a one-row fluke. Investigate: has the resolved ` +
          `embedder's model/version changed without a mode bump? Is the mode column trustworthy? ` +
          `Re-check via search:embed-space-self-check-tick or npm's search/embed-backfill tests.`,
        meta: { dedupKind: DEDUP_KIND, subjectSignature: SUBJECT_SIGNATURE },
      });
    },
  });

  const table = (canary as CanaryRow | null)?.target.table;
  if ('skipped' in result) {
    if (result.skipped === 'no_row_in_active_space') return { ok: true, skipped: result.skipped, mode: resolved.mode };
    if (result.skipped === 'unchanged_since_last_pass') {
      return {
        ok: true,
        skipped: result.skipped,
        table,
        keyLabel: result.keyLabel,
        distance: result.distance,
        mode: resolved.mode,
      };
    }
    return result.skipped === 'embed_failed'
      ? { ok: false, skipped: result.skipped, table }
      : { ok: false, skipped: result.skipped };
  }
  return { ok: true, table, keyLabel: result.keyLabel, distance: result.distance, mode: resolved.mode };
}
