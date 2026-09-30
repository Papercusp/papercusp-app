/**
 * Federated-receiver acceptance-BAR seed (WI-10004146, endgame D-093 option B).
 *
 * The acceptance rubric is a `harness_plans` row, so it federates. Everything the
 * activation seed derives FROM it does not: the subject plan's seven
 * `acceptance_bar_*` columns and its `plan_spec_clauses` projections are
 * machine-local (the columns are declared NOT_FEDERATED "re-derived on apply" in
 * the federated-column-completeness guard). Without this module a plan that was
 * activation-audited on node A arrives on node B with NULL BAR columns and no
 * clauses, and `plans:launch` there refuses it.
 *
 * D-093 chose re-derivation over federating the columns: run the real seed on the
 * receiver, after a remote plan apply AND after a remote rubric apply, so either
 * arrival order converges. The receiver must never author or revise the rubric
 * itself (that would mint a second, competing rubric row that then federates), so:
 *
 * - the seed runs in `receiverOnly` mode, which refuses before any write unless an
 *   active rubric already exists and rebuilds byte-identically from the local plan;
 * - its inputs come from the RUBRIC's `barContract` pins, not the local plan row.
 *   The receiver's `version` is a local CAS counter and its epoch/cohort are the
 *   insert trigger's defaults, so passing them would make every rebuild differ;
 * - it runs inside a savepoint, so a refusal or abort never rolls back the apply.
 */
import type { Sql, TransactionSql } from 'postgres';
import { rubricTemplateDataAuthoringSchema } from './agent-tools/plans/rubric-template';
import type { SpecClauseSql } from './agent-tools/plans/spec-clauses-store';
import {
  AcceptanceBarSeedAbort,
  seedAcceptanceBarsInTransaction,
  type TransactionalAcceptanceBarSeedResult,
} from './acceptance-bar-seed';

type ReceiverSql = Sql | TransactionSql;

export interface FederatedApplySubject {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export type FederatedApplySeedOutcome =
  | { status: 'seeded'; rubricSlug: string; rubricRevision: number; barSetHash: string; bars: number }
  | { status: 'skipped'; reason: 'subject-absent' | 'subject-is-rubric' | 'no-rubric' | 'rubric-conflict' | 'rubric-without-contract' }
  | { status: 'deferred'; codes: string[] }
  | { status: 'failed'; error: string };

interface SubjectRow {
  template: string | null;
  content: string;
  title: string | null;
  status: string | null;
  version: number | string;
  acceptance_bar_epoch: number | null;
  acceptance_bar_cohort: string | null;
}

interface RubricCandidate {
  harness_slug: string;
  plan_slug: string;
  template_data: unknown;
}

/**
 * Which subject plan a federated row's apply should (re-)seed. A plan row seeds
 * itself; an acceptance rubric row seeds the plan it judges. Any other rubric
 * (e.g. a class or meta rubric) has no subject to seed.
 */
export function federatedApplySeedSubject(row: {
  workspaceId: string;
  harness_slug: string;
  plan_slug: string;
  template?: string | null;
  template_data?: unknown;
}): FederatedApplySubject | null {
  if (row.template !== 'rubric') {
    return { workspaceId: row.workspaceId, harnessSlug: row.harness_slug, planSlug: row.plan_slug };
  }
  const data = row.template_data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (record.kind !== 'acceptance' || typeof record.subjectPlan !== 'string' || record.subjectPlan === '') {
    return null;
  }
  const subjectHarness =
    typeof record.subjectHarnessSlug === 'string' && record.subjectHarnessSlug !== ''
      ? record.subjectHarnessSlug
      : row.harness_slug;
  return { workspaceId: row.workspaceId, harnessSlug: subjectHarness, planSlug: record.subjectPlan };
}

async function inSavepoint<T>(sql: ReceiverSql, fn: (tx: ReceiverSql) => Promise<T>): Promise<T> {
  if ('savepoint' in sql && typeof sql.savepoint === 'function') {
    return (await sql.savepoint((sp) => fn(sp as unknown as ReceiverSql))) as T;
  }
  return (await (sql as Sql).begin((tx) => fn(tx as unknown as ReceiverSql))) as T;
}

class ReceiverSeedDeferred extends Error {
  constructor(readonly codes: string[]) {
    super(`receiver seed deferred: ${codes.join(', ')}`);
    this.name = 'ReceiverSeedDeferred';
  }
}

/**
 * Re-derive a subject plan's machine-local acceptance-BAR state from its
 * federated rubric. Safe to call after every remote apply: it is idempotent,
 * it never writes the rubric, and it never throws into the caller's transaction.
 */
export async function seedAcceptanceBarsOnFederatedApply(
  sql: ReceiverSql,
  subject: FederatedApplySubject,
): Promise<FederatedApplySeedOutcome> {
  try {
    return await inSavepoint(sql, async (tx) => {
      const [plan] = await tx<SubjectRow[]>`
        SELECT template, content, title, status, version, acceptance_bar_epoch, acceptance_bar_cohort
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${subject.workspaceId}
           AND harness_slug = ${subject.harnessSlug}
           AND plan_slug = ${subject.planSlug}
         LIMIT 1`;
      if (!plan) return { status: 'skipped', reason: 'subject-absent' } as const;
      if (plan.template === 'rubric') return { status: 'skipped', reason: 'subject-is-rubric' } as const;

      // Same discovery predicate as the seed itself, so the two can never disagree
      // about which rubric governs this subject.
      const rubrics = await tx<RubricCandidate[]>`
        SELECT harness_slug, plan_slug, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${subject.workspaceId}
           AND template = 'rubric'
           AND template_slug IS NULL
           AND archived = false
           AND status IN ('active', 'ready')
           AND template_data->>'kind' = 'acceptance'
           AND template_data->>'subjectPlan' = ${subject.planSlug}
           AND (template_data->>'subjectHarnessSlug' = ${subject.harnessSlug}
             OR (template_data->>'subjectHarnessSlug' IS NULL AND (
               SELECT count(*) = 1 AND bool_and(s.harness_slug = ${subject.harnessSlug})
                 FROM harness_shared.harness_plans AS s
                WHERE s.workspace_id = ${subject.workspaceId}
                  AND s.plan_slug = ${subject.planSlug}
             )))
         LIMIT 2`;
      if (rubrics.length === 0) return { status: 'skipped', reason: 'no-rubric' } as const;
      if (rubrics.length > 1) return { status: 'skipped', reason: 'rubric-conflict' } as const;
      const parsed = rubricTemplateDataAuthoringSchema.safeParse(rubrics[0]!.template_data);
      const contract = parsed.success ? parsed.data.barContract : undefined;
      // A pre-contract (legacy) acceptance rubric carries no pins to re-derive from;
      // the migration adapter, not a federated apply, is what adopts those.
      if (!contract) return { status: 'skipped', reason: 'rubric-without-contract' } as const;

      // A remote INSERT lands at local CAS version 0 ("never locally revised"), but the
      // subject's acceptance_bar_rubric_revision pin must be positive. Advance only the
      // machine-local counter (version is not federated); the rubric's content, hash and
      // provenance stay exactly as the author wrote them.
      await tx`
        UPDATE harness_shared.harness_plans
           SET version = 1
         WHERE workspace_id = ${subject.workspaceId}
           AND harness_slug = ${rubrics[0]!.harness_slug}
           AND plan_slug = ${rubrics[0]!.plan_slug}
           AND template = 'rubric'
           AND version = 0`;

      const seeded: TransactionalAcceptanceBarSeedResult = await seedAcceptanceBarsInTransaction({
        executor: tx as unknown as SpecClauseSql,
        workspaceId: subject.workspaceId,
        harnessSlug: subject.harnessSlug,
        planSlug: subject.planSlug,
        planContent: plan.content,
        planTitle: plan.title,
        planStatus: plan.status,
        planVersion: contract.subjectPlanRevision,
        adoptionEpoch: contract.adoptionEpoch,
        cohort: contract.cohort,
        actorId: contract.seededBy,
        now: new Date(contract.seededAt),
        // The author's activation door already judged contract completeness; the
        // receiver re-derives, it does not re-judge.
        requireContractCompleteness: false,
        receiverOnly: true,
      });
      if (!seeded.ok) {
        // Roll back the savepoint: a refusal must leave no partial local state.
        throw new ReceiverSeedDeferred(seeded.problems.map((problem) => problem.code));
      }

      // The seed writes five columns; epoch/cohort are the trigger's insert-time
      // defaults on a receiver. Align them to the contract the rubric pins, so a
      // legacy-backfilled subject does not read as post-epoch here. The rubric's
      // subjectPlanRevision is the AUTHOR's local counter, so record the LOCAL
      // version this verification held at; the snapshot compares that instead, and
      // any later local plan change re-opens the mismatch until this runs again.
      await tx`
        UPDATE harness_shared.harness_plans
           SET acceptance_bar_epoch = ${contract.adoptionEpoch},
               acceptance_bar_cohort = ${contract.cohort},
               acceptance_bar_verified_revision = ${Number(plan.version)}
         WHERE workspace_id = ${subject.workspaceId}
           AND harness_slug = ${subject.harnessSlug}
           AND plan_slug = ${subject.planSlug}`;

      return {
        status: 'seeded',
        rubricSlug: seeded.rubricSlug,
        rubricRevision: seeded.rubricRevision,
        barSetHash: seeded.barSetHash,
        bars: seeded.bars,
      } as const;
    });
  } catch (error) {
    if (error instanceof ReceiverSeedDeferred) return { status: 'deferred', codes: error.codes };
    if (error instanceof AcceptanceBarSeedAbort) {
      return { status: 'deferred', codes: error.result.problems.map((problem) => problem.code) };
    }
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
