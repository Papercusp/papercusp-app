/**
 * withPlanLock — acquire-mutate-release shape for plans:* write verbs, now
 * PG-canonical (plans-pg-canonical-migration-2026-06-03, Stage 1 / D-005).
 *
 * The plan body lives in `harness_shared.harness_plans.content`. A write is a
 * read-modify-write: read the current blob, run the mutator, upsert the result
 * with `version = version + 1`. Concurrency (D-005):
 *
 *   - A **PG advisory xact lock** on (workspace, harness, slug) serializes
 *     concurrent writers for the SAME plan, so ID allocation (D-NNN / P-NNN /
 *     slug uniqueness) inside the mutator — and the `afterWrite` plan_revisions
 *     `seq` allocation — is race-free. The lock auto-releases when the wrapping
 *     transaction commits. Held across the whole RMW + afterWrite.
 *   - Optimistic **version CAS** is the editor-concurrency guard: a caller that
 *     based its edit on `expectedVersion` is rejected (stale) when the live row
 *     has moved on. A UI edit session holds no lock during the minutes of
 *     editing — version CAS, not the lock, catches the concurrent change.
 *
 * Replaces the old filesystem O_EXCL lock + the SU file-claim coordinator.
 */

import { withWorkspace } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { isTerminalPlanStatus, parsePlan } from '@papercusp/plan-parser';
import {
  getActivationAuditEditNotice,
  type ActivationAuditEditNotice,
} from '../../plan-audits';
import { hashPlanContent } from './content-hash';
import { summarizeForcedPast } from './forced-past-stamp';
import {
  invalidPlanDependenciesValue,
  validatePlanCandidateDependencyTransition,
  type PlanCandidateDependencyDiagnostic,
} from './plan-candidate-dependencies';
import { writePlanIndexRows } from './plan-index-rows';
import {
  PLAN_LOCK_TIMEOUT_CODE,
  acquirePlanAdvisoryLock,
  planAdvisoryLockKey,
  readPlanAdvisoryLockSnapshot,
  type PlanLockHolderSnapshot,
} from './plan-lock-key';
import {
  activationGateRefusalValue,
  entersActivationPlanStatus,
  evaluateConversationActivationGate,
  isActivationAuditExemptTemplate,
} from './plan-activation-gate';
import {
  assertNoSilentRubricTemplateDataLoss,
  guardAcceptanceBarTemplateDataWrite,
  type AcceptanceBarAmendmentAuthorization,
  type RubricLossAck,
} from './rubric-loss-guard';
import { RUBRIC_TEMPLATE_NAME, rubricTemplateDataSchema } from './rubric-template';
import { resolveAgentIdentity } from '../coordination/identity';
import {
  resolvePlanScope,
  syntheticPlanPath,
  deriveIndexFromContent,
  VALID_PLAN_SLUG,
} from './source';

/** System author of the EI-14579 resurrection marker revision. */
export const TEMPLATE_DATA_LOSS_GUARD_AUTHOR = 'with-plan-lock:template-data-loss-guard';
/** System author of a revision recorded for a plan write whose caller wired no revision
 *  hook (WI-10002881 — the revision-spine guard). */
export const REVISION_SPINE_GUARD_AUTHOR = 'with-plan-lock:revision-spine-guard';

/**
 * Append a SYSTEM-attributed plan_revisions row inside the plan write's own transaction.
 * `COALESCE(MAX(seq),0)+1` is the same allocation recordPlanRevision uses; the plan's
 * advisory xact lock (held by the caller) serializes same-plan writers, so it is race-free.
 */
async function insertSystemPlanRevision(
  tx: Sql,
  row: {
    workspaceId: string;
    harnessSlug: string;
    slug: string;
    hash: string;
    body: string;
    rationale: string;
    authorId: string;
  },
): Promise<void> {
  await tx`
    INSERT INTO harness_shared.plan_revisions (
      workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, rationale,
      author_kind, author_id, session_id, session_kind, created_at
    )
    SELECT
      ${row.workspaceId}, ${row.harnessSlug}, ${row.slug}, COALESCE(MAX(seq), 0) + 1,
      ${row.hash}, ${row.body}, ${row.rationale},
      'system', ${row.authorId}, null, null, ${Date.now()}
    FROM harness_shared.plan_revisions
    WHERE workspace_id = ${row.workspaceId} AND harness_slug = ${row.harnessSlug}
      AND plan_slug = ${row.slug}
  `;
}

/**
 * plan-federation-regrain P-010 — ONGOING per-part capture for a committed plan
 * write. Flag-gated (papercusp-plan-part-federation), best-effort, and run in its
 * OWN post-commit transaction so a capture failure can NEVER roll back or block the
 * plan write. Baselines from the PRE-edit body (deterministic fed_ts=0) so the diff
 * captures only the CHANGED part — not every part — on the first edit after the flip;
 * capturePlanParts then writes the changed parts (origin='local' → mig-271 federates
 * them). Inert when the flag is OFF (one cached getFlag read, then return).
 */
async function capturePlanPartsForWrite(
  workspaceId: string,
  harnessSlug: string,
  slug: string,
  priorBody: string | null,
  newBody: string,
): Promise<void> {
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    if (!getFlag(FLAGS.PLAN_PART_FEDERATION, 'system')) return; // DARK: no-op when off
    const { PgPlanPartsStore } = await import('../../plan-parts/store');
    const { capturePlanParts, ensurePlanPartsBaseline } = await import('../../plan-parts/federation');
    await withWorkspace(workspaceId, async (tx) => {
      const store = new PgPlanPartsStore(tx, workspaceId, harnessSlug);
      if (priorBody) await ensurePlanPartsBaseline(store, slug, priorBody);
      await capturePlanParts(store, slug, newBody, Date.now(), 'local');
    });
  } catch {
    /* best-effort: per-part federation must never break a committed plan write */
  }
}

/** The routed-ledger write {@link settleRoutedPlanIdeaOnTerminalEntry} performs. */
export type PropagatePlanOutcome = (input: {
  planSlug: string;
  status: string | null | undefined;
  workspaceId?: string;
}) => Promise<number>;

/**
 * WI-10003894: when a committed write moves a plan INTO a terminal plan-store
 * status (shipped / superseded), settle its routed Blender idea(s) now instead of
 * leaving them `pending` until the bounded refresh sweep reaches them. Fires only on
 * the ENTRY edge (the prior body was non-terminal, or there was none) so ordinary
 * edits to an already-shipped plan cost nothing. Returns the rows settled; never
 * throws — the plan write is already committed.
 */
export async function settleRoutedPlanIdeaOnTerminalEntry(
  workspaceId: string,
  slug: string,
  priorBody: string | null,
  newBody: string,
  propagate?: PropagatePlanOutcome,
): Promise<number> {
  try {
    const after = deriveIndexFromContent(newBody).status;
    if (!isTerminalPlanStatus(after)) return 0;
    const before = priorBody === null ? null : deriveIndexFromContent(priorBody).status;
    if (before === after) return 0;
    const run = propagate ?? (await import('../../scout/routed-ledger')).propagatePlanOutcome;
    return await run({ planSlug: slug, status: after, workspaceId });
  } catch (err) {
    console.warn(
      `[with-plan-lock] routed-idea outcome propagation skipped for ${slug}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return 0;
  }
}

/** Current state handed to the mutator alongside the body — for version CAS. */
export interface PlanWriteMeta {
  version: number;
  contentHash: string;
  /** Operational lifecycle read under the same lock as the candidate body. */
  opStatus: string | null;
  /**
   * The plan's live structured columns, read INSIDE the lock (P-004). A mutator that
   * must validate against the plan's declared schema needs the schema as of this
   * write, not as of some earlier unlocked read — otherwise a concurrent
   * plans:set-input-schema could land between the two and the data would be checked
   * against a schema that is no longer the plan's.
   */
  templateData: unknown;
  inputSchema: unknown;
  /**
   * The plan's declared OUTPUT schema as of this write (mig 908, P-026/D-017).
   * Read inside the lock for the same reason as `inputSchema`: a mutator that
   * validates a run's published outputs must check them against the schema the
   * plan declares AT THIS WRITE, not one a concurrent plans:set-output-schema has
   * since replaced.
   */
  outputSchema: unknown;
}

/**
 * A structured `template_data` write (plan-templates-and-rubric-v2 P-005). A
 * mutator returns this (alongside its `value`) to write the plan's `template_data`
 * jsonb column — `data` is the registry-VALIDATED value the caller already checked
 * (`data === null` clears the column to SQL NULL). When the mutator also returns a
 * non-null `newBody`, the structured data rides the same content upsert; when it
 * returns `newBody: null` + a patch (the plans:set-template-data case) it is a
 * STRUCTURED-ONLY write that still bumps `version`, stamps `updated_at`, and fires
 * `afterWrite` (the revision spine) against the unchanged body.
 */
export interface TemplateDataPatch {
  data: unknown;
  /**
   * EI-21972673091438558: the caller's EXPLICIT acknowledgement of rubric content this
   * write intentionally removes. A rubric's criteria live in `template_data`, so every
   * door writing this column is checked here at the persistence boundary — the generic
   * `plans:set-template-data` verb has no acknowledgement arguments and therefore never
   * sets this, while rubrics:propose / rubrics:amend pass the ones their caller supplied.
   */
  rubricLossAck?: RubricLossAck;
  /**
   * Capability issued only by the canonical BAR amendment writer.  It is not
   * persisted; withPlanLock consumes it to distinguish an intentional BAR
   * amendment from generic/template/migration writes.
   */
  barAmendment?: AcceptanceBarAmendmentAuthorization;
}

/**
 * A structured `input_schema` write (plan-structured-inputs-2026-08-01 P-003) — the
 * sibling of TemplateDataPatch for the plan's DECLARED input schema (mig 714).
 * `schema` is the ajv-compilable JSON Schema the caller already checked
 * (`schema === null` clears the column, un-declaring the plan's inputs). Follows
 * the same rules as TemplateDataPatch: structured-only when the mutator returns
 * `newBody: null` (still bumps `version` and fires `afterWrite`), or riding along
 * with a body write in the same locked transaction.
 */
export interface InputSchemaPatch {
  schema: Record<string, unknown> | null;
}

/**
 * A structured `output_schema` write (external-triggers-gmail-slack-2026-08-22
 * P-026 / D-017, mig 908) — the symmetric sibling of InputSchemaPatch for what a
 * plan PRODUCES rather than what it is given. `schema` is the ajv-compilable JSON
 * Schema the caller already checked (`schema === null` clears the column,
 * un-declaring the plan's outputs). Same rules as the other two patches:
 * structured-only when the mutator returns `newBody: null` (still bumps `version`
 * and fires `afterWrite`), or riding along with a body write in one locked
 * transaction. Unlike InputSchemaPatch it has no `template` exclusion to enforce —
 * a registry `template` type describes a plan's ARGUMENTS, so it is not a second
 * source for the plan's product and there is nothing to arbitrate.
 */
export interface OutputSchemaPatch {
  schema: Record<string, unknown> | null;
}

export interface WithPlanLockOpts<T = unknown> {
  /** Plan slug (the PG key + the advisory lock key). */
  slug: string;
  /** One-line description of the mutation, surfaced to busy callers. */
  intent: string;
  /** Harness scope. Omit → papercup primary. */
  harnessSlug?: string;
  /** Workspace. Omit → resolved from the registry / DEFAULT. */
  workspaceId?: string;
  /** Authenticated actor for server-owned BAR provenance. When omitted, a
   * transport context is resolved from the first argument when available. */
  actorId?: string;
  /** Advisory-lock acquisition budget before reporting busy. Default ~5s. */
  ttlSec?: number;
  /**
   * Optional hook run *after* the upsert transaction commits (EI-118).
   * The `plans:*` verbs append a `plan_revisions` row here. `scope` is
   * the (workspaceId, harnessSlug) this lock resolved for the write —
   * pass it through so the revision lands in the plan's own workspace
   * (audit P-008). Best-effort; a throw propagates (the row is already
   * written).
   */
  afterWrite?: (
    writtenBody: string,
    scope: { workspaceId: string; harnessSlug: string },
    /**
     * The structured `template_data` value committed with this write. This is
     * the post-write value (the existing value when the body write preserved
     * it), so revision hooks can capture one atomic body + structured snapshot
     * without re-reading a potentially newer concurrent revision.
     */
    writtenTemplateData: unknown,
    /** Version committed by this write; audit sequence numbers are independent. */
    writtenVersion?: number,
  ) => Promise<void>;
  /**
   * Optional strict revision hook. Unlike afterWrite, this runs on the
   * transaction that writes harness_plans, so any rejection aborts the
   * entire plan mutation. Use this only for writes whose admission contract
   * requires a matching revision row.
   */
  revisionInTransaction?: (
    tx: TransactionSql,
    writtenBody: string,
    scope: { workspaceId: string; harnessSlug: string },
    writtenTemplateData: unknown,
  ) => Promise<void>;
  /**
   * Strict post-mutation hook that runs BEFORE the transaction commits. Unlike
   * `afterWrite`, a failure rolls back the plan body and the coupled write.
   * This is the seam for durable ownership handoffs whose second record must
   * never outlive the plan transition it explains.
   */
  inTransaction?: (
    tx: TransactionSql,
    writtenBody: string,
    scope: { workspaceId: string; harnessSlug: string },
    value: T,
  ) => Promise<void>;
}

/**
 * One blocked-path entry in a busy result. Shaped like the locks
 * store's AcquireBusy except `expires_ts` is NULLABLE: the plans
 * advisory lock is transaction-scoped — it releases at the holder's
 * commit, so there is no holder TTL to report. The old code filled
 * this with the CALLER's own acquire deadline, which read as "the
 * holder expires in ~5s" and was simply false (audit P-045).
 */
export interface PlanBusy {
  path: string;
  owner: string;
  owner_label: string | null;
  intent: string;
  expires_ts: Date | null;
  /**
   * Best-effort point-in-time PostgreSQL backend metadata observed after the
   * timed-out transaction rolled back. This is nullable because diagnostics
   * must never turn a safe busy response into a second failure.
   */
  holder_snapshot: PlanLockHolderSnapshot | null;
}

export interface BusyError {
  kind: 'busy';
  busy: PlanBusy[];
}

export interface AppliedResult<T> {
  kind: 'applied';
  value: T;
  /** Synthetic stable locator (the old `.md` path) — no file exists under PG storage. */
  filePath: string;
  /** The row's version after this write (unchanged when the mutator wrote nothing). */
  version: number;
  /**
   * The (workspaceId, harnessSlug) this write actually resolved + landed
   * under, per `resolvePlanScope` — NOT necessarily the ambient/global
   * "current workspace" (`activeWorkspaceId()`'s registry fallback), which
   * a concrete-harness plan write never uses. A caller that needs to touch
   * the SAME row again afterward (e.g. `clearStartedForTerminalPlan`'s
   * cross-store invariant clear) MUST reuse this scope rather than
   * independently re-resolving one — two disagreeing resolutions silently
   * targets the wrong workspace's row (EI/WI class of set-plan-status's
   * terminal-clear bug: `activeWorkspaceId()` resolved the operator's
   * globally-active workspace while the plan actually lived under the
   * harness's registered workspace, so the clear silently updated zero rows).
   */
  scope: { workspaceId: string; harnessSlug: string };
  /**
   * Present after a successful write when this plan already has an activation
   * audit. Also copied onto object-shaped `value` payloads so existing
   * agent-facing writers that spread their value surface the notice without a
   * second per-verb implementation.
   */
  activationAudit?: ActivationAuditEditNotice;
  /**
   * Candidate-graph evidence from the central write seam. An allowed missing
   * ref on a non-started draft is surfaced as `invalid-draft`; a monotonic
   * repair of legacy-invalid content surfaces remaining hard findings as
   * `legacy-residual`; rejected findings accompany a non-writing
   * `invalid_plan_dependencies` domain refusal.
   * Also copied onto object-shaped `value` payloads.
   */
  dependencyDiagnostics?: PlanCandidateDependencyDiagnostic[];
}

export type WithPlanLockResult<T> = AppliedResult<T> | BusyError;

/**
 * Acquire a PG advisory lock on the plan, read its current body, run the
 * mutator, upsert the result with a bumped version, release (on commit).
 *
 * Mutator contract:
 *   - `current` is the live content blob, or null when the plan doesn't exist.
 *   - `meta` carries the live `version` + `contentHash` (null when absent).
 *   - Returns the new body, or `null` to leave the plan untouched.
 *
 * The first parameter (`_ctx`) is retained for call-site compatibility — the
 * old SU lock used it for the owner identity; the PG advisory lock needs none.
 * Revision attribution is wired by the caller through `afterWrite`.
 */
export async function withPlanLock<T>(
  _ctx: unknown,
  opts: WithPlanLockOpts<T>,
  mutator: (
    current: string | null,
    meta: PlanWriteMeta | null,
  ) => Promise<{
    newBody: string | null;
    value: T;
    templateData?: TemplateDataPatch;
    inputSchema?: InputSchemaPatch;
    outputSchema?: OutputSchemaPatch;
  }>,
): Promise<WithPlanLockResult<T>> {
  if (typeof opts.slug !== 'string' || !VALID_PLAN_SLUG.test(opts.slug)) {
    throw new Error(`withPlanLock: invalid plan slug ${JSON.stringify(opts.slug)}`);
  }
  const { workspaceId, harnessSlug } = await resolvePlanScope({
    harnessSlug: opts.harnessSlug,
    workspaceId: opts.workspaceId,
  });
  const slug = opts.slug;
  const filePath = syntheticPlanPath(harnessSlug, slug);
  const lockKey = planAdvisoryLockKey(workspaceId, harnessSlug, slug);
  const budgetMs = (opts.ttlSec ?? 5) * 1000;
  let authenticatedActorId = opts.actorId?.trim() || null;
  if (!authenticatedActorId && _ctx && typeof _ctx === 'object') {
    try {
      authenticatedActorId = resolveAgentIdentity(_ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
    } catch {
      // In-process callers may intentionally omit a transport context. The BAR
      // guard will still refuse a mismatched/unauthenticated amendment marker.
    }
  }

  return withWorkspace(workspaceId, async (tx) => {
    // Serialize same-plan writers via a transaction-scoped advisory lock, taken through the ONE
    // shared acquire (WI-2143102). This used to poll `pg_try_advisory_xact_lock` every 50ms
    // against the same budget, which never joins the lock's wait queue — and the other writer of
    // this same key (withPlanDependencyAdmissionTransaction) blocks on it. PG grants a released
    // lock to the head of that queue atomically, so a poller could not win while any blocking
    // waiter was queued, however long its budget: starvation by construction, measured as ~1h of
    // total contention on one plan that committed nothing. Joining the queue with a bound fixes
    // both halves, and drops ~20 wasted round trips per second per contending caller.
    //
    // On timeout the acquire throws PG 55P03, which aborts the transaction; the `.catch` on this
    // promise — OUTSIDE the transaction, so the rollback has already happened — turns it into the
    // same `busy` result this path returned before.
    await acquirePlanAdvisoryLock(tx, lockKey, budgetMs);

    const rows = await tx<
      {
        content: string;
        version: string | number;
        content_hash: string;
        template: string | null;
        template_data: unknown;
        input_schema: unknown;
        output_schema: unknown;
        op_status: string | null;
        acceptance_bar_rubric_slug: string | null;
      }[]
    >`
      SELECT content, version, content_hash, template, template_data, input_schema, output_schema, op_status,
             acceptance_bar_rubric_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ${slug}
    `;
    const cur = rows[0] ?? null;
    const curVersion = cur ? Number(cur.version) : 0;
    const meta: PlanWriteMeta | null = cur
      ? {
          version: curVersion,
          contentHash: cur.content_hash,
          opStatus: cur.op_status ?? null,
          templateData: cur.template_data ?? null,
          inputSchema: cur.input_schema ?? null,
          outputSchema: cur.output_schema ?? null,
        }
      : null;

    const { newBody, value, templateData: templateDataPatch, inputSchema, outputSchema } = await mutator(
      cur?.content ?? null,
      meta,
    );
    let templateData = templateDataPatch;

    // P-008/P-009: dependency validity belongs at the one locked body-write
    // seam, not in selected verbs. Compare the complete before/after snapshots
    // under the SAME lock: clean candidates retain the static verdict, while a
    // legacy-invalid plan may commit only a strict-subset repair with zero new
    // hard fingerprints. op_status was read under this lock too, so no
    // concurrent lifecycle flip can stale either side of the transition.
    let dependencyDiagnostics: PlanCandidateDependencyDiagnostic[] | undefined;
    if (newBody !== null) {
      const candidate = parsePlan(newBody, { filePath });
      const priorCandidate = cur ? parsePlan(cur.content, { filePath }) : null;
      const verdict = validatePlanCandidateDependencyTransition(
        priorCandidate,
        candidate,
        cur?.op_status ?? null,
      );
      if (verdict.state === 'rejected') {
        return {
          kind: 'applied',
          value: invalidPlanDependenciesValue(slug, verdict) as T,
          filePath,
          version: curVersion,
          scope: { workspaceId, harnessSlug },
          dependencyDiagnostics: verdict.diagnostics,
          writtenBody: null,
          writtenTemplateData: cur?.template_data ?? null,
          priorBody: cur?.content ?? null,
        } satisfies AppliedResult<T> & {
          writtenBody: string | null;
          writtenTemplateData: unknown;
          priorBody: string | null;
        };
      }
      if (verdict.state === 'invalid-draft' || verdict.state === 'legacy-residual') {
        dependencyDiagnostics = verdict.diagnostics;
      }
    }

    // P-004: ONE content-write chokepoint covers set-plan-status, raw
    // set-content/edit/frontmatter writes, and direct creation as ready/active.
    // Later edits while already ready/active are intentionally allowed (D-002).
    if (newBody !== null) {
      const beforeIndex = cur ? deriveIndexFromContent(cur.content) : null;
      const afterIndex = deriveIndexFromContent(newBody);
      if (
        entersActivationPlanStatus(beforeIndex?.status, afterIndex.status) &&
        !isActivationAuditExemptTemplate(afterIndex.template)
      ) {
        const gate = await evaluateConversationActivationGate(tx as never, {
          workspaceId,
          harnessSlug,
          planSlug: slug,
        });
        if (!gate.satisfied) {
          return {
            kind: 'applied',
            value: activationGateRefusalValue(slug, gate) as T,
            filePath,
            version: curVersion,
            scope: { workspaceId, harnessSlug },
            writtenBody: null,
            writtenTemplateData: cur?.template_data ?? null,
            priorBody: cur?.content ?? null,
          } satisfies AppliedResult<T> & {
            writtenBody: string | null;
            writtenTemplateData: unknown;
            priorBody: string | null;
          };
        }
      }
    }
    // A structured template_data write (plans:set-template-data, P-005). Present
    // (even with data:null = clear) ⇒ write the jsonb column.
    const writesTemplateData = templateData !== undefined;
    // The same contract for the declared input schema (plans:set-input-schema, P-003).
    const writesInputSchema = inputSchema !== undefined;
    // And for the declared OUTPUT schema (plans:set-output-schema, P-026/D-017).
    const writesOutputSchema = outputSchema !== undefined;

    // P-004/D-009: every template_data writer crosses this seam. Once an
    // acceptance BAR has an adoption contract, only the canonical amendment
    // capability may alter BAR meaning. The subject-plan row is read under the
    // same transaction/lock so provenance cannot be spoofed by a stale caller
    // snapshot. METHOD-only edits remain legal and their BAR provenance is
    // canonicalized back to the stored/subject values.
    if (writesTemplateData && cur) {
      const storedTemplate = rubricTemplateDataSchema.safeParse(cur.template_data);
      let subjectPlanState:
        | {
            status: string | null;
            revision: number | null;
            adoptionEpoch: number | null;
            cohort: 'post-epoch' | 'legacy-backfilled' | null;
            seededAt: string | null;
            seededBy: string | null;
          }
        | undefined;
      const subjectPlan = storedTemplate.success ? storedTemplate.data.subjectPlan : undefined;
      if (subjectPlan) {
        const subjectRows = await tx<
          Array<{
            status: string | null;
            version: number | string | null;
            acceptance_bar_epoch: number | string | null;
            acceptance_bar_cohort: 'post-epoch' | 'legacy-backfilled' | null;
            acceptance_bar_seeded_at: string | Date | null;
            acceptance_bar_seeded_by: string | null;
          }>
        >`
          SELECT status, version, acceptance_bar_epoch, acceptance_bar_cohort,
                 acceptance_bar_seeded_at, acceptance_bar_seeded_by
            FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${harnessSlug}
             AND plan_slug = ${subjectPlan}
           LIMIT 1
        `;
        const subject = subjectRows[0];
        if (subject) {
          subjectPlanState = {
            status: subject.status,
            revision: subject.version == null ? null : Number(subject.version),
            adoptionEpoch: subject.acceptance_bar_epoch == null ? null : Number(subject.acceptance_bar_epoch),
            cohort: subject.acceptance_bar_cohort,
            seededAt:
              subject.acceptance_bar_seeded_at == null
                ? null
                : subject.acceptance_bar_seeded_at instanceof Date
                  ? subject.acceptance_bar_seeded_at.toISOString()
                  : String(subject.acceptance_bar_seeded_at),
            seededBy: subject.acceptance_bar_seeded_by,
          };
        }
      }
      const guarded = guardAcceptanceBarTemplateDataWrite({
        slug,
        storedTemplateData: cur.template_data,
        nextTemplateData: templateData!.data,
        subjectPlan: subjectPlanState,
        actorId: authenticatedActorId,
        amendment: templateData!.barAmendment,
      });
      templateData = { ...templateData!, data: guarded.data };
    }

    // EI-21972673091438558 — the rubric loss-guard, at the ONE seam both doors cross.
    // A rubric IS a plan row whose criteria live in template_data, so `rubrics:propose`
    // and the generic `plans:set-template-data` both arrive here. Only the first used to
    // be guarded (and only against a snapshot read OUTSIDE this lock), which left the
    // generic verb able to silently delete every criterion of a live rubric — structure
    // validation cannot tell a 27-criterion array from a 1-criterion one. Enforcing it
    // HERE guards door two and any future door three, and compares against the row this
    // transaction is actually replacing rather than a pre-lock read.
    if (writesTemplateData && cur) {
      // The trigger is what is STORED, never what is incoming: you can only lose criteria
      // a row already holds, so a write that renames the template away from `rubric` must
      // not slip past by no longer looking like one. Read both the derived index column
      // and the frontmatter — either saying `rubric` is enough.
      const isRubricPlan =
        cur.template === RUBRIC_TEMPLATE_NAME ||
        deriveIndexFromContent(cur.content).template === RUBRIC_TEMPLATE_NAME;
      if (isRubricPlan) {
        assertNoSilentRubricTemplateDataLoss({
          slug,
          storedTemplateData: cur.template_data ?? null,
          nextTemplateData: templateData!.data,
          ...(templateData!.rubricLossAck ? { ack: templateData!.rubricLossAck } : {}),
        });
      }
    }

    let newVersion = curVersion;
    // The body to record a revision against (afterWrite): the new body for a content
    // write, or the unchanged current body for a structured-only template_data write.
    let writtenBody: string | null = null;
    if (newBody !== null) {
      newVersion = curVersion + 1;
      writtenBody = newBody;
      const idx = deriveIndexFromContent(newBody);
      const hash = hashPlanContent(newBody);
      // jsonb columns bound as `${JSON.stringify(x)}::jsonb` — the operator's
      // postgres-js client throws on sql.json / bare-object jsonb params
      // (agent-insights/postgres-js-jsonb-binding).
      const itemsJson = JSON.stringify(idx.items);
      const decisionsJson = JSON.stringify(idx.decisions);
      // v2 P-001: the structured promote-policy, parsed once at write-time (deriveIndexFromContent).
      const promotePolicyJson = JSON.stringify(idx.promotePolicy);
      // WI-40139 / D-005: the append-only markdown log remains canonical, while
      // this bounded jsonb projection makes the permanent waiver visible on the
      // cheap plans:get/list paths without reparsing the document on every read.
      const forcedPast = summarizeForcedPast(newBody);
      const forcedPastJson = forcedPast === null ? null : JSON.stringify(forcedPast);
      // P-005: `template` (the type) is frontmatter-DERIVED (mirrors `initiative`),
      // re-derived on every content write. `template_data` (the instance data) is
      // NOT touched here — it is preserved on conflict (omitted from the SET) and
      // written only by the structured path / plans:set-template-data.
      //
      // EI-14579: that "preserved on conflict" guarantee holds ONLY for an actual
      // SQL UPDATE (omitted-from-SET keeps the existing value) — it is FALSE for
      // the INSERT branch below. When `cur` is null (no row found) this is either
      // a genuinely brand-new plan (fine — it never had template_data) OR a
      // RESURRECTION: the row previously existed (has plan_revisions history) and
      // was deleted out from under a concurrent process, and this ordinary content
      // write is silently re-creating it with `template_data` defaulted to NULL —
      // a real, live incident (the WI-5244 PG-discovery-hijack recovery window)
      // produced exactly this: a rubric row reappeared with title/body/template
      // intact but template_data NULL and ZERO attributable trail, because
      // `planRevisionCapture`'s `afterWrite` best-effort no-ops whenever the
      // caller's ctx has no resolvable identity (D-014) — so the loss was
      // completely silent. There is nothing here to recover the lost jsonb from
      // (harness_plans holds no history of it), so the only honest fix is to make
      // the loss LOUD and unconditionally attributable instead of invisible.
      let resurrectionWarning: string | null = null;
      if (!cur && idx.template) {
        const priorRevision = await tx<{ seq: number }[]>`
          SELECT seq FROM harness_shared.plan_revisions
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND plan_slug = ${slug}
           LIMIT 1
        `;
        if (priorRevision.length > 0 && !writesTemplateData) {
          resurrectionWarning =
            `EI-14579: template-bearing plan '${slug}' (template=${idx.template}) was ` +
            `resurrected via a generic content write with no template_data supplied — ` +
            `its previous structured template_data is LOST (harness_plans keeps no ` +
            `history of it) and this row must be re-populated via the template's own ` +
            `repair/seed path (e.g. rubrics:propose) before it is trusted.`;
        }
      }
      await tx`
        INSERT INTO harness_shared.harness_plans (
          workspace_id, harness_slug, plan_slug, content, content_hash, version,
          title, status, created, updated, owner, initiative, template, supersedes, superseded_by,
          is_legacy, items, decisions, now_state, now_next, promote_policy, forced_past, origin
        ) VALUES (
          ${workspaceId}, ${harnessSlug}, ${slug}, ${newBody}, ${hash}, ${newVersion},
          ${idx.title}, ${idx.status}, ${idx.created}, ${idx.updated}, ${idx.owner}, ${idx.initiative}, ${idx.template},
          ${idx.supersedes}, ${idx.supersededBy}, ${idx.isLegacy},
          ${itemsJson}::text::jsonb, ${decisionsJson}::text::jsonb, ${idx.nowState}, ${idx.nowNext}, ${promotePolicyJson}::text::jsonb, ${forcedPastJson}::text::jsonb, 'local'
        )
        ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE SET
          content       = EXCLUDED.content,
          content_hash  = EXCLUDED.content_hash,
          version       = ${newVersion},
          title         = EXCLUDED.title,
          status        = EXCLUDED.status,
          created       = EXCLUDED.created,
          updated       = EXCLUDED.updated,
          owner         = EXCLUDED.owner,
          initiative    = EXCLUDED.initiative,
          template      = EXCLUDED.template,
          supersedes    = EXCLUDED.supersedes,
          superseded_by = EXCLUDED.superseded_by,
          is_legacy     = EXCLUDED.is_legacy,
          items         = EXCLUDED.items,
          decisions     = EXCLUDED.decisions,
          now_state     = EXCLUDED.now_state,
          now_next      = EXCLUDED.now_next,
          promote_policy = EXCLUDED.promote_policy,
          forced_past   = EXCLUDED.forced_past,
          -- EI-117: a genuine local write must RESET origin — without this a row
          -- last touched by a hyperbee projection (origin='remote') keeps that
          -- origin, the CDC capture trigger skips the local write, and the edit
          -- never reaches the outbox/log (so a later replay reverts it).
          origin        = 'local'
      `;

      // Migration 675: the same derived index, as real rows. Inside THIS
      // transaction (which holds the plan's advisory lock) so the rows can
      // never diverge from `items`/`decisions` or from `content` — a reader
      // cannot observe a plan whose index is half-written. Phase 3 of
      // `normalize-plan-items-decisions-to-rows-2026-07-26` removes the jsonb
      // columns above and leaves this as the only index write.
      await writePlanIndexRows(
        tx as unknown as Parameters<typeof writePlanIndexRows>[0],
        { workspaceId, harnessSlug, planSlug: slug },
        idx,
      );

      // EI-14579: land the resurrection marker UNCONDITIONALLY, inside this same
      // transaction, so it is never subject to the caller-identity best-effort
      // skip that made the original incident silent — it records against the
      // plan's own revision spine (COALESCE(MAX(seq),0)+1, the same race-free
      // pattern as recordPlanRevision) using a fixed system identity rather than
      // depending on the calling ctx resolving one.
      if (resurrectionWarning) {
        console.warn(`[with-plan-lock] ${resurrectionWarning}`);
        await insertSystemPlanRevision(tx, {
          workspaceId, harnessSlug, slug, hash, body: newBody,
          rationale: resurrectionWarning,
          authorId: TEMPLATE_DATA_LOSS_GUARD_AUTHOR,
        });
      } else if (!opts.afterWrite && !opts.revisionInTransaction) {
        // WI-10002881 — the REVISION-SPINE guard. Every write of plan BYTES must leave a
        // plan_revisions row whose hash matches them: the activation audit, the BAR subject
        // revision and the revision transcript all key off that spine, and plans:audit refuses
        // `plan_revision_unavailable` when the current bytes have none. The plans:* verbs
        // record through afterWrite / revisionInTransaction; internal writers (the P-030/P-031
        // scope-write cascade's Now restamps, plan-drain-transition, spawn-child, cupboard
        // install, scout revise) wire neither and silently left the spine behind. Seven prior
        // bugs fixed this one caller at a time; this closes it HERE, once, for every caller that
        // wires no hook — in the same transaction, so the bytes and their revision commit or
        // roll back together.
        await insertSystemPlanRevision(tx, {
          workspaceId, harnessSlug, slug, hash, body: newBody,
          rationale:
            `unhooked plan write (${opts.intent})` +
            (authenticatedActorId ? ` by ${authenticatedActorId}` : '') +
            ' — revision recorded by the with-plan-lock revision-spine guard (WI-10002881)',
          authorId: REVISION_SPINE_GUARD_AUTHOR,
        });
      }
    }
    if (
      (writesTemplateData || writesInputSchema || writesOutputSchema) &&
      (cur || newBody !== null)
    ) {
      // template_data write (plans:set-template-data, P-005) — structured-only OR
      // COMBINED with a body write in the same locked transaction (EI-10751's
      // ratifyRubric flips the frontmatter status AND stamps the ratifier atomically).
      // This used to be an `else if`, which SILENTLY DROPPED the templateData patch
      // whenever the mutator also returned a body — the signature advertised the
      // combined form while the write path ignored half of it (a claimed contract
      // that wasn't one). Structured-only: bump version + record a revision against
      // the unchanged body. Combined: the body write above already bumped the
      // version; this just adds the jsonb in the same tx. `updated_at = now()` so
      // the mig-211 trigger counts it as REAL activity (template_data is not in its
      // meaningful-column set).
      if (newBody === null) {
        newVersion = curVersion + 1;
        writtenBody = cur!.content;
      }
      // All THREE structured columns share ONE version bump (computed above):
      // separate statements, not separate versions — a caller writing more than one
      // in a single mutator must not see the row jump a revision per column for one
      // logical write.
      if (writesTemplateData) {
        const dataJson = templateData!.data === null ? null : JSON.stringify(templateData!.data);
        await tx`
          UPDATE harness_shared.harness_plans
             SET template_data = ${dataJson}::text::jsonb,
                 version       = ${newVersion},
                 updated_at    = now(),
                 origin        = 'local'
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND plan_slug = ${slug}
        `;
        const { synchronizeAcceptanceBarRevision } = await import('../../acceptance-bar-amendment');
        await synchronizeAcceptanceBarRevision(tx as never, {
          workspaceId, harnessSlug, rubricSlug: slug, rubricRevision: newVersion,
          templateData: templateData!.data,
          actorId: authenticatedActorId ?? 'system:plan-template-write',
          previousTemplateData: cur?.template_data,
        });
      }
      if (writesInputSchema) {
        const schemaJson =
          inputSchema!.schema === null ? null : JSON.stringify(inputSchema!.schema);
        await tx`
          UPDATE harness_shared.harness_plans
             SET input_schema = ${schemaJson}::text::jsonb,
                 version      = ${newVersion},
                 updated_at   = now(),
                 origin       = 'local'
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND plan_slug = ${slug}
        `;
      }
      if (writesOutputSchema) {
        const schemaJson =
          outputSchema!.schema === null ? null : JSON.stringify(outputSchema!.schema);
        await tx`
          UPDATE harness_shared.harness_plans
             SET output_schema = ${schemaJson}::text::jsonb,
                 version       = ${newVersion},
                 updated_at    = now(),
                 origin        = 'local'
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
             AND plan_slug = ${slug}
        `;
      }
    }

    if (newBody !== null && cur?.acceptance_bar_rubric_slug &&
        !writesTemplateData && !inputSchema && !outputSchema) {
      const { synchronizeAcceptanceBarSubjectRevision } = await import('../../acceptance-bar-amendment');
      await synchronizeAcceptanceBarSubjectRevision(tx, {
        workspaceId, harnessSlug, planSlug: slug,
        previousBody: cur.content, nextBody: newBody,
        previousVersion: curVersion, nextVersion: newVersion,
      });
    }

    // Thread the committed structured value to afterWrite. A body-only write
    // preserves the current template_data on conflict; a combined or
    // structured-only write uses the mutator's patch. Revision hooks must not
    // query this after the transaction, because another writer could commit a
    // newer structured revision before the audit row is appended.
    const writtenTemplateData = writesTemplateData ? templateData!.data : cur?.template_data ?? null;

    if (writtenBody !== null && opts.inTransaction) {
      await opts.inTransaction(
        tx as unknown as TransactionSql,
        writtenBody,
        { workspaceId, harnessSlug },
        value,
      );
    }

    // Strict revision capture is deliberately inside the same transaction as
    // the plan upsert. A failure here rejects the withWorkspace callback and
    // rolls back both the plan bytes/version and the revision insert.
    if (writtenBody !== null && opts.revisionInTransaction) {
      await opts.revisionInTransaction(
        tx as unknown as TransactionSql,
        writtenBody,
        { workspaceId, harnessSlug },
        writtenTemplateData,
      );
    }

    return {
      kind: 'applied',
      value,
      filePath,
      version: newVersion,
      scope: { workspaceId, harnessSlug },
      ...(dependencyDiagnostics ? { dependencyDiagnostics } : {}),
      writtenBody,
      writtenTemplateData,
      // P-010: the PRE-edit content, threaded to the post-commit per-part capture
      // so it can baseline (deterministic fed_ts=0) before diffing the new content.
      priorBody: cur?.content ?? null,
    } satisfies AppliedResult<T> & {
      writtenBody: string | null;
      writtenTemplateData: unknown;
      priorBody: string | null;
    };
  }).then(async (result) => {
    // EI-118 (audit P-007): afterWrite (revision recording) runs AFTER the
    // withWorkspace transaction commits — never inside it. Inside, a stalled
    // afterWrite left the tx idle-in-transaction holding RowExclusiveLock on
    // harness_plans, wedging every plans write fleet-wide. The trade is
    // deliberate: a failed afterWrite now loses one revision row instead of
    // rolling back the committed plan write (and instead of wedging the fleet).
    if (result.kind === 'applied') {
      const { writtenBody, writtenTemplateData, priorBody, ...applied } = result as AppliedResult<T> & {
        writtenBody: string | null;
        writtenTemplateData: unknown;
        priorBody: string | null;
      };
      if (writtenBody !== null && opts.afterWrite) {
        await opts.afterWrite(writtenBody, { workspaceId, harnessSlug }, writtenTemplateData, applied.version);
      }
      let activationAudit: ActivationAuditEditNotice | null = null;
      if (writtenBody !== null) {
        try {
          activationAudit = await getActivationAuditEditNotice({
            workspaceId,
            harnessSlug,
            planSlug: slug,
            currentContentHash: hashPlanContent(writtenBody),
            planVersion: applied.version,
          });
        } catch (err) {
          // The plan write is already committed. A read-side notice failure must
          // never make the caller retry and duplicate a successful mutation.
          console.warn(
            `[with-plan-lock] activation-audit edit notice unavailable for ${slug}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
      // P-010 ongoing per-part federation — flag-gated + best-effort (never throws),
      // so it can't disturb the committed write or the afterWrite revision.
      if (writtenBody !== null) {
        await capturePlanPartsForWrite(workspaceId, harnessSlug, slug, priorBody, writtenBody);
      }
      // WI-10003894: settle the plan's routed Blender idea at the moment the plan
      // ENTERS a terminal status (shipped → won, superseded → lost), on this one
      // content-write chokepoint so set-plan-status and raw status edits both reach
      // it. The bounded refresh sweep stays the reconciliation backstop. Post-commit
      // and best-effort: a failure here must never make a caller retry a committed
      // write. The lazy import avoids a static plans ↔ scout module cycle.
      if (writtenBody !== null) {
        await settleRoutedPlanIdeaOnTerminalEntry(workspaceId, slug, priorBody, writtenBody);
      }
      const dependencyDiagnostics = applied.dependencyDiagnostics;
      if (!activationAudit && !dependencyDiagnostics?.length) return applied;

      // Most plans:* writers return an object and spread it into their response.
      // Copying central notices onto that value closes those paths without
      // duplicating the policy in every handler. Primitive values retain the
      // diagnostics/notices on the AppliedResult envelope.
      const value =
        typeof applied.value === 'object' && applied.value !== null && !Array.isArray(applied.value)
          ? ({
              ...applied.value,
              ...(dependencyDiagnostics?.length ? { dependencyDiagnostics } : {}),
              ...(activationAudit ? { activationAudit } : {}),
            } as T)
          : applied.value;
      return {
        ...applied,
        value,
        ...(activationAudit ? { activationAudit } : {}),
      };
    }
    return result;
  }).catch(async (err: unknown) => {
    // A lock_timeout surfaces as busy rather than a hard error; everything else propagates.
    // Since WI-2143102 this is the LIVE contention path, not a hypothetical one: the acquire is a
    // bounded blocking wait, so exhausting the budget arrives here as PG 55P03 with the
    // transaction already rolled back.
    if ((err as { code?: string })?.code === PLAN_LOCK_TIMEOUT_CODE) {
      const holderSnapshot = await readPlanAdvisoryLockSnapshot(lockKey);
      return {
        kind: 'busy',
        busy: [
          {
            path: filePath,
            owner: 'unknown',
            owner_label: null,
            intent: 'another plans write is in progress',
            // No knowable holder expiry — see the acquire-path comment
            // (audit P-045).
            expires_ts: null,
            // Point-in-time PostgreSQL metadata only; never map this to a durable
            // coord owner, intent, or holder TTL.
            holder_snapshot: holderSnapshot,
          },
        ],
      } satisfies BusyError;
    }
    throw err;
  });
}

/**
 * Mutate the frontmatter's `updated:` field in place to today's ISO-8601 date.
 * If frontmatter is missing/invalid, returns the body unchanged (legacy plans
 * aren't assisted-write targets).
 */
export function bumpUpdatedDate(body: string, today = new Date()): string {
  const iso = today.toISOString().slice(0, 10);
  if (!body.startsWith('---')) return body;
  const close = body.indexOf('\n---', 3);
  if (close === -1) return body;
  const fm = body.slice(0, close);
  const rest = body.slice(close);
  const updatedRe = /^(updated:\s*).*$/m;
  if (updatedRe.test(fm)) {
    return fm.replace(updatedRe, `$1${iso}`) + rest;
  }
  return fm + `\nupdated: ${iso}` + rest;
}
