/**
 * Hyperbee → PG projection for PER-PART plan federation (plan-federation-regrain
 * 2026-06-13 P-006). Receives ONE part op → LWW-upserts harness_plan_parts → (only
 * when papercusp-plan-part-federation is ON) recomposes harness_plans.content from
 * the merged live parts. Because an op is scoped to one part key, concurrent edits
 * to DIFFERENT parts merge instead of clobbering (D-009 of shared-hive-hardening).
 *
 * DARK: registered always (additive) but inert until the flag flips — with it OFF
 * no peer captures part ops (capture is flag-gated too), and the harness_plans
 * recompose here is ALSO flag-gated, so an asymmetric-peer stray op only touches
 * the (dark) harness_plan_parts table and never the live harness_plans.content.
 *
 * tableTag 'plan-parts'. CDC-captured → skipOwnOps. Key = `<plan_slug>/<part_key>`
 * == the harness_plan_parts.part_fed_key generated column (mig 270).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { joinFederatedParts, parsePlan, type FederatedPart, type PlanPartKind } from '@papercusp/plan-parser';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import { FLAGS } from '@papercusp/flags';
import {
  projectionAfterCommit,
  projectionSql,
  projectionStatementFailed,
  type TableProjection,
  type ProvenanceContext,
} from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';
import { PgPlanPartsStore, type PlanPartsStore } from '../../../plan-parts/store';
import { ensurePlanPartsBaseline } from '../../../plan-parts/federation';
import { canonicalHarnessSlug } from '../../../harness/operator-home-harness';
import { summarizeForcedPast } from '../../../agent-tools/plans/forced-past-stamp';
// LEAF import, deliberately NOT `plans/source` (WI-2141279): a projection module is in
// the perf peer-child's import graph, and `plans/source` transitively reaches
// `agent-tools/locks/configure`, which calls into the stubbed `@papercusp/db-org` at
// module top level and kills the child before it can emit `ready`.
import { deriveIndexFromContent } from '../../../agent-tools/plans/derive-index';
import { writePlanIndexRows } from '../../../agent-tools/plans/plan-index-rows';
import { withPlanDependencyAdmissionTransaction } from '../../../agent-tools/plans/plan-dependency-admission-transaction';

/** The federated subset of a harness_plan_parts row (the wire shape). */
export interface PlanPartWireRow {
  harness_slug: string;
  plan_slug: string;
  part_key: string;
  kind: PlanPartKind;
  body: string;
  ordinal: number;
  tombstone: boolean;
}

export function isPlanPartWireRow(input: unknown): input is PlanPartWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.plan_slug === 'string' &&
    r.plan_slug.length > 0 &&
    typeof r.part_key === 'string' &&
    r.part_key.length > 0 &&
    typeof r.kind === 'string' &&
    typeof r.body === 'string' &&
    typeof r.ordinal === 'number' &&
    typeof r.tombstone === 'boolean'
  );
}

export interface HarnessPlanPartsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** Test seam — the part store (default: PgPlanPartsStore over `sql`). */
  store?: PlanPartsStore;
  /** Test seam — the harness_plans recompose sink (default: the sql UPDATE below). */
  recomposeSink?: (
    planSlug: string,
    content: string,
    contentHash: string,
    provenance?: ProvenanceContext,
  ) => Promise<void>;
  /** Test seam — the local flag gate (default: getFlag(PLAN_PART_FEDERATION,'system')). */
  isFlagOn?: () => Promise<boolean>;
  /** Test seam — read the local harness_plans.content for a plan (default: the SQL
   *  below). Used by the P-010 receive-side baseline: before applying the FIRST
   *  incoming part for a plan, seed the full baseline from this content so the
   *  recompose merges into the whole plan instead of a broken join({one part}). */
  readLocalContent?: (planSlug: string) => Promise<string | null>;
  /** WI-259 parity (D-027): hive-home slug when this harness is a hive MEMBER —
   *  a cross-member plan-part op is membership-gated only when set; undefined for a
   *  non-hive / owned-home harness. Threaded via RegisterAllOpts (same as harness-plans). */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from its
   *  receiver-stamped sourceLogKeyHex (boot's admittedIdentities). */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer — a cross-member part
   *  op the guard drops ONLY because the author's hive_members row hasn't federated yet
   *  is buffered + re-applied on the onMemberApplied drain, not lost. */
  pendingMemberContent?: PendingMembershipContent;
  /**
   * WI-2142064: coalesce the per-op recompose across a merge pass. When set,
   * `applyPart`/`deletePart` mark the plan DIRTY in this shared batch instead of
   * recomposing immediately — the caller (boot's merge-pass loop) drains it ONCE
   * after the pass's whole op loop finishes, so N part ops for the same plan cost
   * one recompose instead of N. Undefined ⇒ today's behavior (recompose inline,
   * every op) — every existing unit-test / direct caller is unaffected.
   */
  recomposeBatch?: PlanPartsRecomposeBatch;
}

/** One dirty-plan entry queued by `applyPart`/`deletePart` for a coalesced drain. */
interface DirtyPlanEntry {
  opts: HarnessPlanPartsProjectionOpts;
  store: PlanPartsStore;
  planSlug: string;
  provenance?: ProvenanceContext;
}

/**
 * WI-2142064: N part ops applied for the SAME plan within one merge pass used to
 * cost N full recomposes (2x getParts + a 3-parse + a full harness_plans UPDATE
 * each — ~380ms/op on a large plan, measured). `recompose()` always re-reads the
 * CURRENT merged parts from `store`, so the LAST recompose in a run of same-plan
 * ops already reflects every earlier one — coalescing to one drain per distinct
 * (workspace, harness, planSlug) per pass is lossless, just deferred.
 */
export interface PlanPartsRecomposeBatch {
  /** Register `planSlug` (under `opts.workspaceId`/`opts.harnessSlug`) as dirty;
   *  repeated marks for the same plan within one drain cycle collapse to one entry
   *  (last-writer's opts/store/provenance — recompose reads live state regardless,
   *  so only the target row and the stamped fed_ts can differ, and both are
   *  equivalent within one pass). */
  markDirty(
    opts: HarnessPlanPartsProjectionOpts,
    store: PlanPartsStore,
    planSlug: string,
    provenance?: ProvenanceContext,
  ): void;
  /** Recompose every distinct dirty plan exactly once, then clear. Fail-soft per
   *  plan (mirrors applyPart's own best-effort baseline seed): one plan's recompose
   *  failure must not drop the rest of the batch, and this promise never rejects —
   *  the caller drains it from a merge-pass `finally`, where a throw would mask the
   *  pass's own success/failure. */
  drain(): Promise<void>;
}

export function createPlanPartsRecomposeBatch(): PlanPartsRecomposeBatch {
  const dirty = new Map<string, DirtyPlanEntry>();
  const dirtyKey = (opts: HarnessPlanPartsProjectionOpts, planSlug: string): string =>
    `${opts.workspaceId}::${opts.harnessSlug}::${planSlug}`;
  return {
    markDirty(opts, store, planSlug, provenance) {
      dirty.set(dirtyKey(opts, planSlug), { opts, store, planSlug, provenance });
    },
    async drain() {
      if (dirty.size === 0) return;
      const entries = [...dirty.values()];
      dirty.clear();
      for (const entry of entries) {
        try {
          await recompose(entry.opts, entry.store, entry.planSlug, entry.provenance);
        } catch (e) {
          console.warn(
            `[plan-parts] coalesced recompose failed for '${entry.planSlug}': ` +
              (e instanceof Error ? e.message : String(e)),
          );
        }
      }
    },
  };
}

function composeKey(row: PlanPartWireRow): string {
  return `${row.plan_slug}/${row.part_key}`; // == harness_plan_parts.part_fed_key (mig 270)
}

/**
 * WI-5720 — canonicalize the AUTHORED harness_slug at the wire boundary, mirroring
 * projections/harness-plans.ts. A part op applies under `row.harness_slug` (see the
 * `effOpts` spread in applyPart), so a peer still tagging a RETIRED slug writes its
 * parts — and recomposes the plan document — under a dead harness with no Pot. The
 * plan ROW and its PARTS must canonicalize identically or they land in different
 * partitions and the recompose targets the wrong row. Non-retired slugs pass through
 * byte-identical (same object reference).
 */
function canonicalizeRowSlug(row: PlanPartWireRow): PlanPartWireRow {
  const canonical = canonicalHarnessSlug(row.harness_slug);
  return canonical === row.harness_slug ? row : { ...row, harness_slug: canonical };
}

function decodeValue(raw: unknown): PlanPartWireRow | null {
  return isPlanPartWireRow(raw) ? canonicalizeRowSlug(raw) : null;
}

async function flagOn(opts: HarnessPlanPartsProjectionOpts): Promise<boolean> {
  if (opts.isFlagOn) return opts.isFlagOn();
  const { getFlag } = await import('@papercusp/flags/server');
  return getFlag(FLAGS.PLAN_PART_FEDERATION, 'system');
}

/** UPDATE harness_plans from the recomposed parts. Per-part federation D-004:
 *  when the flag is ON this is the SOLE writer of harness_plans for the plan (the
 *  whole-blob projection is bootstrap-only — INSERT … DO NOTHING), so it writes
 *  BOTH the document (content/content_hash) AND the scalar columns the whole-blob
 *  path used to federate — re-derived from the recomposed frontmatter (title /
 *  status / created / updated / owner / initiative / supersedes / superseded_by / is_legacy).
 *  origin='remote' + a moved fed_ts make mig-214 return the row verbatim (no
 *  re-stamp) and mig-125 skip re-capture (the echo guard), so the single fed_ts
 *  stays ONE LWW stream. The `content_hash IS DISTINCT FROM` guard skips a no-op
 *  recompose (an older/duplicate part op whose merge changes nothing) — no
 *  version churn, no spurious capture. No fed_ts LWW guard is needed: the parts
 *  table is the content LWW authority, so the recompose always reflects the
 *  current merged state. */
function defaultRecomposeSink(opts: HarnessPlanPartsProjectionOpts) {
  return async (
    planSlug: string,
    content: string,
    contentHash: string,
    provenance?: ProvenanceContext,
  ): Promise<void> => {
    const sql = opts.sql ?? getOrgPg().sql;
    const fedTs = provenance?.ts ?? null;
    const { frontmatter: fm, isLegacy } = parsePlan(content);
    const forcedPast = summarizeForcedPast(content);
    const forcedPastJson = forcedPast === null ? null : JSON.stringify(forcedPast);
    const admission = await withPlanDependencyAdmissionTransaction(
      {
        sql,
        workspaceId: opts.workspaceId,
        harnessSlug: opts.harnessSlug,
        planSlug,
        candidateContent: content,
        candidateStatus: fm.status ?? null,
      },
      async (tx) => {
        const updated = await tx<Array<{ plan_slug: string }>>`
          UPDATE harness_shared.harness_plans
             SET content       = ${content},
                 content_hash  = ${contentHash},
                 version       = version + 1,
                 title         = ${fm.title ?? null},
                 status        = ${fm.status ?? null},
                 created       = ${fm.created ?? null},
                 updated       = ${fm.updated ?? null},
                 owner         = ${fm.owner ?? null},
                 initiative    = ${fm.initiative ?? null},
                 supersedes    = ${fm.supersedes ?? []},
                 superseded_by = ${fm.supersededBy ?? null},
                 is_legacy     = ${isLegacy},
                 forced_past   = ${forcedPastJson}::text::jsonb,
                 origin        = 'remote',
                 fed_ts        = ${fedTs}
           WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug} AND plan_slug = ${planSlug}
             AND content_hash IS DISTINCT FROM ${contentHash}
          RETURNING plan_slug
        `;
        // Per-part recomposition is a federation write path and therefore does
        // not cross withPlanLock. Keep the normalized rows in the same
        // dependency-admission transaction as the canonical plan update.
        // A missing plan row is a no-op for the existing recompose path; avoid
        // inserting child rows that would violate plan_items' FK in that case.
        if (updated.length > 0) {
          await writePlanIndexRows(
            tx as unknown as Parameters<typeof writePlanIndexRows>[0],
            { workspaceId: opts.workspaceId, harnessSlug: opts.harnessSlug, planSlug },
            deriveIndexFromContent(content),
          );
        }
      },
    );
    if (!admission.admitted) {
      console.warn(
        `[plan-dependency-admission] rejected federated part recompose for '${planSlug}': ` +
          admission.verdict.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
      );
    }
  };
}

async function recompose(
  opts: HarnessPlanPartsProjectionOpts,
  store: PlanPartsStore,
  planSlug: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (!(await flagOn(opts))) return; // DARK / asymmetric-peer guard — never drive harness_plans when off
  const content = joinFederatedParts(await store.getParts(planSlug));
  const sink = opts.recomposeSink ?? defaultRecomposeSink(opts);
  await sink(planSlug, content, hashPlanContent(content), provenance);
}

/** The part store over `sql` (P-537: the batch handle for an op's part writes; absent, the plain one). */
function storeFor(opts: HarnessPlanPartsProjectionOpts, sql?: postgres.Sql): PlanPartsStore {
  return opts.store ?? new PgPlanPartsStore(sql ?? opts.sql ?? getOrgPg().sql, opts.workspaceId, opts.harnessSlug);
}

/**
 * P-537: the handle an op's part writes use: the merge's batch transaction when there is
 * one. Undefined when a test store stands in, which never touches PG.
 */
async function partWriteSql(opts: HarnessPlanPartsProjectionOpts): Promise<postgres.Sql | undefined> {
  return opts.store ? undefined : projectionSql(opts.sql ?? getOrgPg().sql);
}

/**
 * P-537: the plan's recompose once the op's part write is committed. The recompose runs
 * its own transaction (dependency admission) on its own connection, so inside the merge's
 * batch it must neither run early (it would not see the part) nor on the batch handle.
 * The merge pass's coalesced drain already runs after the pass's batch settles.
 */
async function recomposeAfterPartWrite(
  opts: HarnessPlanPartsProjectionOpts,
  planSlug: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  const store = storeFor(opts);
  if (opts.recomposeBatch) {
    opts.recomposeBatch.markDirty(opts, store, planSlug, provenance);
  } else {
    await projectionAfterCommit(() => recompose(opts, store, planSlug, provenance));
  }
}

async function readLocalPlanContent(
  opts: HarnessPlanPartsProjectionOpts,
  planSlug: string,
  partSql?: postgres.Sql,
): Promise<string | null> {
  if (opts.readLocalContent) return opts.readLocalContent(planSlug);
  const sql = partSql ?? opts.sql ?? getOrgPg().sql;
  const [r] = (await sql`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${opts.workspaceId} AND harness_slug = ${opts.harnessSlug} AND plan_slug = ${planSlug}
  `) as unknown as Array<{ content: string }>;
  return r?.content ?? null;
}

async function applyPart(
  opts: HarnessPlanPartsProjectionOpts,
  row: PlanPartWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 parity (D-027): own-slug applies; a CROSS-member part op applies iff its VERIFIED
  // source-log device ∈ the hive's CURRENT members — the SAME membership guard the 6 content
  // projections use (member-content-guard.ts decideMemberContentOp). Previously a bare
  // `row.harness_slug !== opts.harnessSlug` early-return meant plan-PARTS (unlike plan ROWS)
  // never federated cross-member: the plan DOCUMENT crossed but its ITEMS silently did not.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    // P-004 parity: a cross-member op dropped ONLY because the author's hive_members row hasn't
    // federated to this peer yet ('defer', author device known) is BUFFERED + re-applied on the
    // onMemberApplied drain — not lost to the advancing merge cursor (TTL evicts a genuine non-member).
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'plan-parts',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => applyPart(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'plan-parts',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => applyPart(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  // The plan ROW applies under its AUTHORED harness_slug (harness-plans keeps row.harness_slug),
  // so the PARTS store + the harness_plans recompose must target that SAME slug — not the
  // receiver's member slug. Own-slug: identical (no-op spread). Cross-member: the author's slug,
  // matching where harness-plans landed the plan document.
  const effOpts: HarnessPlanPartsProjectionOpts =
    row.harness_slug === opts.harnessSlug ? opts : { ...opts, harnessSlug: row.harness_slug };
  // P-537: the part writes (baseline included) run on the merge's batch transaction when
  // there is one; the recompose waits for them to commit (recomposeAfterPartWrite).
  const sql = await partWriteSql(effOpts);
  const store = storeFor(effOpts, sql);
  // P-010 receive-side baseline: before applying the FIRST incoming part for a
  // plan, seed the full baseline from the local harness_plans.content (deterministic
  // fed_ts=0), so the recompose merges into the WHOLE plan rather than a broken
  // join({one part}). Flag-gated (DARK stays inert) + best-effort (a baseline
  // failure must never drop the incoming op). No-op once any part exists.
  if (await flagOn(effOpts)) {
    try {
      if ((await store.getParts(row.plan_slug)).size === 0) {
        const localContent = await readLocalPlanContent(effOpts, row.plan_slug, sql);
        if (localContent) await ensurePlanPartsBaseline(store, row.plan_slug, localContent);
      }
    } catch {
      /* best-effort baseline — never drop the op */
      // Inside the batch the error aborted the transaction. Rolling back to the op's
      // savepoint takes back only the baseline's own statements, as the part write follows.
      await projectionStatementFailed();
    }
  }
  const part: FederatedPart = {
    key: row.part_key,
    kind: row.kind,
    text: row.body,
    order: row.ordinal,
    fedTs: provenance?.ts ?? 0,
    ...(provenance?.authorPubkey ? { author: provenance.authorPubkey } : {}),
    ...(row.tombstone ? { tombstone: true as const } : {}),
  };
  await store.upsertPart(row.plan_slug, part, 'remote'); // origin='remote' → echo-guard skips re-federating our own apply
  // WI-2142064: with a recomposeBatch threaded in (the merge-pass path), coalesce
  // N same-plan ops into ONE recompose drained after the pass's op loop — see
  // PlanPartsRecomposeBatch. Without one (every existing direct/unit-test caller),
  // recompose inline exactly as before.
  await recomposeAfterPartWrite(effOpts, row.plan_slug, provenance);
}

async function deletePart(opts: HarnessPlanPartsProjectionOpts, key: string, delTs?: number): Promise<void> {
  const slash = key.indexOf('/');
  if (slash < 0) return;
  const planSlug = key.slice(0, slash);
  const partKey = key.slice(slash + 1);
  const store = storeFor(opts, await partWriteSql(opts));
  await store.upsertPart(
    planSlug,
    { key: partKey, kind: 'item', text: '', order: 0, fedTs: delTs ?? 0, tombstone: true },
    'remote',
  );
  // WI-2142064: same coalescing as applyPart — see PlanPartsRecomposeBatch.
  await recomposeAfterPartWrite(opts, planSlug);
}

export function buildHarnessPlanPartsProjection(
  opts: HarnessPlanPartsProjectionOpts,
): TableProjection<PlanPartWireRow> {
  return {
    tableTag: 'plan-parts',
    // CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    // P-537 (D-034 #2): the part writes and their reads go through projectionSql, the caught
    // baseline error calls projectionStatementFailed, no transaction-local state is set, and
    // the recompose (its own transaction) runs after the commit on a plain handle.
    batchable: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => applyPart(opts, row, provenance),
    deleteFromPg: (key, delTs) => deletePart(opts, key, delTs),
  };
}

export const _testing = { composeKey, decodeValue, isPlanPartWireRow };
