/**
 * SU-S31 — shared world for the P-011 information-asymmetry experiment
 * (agent-protocol-authority-semantics-2026-07-26 P-011).
 *
 * ## What P-011 asked for, and why this is THREE arms rather than two
 *
 * P-011's prescribed method is "matched tasks with and without the field".
 * Taken literally that comparison is CONFOUNDED, and the confound is fatal to
 * the build decision it is supposed to inform: the treatment arm's
 * information-asymmetry field CARRIES INFORMATION the control arm does not
 * have. A two-arm win therefore only demonstrates "telling a successor more
 * things helps it" — which is trivially true and was never in doubt — and says
 * nothing about whether the *structured field* earns its place in the protocol.
 *
 * So the experiment runs three matched arms over one identical task:
 *
 *   A `control`     status-quo handoff: bare Did / Left / Next.
 *   B `prose-equal` the SAME facts, written as ordinary prose, no labeled field.
 *   C `field`       the SAME facts in a labeled knownToMe / couldNotDetermine block.
 *
 * B-vs-C is the real test of the FIELD (information held constant, only
 * structure varies). A-vs-B measures the magnitude ceiling: how much work a
 * successor redoes when simply not told.
 *
 * Decision rule, fixed BEFORE the run so the result can actually falsify:
 *   C ≈ B > A  ⇒ do NOT add a schema field. The win is "write the asymmetry
 *                down at all", which a prompt instruction buys for free.
 *   C > B      ⇒ the structure itself carries the win. Build the field.
 *   A ≈ B ≈ C  ⇒ hypothesis falsified. Build nothing.
 *
 * ## The world
 *
 * The su agent has been woken to take over item P-003 of plan
 * `reconciler-idempotency-2026-07-27` — "run the backfill for existing
 * duplicate rows". A peer (su-peer1) did the preceding item P-002 (the dedupe
 * guard) and handed off. Three facts are planted in the peer's history:
 *
 *   KNOWN-A   the guard keys on (harness, external_id), NOT on id — a backfill
 *             keyed on id double-counts. The peer verified this.
 *   KNOWN-B   staging holds 1,204 duplicate rows. The peer counted them.
 *   UNDET-C   whether the reconciler ever ran under the OLD key before
 *             2026-07-01 is UNKNOWABLE from the audit rows (none exist that
 *             far back); it needs the archived logs. The peer could not
 *             determine it, and it changes what the backfill must do.
 *
 * Every arm's world exposes the SAME tools returning the SAME answers, so
 * re-deriving A and B is always possible and always yields what the peer
 * reported. The arms differ in exactly one string: how the peer's handoff
 * conveys (or fails to convey) A, B and C.
 *
 * ## Why the metrics are tool-call based, not judge-based
 *
 * AUTHORING.md §10 warns against leaning on the judge, and a three-arm rate
 * comparison would drown in judge variance. All three primary metrics read the
 * tool-call trace instead:
 *
 *   1. duplicate-rederivation — did it re-derive A or B (re-read the guard
 *      source / re-count the dupes) that the peer already established?
 *   2. contradiction          — did it proceed with an id-keyed backfill,
 *                               against the peer's verified finding?
 *   3. asymmetry-targeting    — did it surface the genuinely-undetermined C?
 *
 * These are EXPERIMENT METRICS, not regression gates. A metric hit is emitted
 * as a WARN finding so it remains queryable per arm without making the
 * canonical `llm-test --target su` suite permanently red on the control
 * behavior the experiment explicitly expects. Real runner/infrastructure
 * errors and the shared `cost_under` assertion remain gating (EI-22442499170227708).
 *
 * The scenario `description` is fed verbatim to the judge, so it is shared
 * IDENTICALLY across all three arms (see SHARED_DESCRIPTION). Only the world
 * differs. Anything else would smuggle the arm into the prompt.
 */

import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';

export function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

export const PLAN_SLUG = 'reconciler-idempotency-2026-07-27';
export const WORK_ITEM = 'WI-7301';
export const GUARD_FILE = 'packages/operator-core/lib/reconciler/dedupe-guard.ts';
export const GUARD_TEST = 'packages/operator-core/lib/reconciler/dedupe-key.test.ts';
export const ROW_SCHEMA_FILE = 'packages/operator-core/lib/reconciler/reconciler-row.ts';
export const BACKFILL_FILE = 'packages/operator-core/lib/reconciler/backfill-duplicates.ts';
export const DUPE_COUNT = 1204;
export const TOTAL_ROW_COUNT = 5000;
export const DUPLICATE_GROUP_COUNT = 602;
export const BACKFILL_SNAPSHOT_ID = 'kopia-s31-pre-backfill';
export const BACKFILL_RETURNING_REF = 'artifact://s31/backfill-returning.csv';

/* ------------------------------------------------------------------ *
 * The three handoff payloads — the ONLY thing that varies by arm.
 * ------------------------------------------------------------------ */

/** A — status quo. What the peer DID; nothing about what it knows or couldn't settle. */
export const HANDOFF_CONTROL = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
].join('\n');

/**
 * B — prose-equal. Carries A, B and C, but as ordinary narrative prose with no
 * labeled asymmetry field. This is the arm that isolates the field's STRUCTURE:
 * an agent reading this has every fact the field would have given it.
 */
export const HANDOFF_PROSE = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  `Worth mentioning that the guard ends up keyed on (harness, external_id) rather than on id — I ran`,
  `dedupe-key.test.ts to confirm that, and it matters because anything keyed on id will double-count.`,
  `I also went and counted what is already in staging and it came to ${DUPE_COUNT} duplicate rows.`,
  'One thing I never got to the bottom of: I could not tell whether the reconciler ever ran under the',
  'old key before 2026-07-01, because the audit table has no rows going back that far, so the only',
  'place that would show it is the archived logs.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
].join('\n');

/**
 * C — the information-asymmetry field. Identical FACTS to B, in the labeled
 * structure P-011 proposes: what the writer knows that the reader may not, and
 * what the writer could not determine.
 */
export const HANDOFF_FIELD = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  '',
  '## knownToMe (established here — you would otherwise have to re-derive this)',
  `- The guard keys on (harness, external_id), NOT on id. A backfill keyed on id will double-count.`,
  `  Verified by running ${GUARD_TEST}.`,
  `- Staging currently holds ${DUPE_COUNT} duplicate rows. I counted them.`,
  '',
  '## couldNotDetermine (open — I could not settle this, and it bears on the backfill)',
  '- Whether the reconciler ever ran under the OLD key before 2026-07-01. The audit table has no rows',
  '  that far back, so it is not answerable from audit data — it needs the archived logs.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
].join('\n');

/**
 * D — auto-derived provenance (`basedOn`). Added 2026-07-27 AFTER the A/B/C
 * result, at the suggestion of su-8d9a671c's `unified-agent-state-plane` P-014,
 * which proposes provenance "auto-derived from recent reads" as "the honest
 * replacement for guessing what the receiver knows".
 *
 * This is a DIFFERENT MECHANISM from arms B and C, not a variant of them, and
 * that is the whole point. B and C both require the SENDER to predict what the
 * receiver will need and to curate it — B in prose, C in labeled fields. Both
 * pay an authoring cost, and both fail the same way when the sender predicts
 * wrong. D pays no authoring cost at all: it is a mechanical trace of what the
 * peer read and ran, with the returned values, carrying NO interpretation.
 *
 * Note what this does and does not hand over. All three planted facts are
 * RECOVERABLE from the trace — the key from the guard read plus the passing key
 * test, the count from the COUNT result, and the undetermined question from an
 * audit query that came back empty. But none of them is STATED. So D tests
 * whether the receiver will do the inference the sender would otherwise have
 * had to do for it.
 *
 * ⚠ D is NOT part of the original pre-registered A/B/C decision rule and must
 * never be used to rescue the authored-field hypothesis that B-vs-C tested.
 * It is a separate question with its own prediction, fixed BEFORE it was run:
 *
 *   D ≈ B ≈ C > A  ⇒ the win is available for FREE. Build auto-derived
 *                    provenance, NOT an authored field. Strongest outcome for
 *                    P-014's `basedOn`.
 *   D ≈ A (< B)    ⇒ a raw trace is not enough; the receiver does not do the
 *                    inference. The value lives in the INTERPRETATION, which
 *                    only an authoring sender can supply.
 *   D > B          ⇒ surprising: a derived trace beats curated prose.
 */
export const HANDOFF_PROVENANCE = [
  '## Did',
  'Added the dedupe guard in dedupe-guard.ts and wired it into the reconciler tick. Unit tests green.',
  '',
  '## Left',
  'The backfill for the duplicate rows that already exist in staging.',
  '',
  '## Next',
  'Run the backfill.',
  '',
  '## basedOn — auto-derived from this session, not authored',
  `- read   ${GUARD_FILE}`,
  `- ran    ${GUARD_TEST} -> 1 passed`,
  `- query  SELECT count(*) FROM reconciler_rows WHERE <duplicate predicate> -> ${DUPE_COUNT}`,
  "- query  SELECT * FROM audit WHERE ts < '2026-07-01' AND actor = 'reconciler' -> 0 rows",
].join('\n');

/* ------------------------------------------------------------------ *
 * The world. Identical across arms except the injected handoff text.
 * ------------------------------------------------------------------ */

/** Source of the guard — re-deriving KNOWN-A means reading this. */
const GUARD_SOURCE = [
  'export function dedupeKey(row: ReconcilerRow): string {',
  '  // Keyed on (harness, external_id): the upstream id is re-minted per sync,',
  '  // so an id-keyed guard would treat every re-sync as a fresh row.',
  '  return `${row.harness}\\u0000${row.external_id}`;',
  '}',
].join('\n');

/** The source context the successor needs to turn the handoff into a runnable
 * backfill. Revision 2 claimed the world exposed recovery paths, but the SU
 * catalog omitted capability:read/dev:pg_query/logs:read and repomix:pack fell
 * through to an empty stub. That made the table and row shape unknowable. */
export const ROW_SCHEMA_SOURCE = [
  'export interface ReconcilerRow {',
  '  id: string;',
  '  harness: string;',
  '  external_id: string;',
  '  observed_at: Date;',
  '  payload_json: unknown;',
  '}',
  '',
  "export const RECONCILER_TABLE = 'harness_shared.reconciler_rows';",
].join('\n');

export const BACKFILL_SOURCE = [
  "import { RECONCILER_TABLE } from './reconciler-row';",
  '',
  '// Keep the oldest canonical row for each production dedupe key; archive later copies.',
  'export const duplicateBackfillSql = `',
  'WITH ranked AS (',
  '  SELECT id, row_number() OVER (',
  '    PARTITION BY harness, external_id ORDER BY observed_at, id',
  '  ) AS duplicate_rank',
  '  FROM ${RECONCILER_TABLE}',
  ')',
  'UPDATE ${RECONCILER_TABLE} r',
  "SET payload_json = r.payload_json || jsonb_build_object('archived_duplicate', true)",
  'FROM ranked',
  'WHERE ranked.id = r.id AND ranked.duplicate_rank > 1',
  'RETURNING r.id, r.harness, r.external_id;',
  '`;',
].join('\n');

const PACKED_RECONCILER_SOURCE = [
  `File: ${GUARD_FILE}`,
  GUARD_SOURCE,
  '',
  `File: ${ROW_SCHEMA_FILE}`,
  ROW_SCHEMA_SOURCE,
  '',
  `File: ${BACKFILL_FILE}`,
  BACKFILL_SOURCE,
].join('\n');

export function makeAsymmetryWorld(handoff: string): ToolDispatchOverride {
  type WorkState = 'open' | 'wip' | 'done';

  let workState: WorkState = 'open';
  let snapshotId: string | null = null;
  let backfillRan = false;

  const duplicateGroups = [
    {
      harness: 'papercusp',
      external_id: 'ext-44',
      row_count: 2,
      first_seen: '2026-07-07T10:00:00Z',
      last_seen: '2026-07-07T10:01:00Z',
    },
    {
      harness: 'papercusp',
      external_id: 'ext-91',
      row_count: 3,
      first_seen: '2026-07-08T09:00:00Z',
      last_seen: '2026-07-08T09:02:00Z',
    },
  ];
  const archiveCandidates = [
    { id: 'rr-101', harness: 'papercusp', external_id: 'ext-44', observed_at: '2026-07-07T10:01:00Z' },
    { id: 'rr-201', harness: 'papercusp', external_id: 'ext-91', observed_at: '2026-07-08T09:01:00Z' },
    { id: 'rr-202', harness: 'papercusp', external_id: 'ext-91', observed_at: '2026-07-08T09:02:00Z' },
  ];

  const jsonResult = (value: unknown) => ({ content: [{ text: JSON.stringify(value) }] });
  const assignee = () => workState === 'open' ? null : 'su-self';
  const planState = () => workState === 'open' ? 'todo' : workState;
  const positiveControl = (a: Record<string, unknown>) => a.positiveControlSql
    ? { ok: true, rows: [{ count: TOTAL_ROW_COUNT }], rowCount: 1 }
    : undefined;

  function claimWork(): void {
    if (workState === 'open') workState = 'wip';
  }

  function createSnapshot(a: Record<string, unknown>): Record<string, unknown> {
    snapshotId = BACKFILL_SNAPSHOT_ID;
    return {
      ok: true,
      snapshotId,
      kopiaSnapshotId: snapshotId,
      reason: a.reason ?? 'pre_destructive',
      note: a.note ?? `Pre-backfill snapshot for ${WORK_ITEM}`,
      state: 'completed',
    };
  }

  function runShell(a: Record<string, unknown>): Record<string, unknown> {
    const command = String(a.command ?? a.cmd ?? '');
    const lower = command.toLowerCase();

    if (/\bgit\b[\s\S]*\blog\b/.test(lower)) {
      return {
        ok: true,
        exit_code: 0,
        output:
          '9f31c42 2026-07-27T00:42:00Z add reconciler duplicate backfill script\n' +
          '# source history only; execution is recorded in reconciler logs/audit, not git',
      };
    }

    const executesBackfill =
      /(?:\bnpx\s+tsx\b|\btsx\b|\bnode\b|\bnpm\b|\bpsql\b)[\s\S]*(?:backfill-duplicates|archived_duplicate|duplicatebackfillsql)/.test(lower) ||
      /(?:backfill-duplicates|duplicatebackfillsql)[\s\S]*(?:\bexecute\b|\brun\b)/.test(lower);
    if (executesBackfill) {
      if (!snapshotId) {
        return {
          ok: false,
          exit_code: 2,
          error: 'precondition_failed',
          output: 'Refusing the destructive backfill: create a pre_destructive backup snapshot first.',
        };
      }
      claimWork();
      backfillRan = true;
      return {
        ok: true,
        exit_code: 0,
        output: [
          `snapshot_id=${snapshotId}`,
          `archived_duplicate_rows=${DUPE_COUNT}`,
          `returning_fields=id,harness,external_id`,
          `returning_ref=${BACKFILL_RETURNING_REF}`,
          'returning_complete=true',
          'first_rows=rr-101,papercusp,ext-44 | rr-201,papercusp,ext-91 | rr-202,papercusp,ext-91',
        ].join('\n'),
        rowCount: DUPE_COUNT,
        returningRef: BACKFILL_RETURNING_REF,
        returningComplete: true,
      };
    }

    if (/\bpsql\b|dry.?run|returning_ref|backfill-returning/.test(lower)) {
      return {
        ok: true,
        exit_code: 0,
        output: backfillRan
          ? `id,harness,external_id\n# 0 pending rows; ${DUPE_COUNT} archived rows are stored at ${BACKFILL_RETURNING_REF}`
          : [
              'id,harness,external_id',
              ...archiveCandidates.map((row) => `${row.id},${row.harness},${row.external_id}`),
              `# sample 3 of ${DUPE_COUNT}; full dry-run result: ${BACKFILL_RETURNING_REF}`,
            ].join('\n'),
        rowCount: backfillRan ? 0 : DUPE_COUNT,
        returningRef: BACKFILL_RETURNING_REF,
      };
    }

    return { ok: false, exit_code: 127, error: 'unsupported_synthetic_command', command };
  }

  function queryDatabase(a: Record<string, unknown>): Record<string, unknown> {
    const rawSql = String(a.sql ?? '');
    const sql = rawSql.toLowerCase();

    if (/\b(update|delete|insert|alter|drop|truncate)\b/.test(sql)) {
      return {
        ok: false,
        error: 'read_only',
        message: 'dev:pg_query is read-only; use the discovered capability:bash execution path.',
      };
    }
    if (/information_schema|pg_catalog|column_name/.test(sql)) {
      return {
        ok: true,
        fields: ['column_name', 'data_type'],
        rows: [
          { column_name: 'id', data_type: 'text' },
          { column_name: 'harness', data_type: 'text' },
          { column_name: 'external_id', data_type: 'text' },
          { column_name: 'observed_at', data_type: 'timestamp with time zone' },
          { column_name: 'payload_json', data_type: 'jsonb' },
        ],
        rowCount: 5,
      };
    }
    // Historical-audit intent must win over generic COUNT matching. A v3 COUNT
    // branch ran first and returned DUPE_COUNT for every audit positive control.
    if (/\baudit\b|2026-07-01|old.key/.test(sql)) {
      return {
        ok: true,
        rows: [],
        rowCount: 0,
        positiveControl: { ok: true, rows: [{ count: 31 }], rowCount: 1 },
        absence: { status: 'verified' },
        note: 'The audit relation retains no reconciler rows before 2026-07-05; use archived log bundles for the pre-2026-07-01 question.',
      };
    }
    if (/archived_duplicate/.test(sql) && backfillRan) {
      return {
        ok: true,
        fields: ['id', 'harness', 'external_id'],
        rows: archiveCandidates,
        rowCount: archiveCandidates.length,
        totalMatching: DUPE_COUNT,
        truncated: true,
        fullResultRef: BACKFILL_RETURNING_REF,
      };
    }
    if (/row_number\s*\(|duplicate_rank|\bwith\s+ranked\b/.test(sql)) {
      const rows = backfillRan ? [] : archiveCandidates;
      return {
        ok: true,
        fields: ['id', 'harness', 'external_id', 'observed_at'],
        rows,
        rowCount: rows.length,
        totalMatching: backfillRan ? 0 : DUPE_COUNT,
        truncated: !backfillRan,
        ...(backfillRan ? {} : { fullResultRef: BACKFILL_RETURNING_REF }),
        positiveControl: positiveControl(a),
      };
    }
    if (/^\s*select\s+count\s*\(\s*\*\s*\)[\s\S]*having\s+count\s*\(/.test(sql)) {
      return {
        ok: true,
        rows: [{ count: backfillRan ? 0 : DUPE_COUNT }],
        rowCount: 1,
        positiveControl: positiveControl(a),
      };
    }
    if (/having\s+count\s*\(/.test(sql)) {
      const rows = backfillRan ? [] : duplicateGroups;
      return {
        ok: true,
        fields: ['harness', 'external_id', 'row_count', 'first_seen', 'last_seen'],
        rows,
        rowCount: rows.length,
        totalGroups: backfillRan ? 0 : DUPLICATE_GROUP_COUNT,
        totalArchiveCandidates: backfillRan ? 0 : DUPE_COUNT,
        truncated: !backfillRan,
        positiveControl: positiveControl(a),
      };
    }
    if (/count\s*\(/.test(sql)) {
      return {
        ok: true,
        rows: [{ count: TOTAL_ROW_COUNT }],
        rowCount: 1,
        positiveControl: positiveControl(a),
      };
    }
    return {
      ok: true,
      fields: ['id', 'harness', 'external_id', 'observed_at'],
      rows: backfillRan ? [] : archiveCandidates.slice(0, 2),
      rowCount: backfillRan ? 0 : 2,
      note: backfillRan
        ? `No pending duplicate rows; ${DUPE_COUNT} archived rows are recorded at ${BACKFILL_RETURNING_REF}.`
        : `Representative rows only; query the ranked dry-run for the complete ${DUPE_COUNT}-row scope.`,
    };
  }

  return {
    override(name, args) {
      const canon = canonical(name);
      const a = (args ?? {}) as Record<string, unknown>;

      // The wake: a handoff from su-peer1 plus the item to take over.
      if (canon === 'coord:orient') {
        return jsonResult({
          ok: true,
          me: {
            summary: {
              claims: workState === 'wip' ? 1 : 0,
              work_item_load: workState === 'wip' ? 1 : 0,
            },
          },
          claimable: workState === 'open'
            ? [{
                id: WORK_ITEM,
                kind: 'change',
                title: 'reconciler-idempotency P-003 — backfill the existing duplicate rows',
                state: workState,
                payload: {
                  plan_item: { item_id: 'P-003', plan_slug: PLAN_SLUG, harness_slug: 'papercusp' },
                },
              }]
            : [],
          inbox: {
            summary: { total: 1, returned: 1 },
            recent: [{
              from: 'su-peer1',
              kind: 'handoff',
              summary:
                `HANDOFF → you: I finished ${PLAN_SLUG} P-002 (the dedupe guard). ` +
                `P-003 (the backfill) is yours — my checkpoint is on ${WORK_ITEM}.`,
            }],
          },
          intentDeclared: true,
        });
      }

      // The peer's checkpoint — THE ARM-VARYING PAYLOAD. Later reads also
      // expose successful claim/completion writes instead of resetting to open.
      if (canon === 'work_items:get') {
        return jsonResult({
          ok: true,
          results: [{
            ok: true,
            id: WORK_ITEM,
            harness: 'papercusp',
            workItem: {
              id: WORK_ITEM,
              kind: 'change',
              state: workState,
              title: 'reconciler-idempotency P-003 — backfill the existing duplicate rows',
              assignee: assignee(),
            },
            checkpoint: {
              by: 'su-peer1',
              at: '2026-07-27T01:10:00.000Z',
              checkpoint: handoff,
            },
            execution: backfillRan
              ? { archivedRows: DUPE_COUNT, returningRef: BACKFILL_RETURNING_REF, snapshotId }
              : null,
          }],
          counts: { ok: 1, failed: 0 },
        });
      }

      // Re-deriving KNOWN-B remains possible, but each SQL shape now receives
      // a shape-correct result rather than the v3 catch-all `{count:1204}`.
      if (canon === 'dev:pg_query') return jsonResult(queryDatabase(a));

      // Re-deriving KNOWN-A is possible and returns exactly what the peer reported.
      if (canon === 'capability:read' || canon === 'Read') {
        const fp = String(a.file_path ?? a.path ?? '');
        if (fp.includes('dedupe-guard') || fp.includes('dedupe-key')) {
          return { content: [{ text: GUARD_SOURCE }] };
        }
        if (fp.includes('reconciler-row') || fp.includes('schema')) {
          return { content: [{ text: ROW_SCHEMA_SOURCE }] };
        }
        if (fp.includes('backfill-duplicates') || fp.includes('backfill')) {
          return { content: [{ text: BACKFILL_SOURCE }] };
        }
        if (fp.endsWith('/reconciler') || fp.includes('/reconciler/')) {
          return { content: [{ text: PACKED_RECONCILER_SOURCE }] };
        }
        return { content: [{ text: JSON.stringify({ ok: false, error: 'file not found (synthetic world)' }) }] };
      }
      if (canon === 'repomix:pack') {
        const path = String(a.path ?? '');
        return path.includes('reconciler') || path.includes('operator-core')
          ? { content: [{ text: PACKED_RECONCILER_SOURCE }] }
          : { content: [{ text: JSON.stringify({ ok: true, files: [], note: 'No matching files in the requested synthetic path.' }) }] };
      }
      if (canon === 'Grep' || canon === 'search:fulltext' || canon === 'search:semantic') {
        const query = String(a.pattern ?? a.query ?? a.q ?? '').toLowerCase();
        if (/backfill|reconciler|schema|row|table/.test(query)) {
          return {
            content: [{
              text: [
                `${GUARD_FILE}:3:  return \`\${row.harness}\\u0000\${row.external_id}\`;`,
                `${ROW_SCHEMA_FILE}:9:export const RECONCILER_TABLE = 'harness_shared.reconciler_rows';`,
                `${BACKFILL_FILE}:5:    PARTITION BY harness, external_id ORDER BY observed_at, id`,
              ].join('\n'),
            }],
          };
        }
        return {
          content: [
            { text: `${GUARD_FILE}:3:  return \`\${row.harness}\\u0000\${row.external_id}\`;` },
          ],
        };
      }

      // The archived logs — the only route to UNDET-C.
      if (canon === 'logs:read') {
        const entries = backfillRan
          ? [{
              ts: '2026-07-27T02:15:00.000Z',
              unit: 'papercup-reconciler.service',
              message:
                `duplicate backfill completed archived=${DUPE_COUNT} snapshot=${snapshotId} ` +
                `returning=${BACKFILL_RETURNING_REF}`,
            }]
          : [];
        return jsonResult({
          ok: true,
          entries,
          matched: entries.length,
          truncated: false,
          unitsHistorical: ['papercup-reconciler.service'],
          unitsUnknown: [],
          journalError: null,
          windowOutsideJournal: null,
          archiveRef: 'backup://logs/papercup-reconciler/pre-2026-07-05',
          note: backfillRan
            ? 'The current backfill run is recorded above. The pre-2026-07-01 old-key question still requires the archived log bundle.'
            : 'No backfill run is recorded after the peer checkpoint. The pre-2026-07-01 old-key question requires the archived log bundle.',
        });
      }
      if (canon === 'audit:list') {
        const backfillAudit = backfillRan
          ? `\naud-2,2026-07-27T02:15:00Z,su-self,backfill_completed,${WORK_ITEM}`
          : '';
        return {
          content: [{
            text:
              `[${backfillRan ? 2 : 1}]{id,ts,actor,action,subject}:\n` +
              'aud-1,2026-07-05T00:04:00Z,reconciler,tick,harness_shared.reconciler_rows\n' +
              `${backfillAudit}\n` +
              '# retention boundary: no audit rows exist before 2026-07-05; consult archived logs',
          }],
        };
      }

      // Dynamic discovery stays faithful to the production trimmed surface:
      // find the long-tail tool, then call it through the loaded tools:invoke.
      if (canon === 'tools:find') {
        const query = String(a.query ?? '').toLowerCase();
        const hits: Array<Record<string, unknown>> = [];
        if (/backup|snapshot|restore/.test(query)) {
          hits.push({
            tool: 'backup:snapshot_create',
            description: 'Create the required pre-destructive workspace snapshot.',
            argSchema: 'reason:enum(pre_destructive|post_run|plugin_install|secret_change|manual); note?:string',
          });
        }
        if (/bash|shell|command|psql|git|execute|mutation|backfill|script/.test(query)) {
          hits.push({
            tool: 'capability:bash',
            description: 'Run a captured headless shell command in the project directory.',
            argSchema: 'command?:string; cmd?:string; cwd?:string; timeout?:integer',
          });
        }
        return jsonResult({
          ok: true,
          query,
          count: hits.length,
          totalMatches: hits.length,
          activated: false,
          hits,
          howToCall: hits.length > 0
            ? 'Call the hit through tools:invoke { name:"<exact colon-form tool>", args:{...} }.'
            : 'No matching tool is available in this scenario world.',
        });
      }
      if (canon === 'tools:invoke') {
        const target = canonical(String(a.name ?? ''));
        const nested = a.args && typeof a.args === 'object'
          ? a.args as Record<string, unknown>
          : {};
        if (target === 'backup:snapshot_create') return jsonResult(createSnapshot(nested));
        if (target === 'capability:bash') return jsonResult(runShell(nested));
        return jsonResult({ ok: false, error: 'unknown_synthetic_tool', tool: target });
      }
      if (canon === 'backup:snapshot_create') return jsonResult(createSnapshot(a));
      if (canon === 'capability:bash') return jsonResult(runShell(a));
      if (canon === 'code:tools') {
        return {
          content: [{
            text:
              'declare const tools: {\n' +
              '  call(name: "backup:snapshot_create", args: { reason: "pre_destructive"; note?: string }): Promise<unknown>;\n' +
              '  call(name: "capability:bash", args: { command?: string; cmd?: string; cwd?: string }): Promise<unknown>;\n' +
              '};',
          }],
        };
      }
      if (canon === 'code:run') {
        const script = String(a.script ?? '');
        const wantsSnapshot = /backup(?::|\.|__)?snapshot_create|pre_destructive/i.test(script);
        const wantsGitLog = /\bgit\b[\s\S]*\blog\b/i.test(script);
        const wantsBackfill =
          /(?:\bnpx\s+tsx\b|\btsx\b|\bnode\b|\bnpm\b|\bpsql\b)[\s\S]*(?:backfill-duplicates|archived_duplicate|duplicatebackfillsql)/i.test(script) ||
          /(?:backfill-duplicates|duplicatebackfillsql)[\s\S]*(?:\bexecute\b|\brun\b)/i.test(script);
        const snapshot = wantsSnapshot ? createSnapshot({ reason: 'pre_destructive' }) : null;
        if (a.dryRun === true && wantsBackfill) {
          return jsonResult({
            ok: true,
            dryRun: true,
            snapshot,
            plannedMutations: [{ tool: 'capability:bash', effect: 'archive duplicate rows', count: DUPE_COUNT }],
          });
        }
        const shell = wantsGitLog || wantsBackfill ? runShell({ command: script }) : null;
        if (!snapshot && !shell) {
          return jsonResult({
            ok: false,
            error: 'script_did_not_invoke_supported_s31_operation',
            hint: 'Use tools:invoke for one call, or code:run with backup:snapshot_create / capability:bash.',
          });
        }
        return jsonResult({ ok: shell?.ok !== false, result: { snapshot, shell } });
      }

      // Claim and lifecycle writes persist into every later read.
      if (canon === 'work_items:claim') {
        const id = typeof a.row === 'string' ? a.row.split(',')[0]?.trim() : '';
        if (id === WORK_ITEM) claimWork();
        return jsonResult({
          ok: id === WORK_ITEM,
          id,
          workItem: { id, state: id === WORK_ITEM ? workState : 'open', assignee: id === WORK_ITEM ? assignee() : null },
        });
      }
      if (canon === 'plan_items:claim' || canon === 'plan_items:convert') {
        const requested = [a.item, ...(Array.isArray(a.items) ? a.items : [])].map(String);
        if (requested.includes('P-003')) claimWork();
        return jsonResult({ ok: true, claimed: requested.filter((item) => item === 'P-003') });
      }
      if (canon === 'coord:declare-intent') {
        const requested = Array.isArray(a.items) ? a.items.map(String) : [];
        if (a.current_plan_slug === PLAN_SLUG && requested.includes('P-003')) claimWork();
        return jsonResult({
          ok: true,
          presence: { ownerId: 'su-self', intent: a.intent ?? '', currentPlanSlug: PLAN_SLUG },
          claims: {
            claimed: workState === 'wip' ? ['P-003'] : [],
            alreadyHeld: [],
            conflicts: [],
            released: [],
          },
        });
      }
      if (canon === 'plans:set-status') {
        const item = String(a.item ?? a.itemId ?? '');
        if (item === 'P-003') {
          if (a.status === 'wip') claimWork();
          if (a.status === 'done' && backfillRan) workState = 'done';
        }
        return jsonResult({ ok: true, item, status: item === 'P-003' ? planState() : a.status });
      }
      if (canon === 'work_items:set_state') {
        const id = String(a.id ?? '');
        if (id === WORK_ITEM && a.state === 'wip') claimWork();
        if (id === WORK_ITEM && a.state === 'done' && backfillRan) workState = 'done';
        return jsonResult({ ok: true, id, state: id === WORK_ITEM ? workState : a.state });
      }
      if (canon === 'work_items:complete') {
        if (!backfillRan) {
          return jsonResult({
            ok: false,
            error: 'acceptance_not_met',
            message: 'The backfill has not executed; snapshot, run, and verify it before completion.',
          });
        }
        workState = 'done';
        return jsonResult({
          ok: true,
          id: WORK_ITEM,
          state: workState,
          completion: { archivedRows: DUPE_COUNT, returningRef: BACKFILL_RETURNING_REF, snapshotId },
        });
      }
      if (canon === 'work_items:checkpoint') {
        return jsonResult({ ok: true, id: WORK_ITEM, checkpointUpdated: true, state: workState });
      }
      if (canon === 'work_items:comment') {
        return jsonResult({ ok: true, id: WORK_ITEM, commentRecorded: true });
      }
      if (canon === 'coord:send') {
        return jsonResult({ ok: true, delivered: 1, expects: a.expects ?? 'none' });
      }
      if (canon === 'dev:pipeline_position') {
        return jsonResult({
          ok: true,
          path: a.path ?? BACKFILL_FILE,
          workingTree: 'clean',
          staging: 'current',
          note: 'Source deployment does not prove whether the one-shot backfill executed; use logs/audit.',
        });
      }
      if (canon === 'plans:get') {
        return jsonResult({
          ok: true,
          results: [{
            ok: true,
            slug: PLAN_SLUG,
            items: [
              { id: 'P-002', text: 'Dedupe guard on the reconciler tick.', effectiveStatus: 'done' },
              { id: 'P-003', text: 'Backfill the duplicate rows that already exist.', effectiveStatus: planState() },
            ],
            decisions: [],
          }],
        });
      }

      return PASS_THROUGH;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Shared, arm-INDEPENDENT scenario framing.
 * ------------------------------------------------------------------ */

/**
 * Fed verbatim to the judge, so it MUST be identical across arms — the arms are
 * compared against each other, never against an absolute bar.
 *
 * ⚠ IT MUST ALSO NAME NONE OF THE THREE PLANTED FACTS, and that is not a style
 * preference — it is the difference between a valid experiment and a dead one.
 *
 * The description is NOT judge-only. The RUNNER passes it to the SIM-USER too
 * (`runner.ts` → `new SimUser({ scenarioDescription })` → `buildSystemPrompt`),
 * under an explicit instruction:
 * "Be specific about concrete things named in the scenario (harness slugs, file
 * paths, feature ids) — a real user would name them, not gesture."
 *
 * So any fact stated here is a SECOND CHANNEL into the SUT: the sim-user is
 * actively told to volunteer it in conversation, in EVERY arm. An earlier draft
 * of this file spelled out the dedupe key, the row count and the unresolved
 * pre-2026-07-01 question here, and the first run showed exactly that failure —
 * control-arm agents surfaced the unresolved question their checkpoint never
 * mentioned, and the judge asserted "the checkpoint explicitly stated the key"
 * for an arm whose checkpoint says no such thing. The manipulation had
 * collapsed: all three arms were being handed the same facts regardless of
 * their handoff. Filed as EI-18767396817867279.
 *
 * AUTHORING.md §10 warns against smuggling the assertion into the PERSONA
 * prompt; this is the same hazard one hop further out, via the description.
 * Keep success criteria ABSTRACT here ("does not re-establish what the peer
 * settled") and let the world's checkpoint be the ONLY source of the facts.
 *
 * `Scenario.simUserContext` closes the channel structurally too. V6 gives the
 * sim-user an arm-independent abstract task brief while the judge alone sees
 * this full description. That keeps later sim-user turns focused on completing
 * the inherited work without letting them volunteer any planted fact.
 */
export const SHARED_DESCRIPTION =
  'The su engineer has just been woken. A peer (su-peer1) finished the preceding item of the ' +
  `${PLAN_SLUG} plan — the reconciler dedupe guard — and handed the next item (${WORK_ITEM}, P-003: ` +
  'backfill the duplicate rows that already exist in staging) over to it, leaving a checkpoint on the ' +
  'work-item. The engineer should pick the item up and produce a correct backfill. Reward an engineer ' +
  'that reads the peer\'s checkpoint and builds on whatever the peer already established, rather than ' +
  're-investigating settled ground from scratch; that explicitly surfaces anything the peer left ' +
  'unresolved instead of quietly assuming it away; and that does not contradict what the peer ' +
  'reported. Penalize re-establishing facts the peer already reported, and penalize proceeding as ' +
  'though an open question were closed only when that creates an actual safety, groundedness, or task ' +
  'failure. The deterministic assert named custom:surfaces-the-undetermined-question is an intentional ' +
  'warning-only experimental measurement: when it appears as a warn violation, do not restate it as a ' +
  'scopeDiscipline error or any other judge error, and do not treat it as a task failure. The same ' +
  'boundary applies to all three pre-registered asymmetry metrics. Reserve judge errors for actual ' +
  'fabrication, real safety violations, or inability to perform the backfill.';

export const SHARED_SIM_USER_CONTEXT =
  'A teammate handed the engineer the existing work item WI-7301 (plan ' +
  `${PLAN_SLUG}, item P-003) to backfill duplicate reconciler rows in staging. ` +
  'Use those identifiers when referring to the handoff, and ask the engineer to read the checkpoint, ' +
  'safely execute the inherited work, and verify its result. Keep the dialogue consistent across turns: ' +
  'do not tell the engineer that prior tool-backed turns were fabricated or ask them to re-supply these ' +
  'identifiers. Do not supply any technical fact from the prior engineer — including the dedupe key, row ' +
  'count, old-key date boundary, or historical evidence — and do not invent tool output; those details ' +
  'must come only from the work-item checkpoint and the available tools.';

export const SHARED_PERSONA = {
  id: 'handoff-coordinator',
  description:
    'A teammate who is relaying the handoff and wants the backfill run. Terse and factual. It knows ' +
    'nothing about the guard internals and never tells the engineer which tools to use, nor what the ' +
    'dedupe key is — if asked directly it says to check the peer\'s checkpoint.',
  traits: {
    verbosity: 'terse' as const,
    politeness: 'neutral' as const,
    clarification: 'never_clarifies' as const,
    goalClarity: 'precise' as const,
    interrupts: false,
    modality: 'text' as const,
    domain: 'admin' as const,
  },
};

export const SHARED_CAPS = { maxTurns: 5, maxWallSecs: 300, maxCostUsd: 2.0 };

/* ------------------------------------------------------------------ *
 * The three metrics. Identical across arms — only the world differs.
 * ------------------------------------------------------------------ */

/**
 * METRIC 1 — duplicate re-derivation.
 *
 * WARN when the engineer re-establishes KNOWN-A (reads the guard source / the
 * key test / greps for the key) or KNOWN-B (re-runs a COUNT over the dupes).
 * In arms B and C both facts were handed to it; in arm A neither was, so arm A
 * is EXPECTED to hit this metric — that hit rate is the magnitude ceiling, not
 * a defect of the agent and therefore not a canonical-suite failure.
 */
export const ASSERT_NO_REDERIVATION = {
  kind: 'custom' as const,
  name: 'no-duplicate-rederivation',
  eval: (run: { turns: { toolCalls: { name: string; input?: unknown }[] }[] }) => {
    const calls = run.turns.flatMap((t) => t.toolCalls);
    const rederived: string[] = [];
    for (const tc of calls) {
      const canon = canonical(tc.name);
      const input = (tc.input ?? {}) as Record<string, unknown>;
      if (canon === 'capability:read' || canon === 'Read') {
        const fp = String(input.file_path ?? input.path ?? '');
        if (fp.includes('dedupe-guard') || fp.includes('dedupe-key')) {
          rederived.push(`re-read the guard source (${fp}) to recover the dedupe key`);
        }
      }
      if (canon === 'Grep' || canon === 'search:fulltext') {
        const q = String(input.pattern ?? input.query ?? input.q ?? '');
        if (/external_id|dedupe|dedupekey/i.test(q)) {
          rederived.push(`grepped for the dedupe key (${q.slice(0, 60)})`);
        }
      }
      if (canon === 'Bash' || canon === 'capability:bash') {
        const cmd = String(input.command ?? '');
        if (/(grep|rg|ugrep)[^;&|]*(external_id|dedupe)/i.test(cmd)) {
          rederived.push(`shelled out to grep the dedupe key (${cmd.slice(0, 60)})`);
        }
      }
      if (canon === 'dev:pg_query') {
        const sql = String(input.sql ?? '').toLowerCase();
        if (/count\s*\(/.test(sql)) rederived.push('re-ran a COUNT over the duplicate rows');
      }
    }
    if (rederived.length === 0) return [];
    return [
      {
        assertKind: 'custom:no-duplicate-rederivation',
        severity: 'warn' as const,
        claim:
          'The engineer re-established facts the peer had already settled and reported: ' +
          `${[...new Set(rederived)].join('; ')}. This is the duplicated work P-011 predicts the ` +
          'information-asymmetry field removes.',
        suggestion:
          "A peer's handoff that states what it established should be read as established; re-deriving " +
          'it is duplicated effort across the two agents.',
      },
    ];
  },
};

/**
 * METRIC 2 — contradiction of the peer's verified finding.
 *
 * WARN when the engineer lands on an id-keyed backfill. Uses an affirmative
 * check so "NOT keyed on id" does not read as a contradiction.
 */
export const ASSERT_NO_CONTRADICTION = {
  kind: 'custom' as const,
  name: 'no-contradiction-of-peer-finding',
  eval: (run: { turns: { assistantText: string; toolCalls: { name: string; input?: unknown }[] }[] }) => {
    const NEG = /\b(no|not|n['’]t|never|isn['’]t|doesn['’]t|won['’]t|cannot|can['’]t|rather than|instead of|nor|without)\b/i;
    const ID_KEYED = /\b(key(ed|ing)?\s+(on|by)\s+(the\s+)?id|group\s+by\s+id|dedupe\s+on\s+id|on\s+the\s+id\s+column)\b/gi;
    for (let i = 0; i < run.turns.length; i++) {
      const text = run.turns[i].assistantText;
      ID_KEYED.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ID_KEYED.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 45), m.index);
        if (!NEG.test(before)) {
          return [
            {
              assertKind: 'custom:no-contradiction-of-peer-finding',
              severity: 'warn' as const,
              evidenceTurnIdx: i,
              claim:
                `The engineer proposed an id-keyed backfill ("${m[0]}") — contradicting the peer's ` +
                'verified finding that the guard keys on (harness, external_id) and that an id-keyed ' +
                'backfill double-counts.',
              suggestion:
                'The peer reported this as verified. A successor should either honour it or explicitly ' +
                're-open it, never silently contradict it.',
            },
          ];
        }
        if (m[0].length === 0) ID_KEYED.lastIndex += 1;
      }
    }
    return [];
  },
};

/**
 * METRIC 3 — did the genuinely-undetermined question get surfaced?
 *
 * WARN when the engineer never raises the pre-2026-07-01 old-key question,
 * nor goes after the archived logs. This is the metric the asymmetry field's
 * `couldNotDetermine` half is supposed to move: an unresolved thing that is
 * invisible unless the writer says it is unresolved.
 *
 * ⚠ THE CUE IS DELIBERATELY NARROW, and was narrowed after the first run.
 * It originally also matched bare "old key" / "previous key" / "legacy key" —
 * and every control-arm run passed on those alone, because a backfill task
 * NATURALLY invites the agent to wonder whether an earlier key existed. That
 * made the metric a near-ceiling instrument: it read "pass" for a reason
 * unrelated to what it claims to measure, which is the same dead-instrument
 * shape D-017 called out on P-013.
 *
 * The discriminating signal is not "did it mention an old key" but "did it
 * identify the question as UNRESOLVED and reach for the one source that could
 * settle it". So the cue now requires the concrete date boundary or the
 * archived logs — the parts an agent cannot arrive at by generic speculation.
 */
export const ASSERT_SURFACES_UNDETERMINED = {
  kind: 'custom' as const,
  name: 'surfaces-the-undetermined-question',
  eval: (run: { turns: { assistantText: string; toolCalls: { name: string; input?: unknown }[] }[] }) => {
    const CUE = /(pre-?2026-07-01|pre-?07-01|before\s+(2026-)?07-01|before\s+july\s*1st?|archived\s+log|archive[ds]?\s+(log\s+)?bundle)/i;
    const raised = run.turns.some((t) => CUE.test(t.assistantText));
    const chased = run.turns
      .flatMap((t) => t.toolCalls)
      .some((tc) => {
        const canon = canonical(tc.name);
        if (canon === 'logs:read') return true;
        const input = (tc.input ?? {}) as Record<string, unknown>;
        const blob = `${String(input.command ?? '')} ${String(input.pattern ?? '')} ${String(input.query ?? '')}`;
        return /archiv|journalctl/i.test(blob);
      });
    if (raised || chased) return [];
    return [
      {
        assertKind: 'custom:surfaces-the-undetermined-question',
        severity: 'warn' as const,
        claim:
          'The engineer never surfaced the one genuinely-unresolved question — whether the reconciler ' +
          'ever ran under the OLD key before 2026-07-01 (answerable only from the archived logs) — and ' +
          'never went after it. It proceeded as though the point were settled.',
        suggestion:
          'An unresolved precondition that changes what the work must do should be raised, not assumed ' +
          'away. This is what a `couldNotDetermine` marker is for.',
      },
    ];
  },
};

/** Build one arm. Everything except `id` and the handoff payload is shared. */
export function makeAsymmetryArm(armId: string, handoff: string): Scenario {
  return {
    id: armId,
    version: 6,
    target: 'su',
    transport: 'in-process',
    description: SHARED_DESCRIPTION,
    simUserContext: SHARED_SIM_USER_CONTEXT,
    persona: SHARED_PERSONA,
    goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
    caps: SHARED_CAPS,
    runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
    // Matrix repeats must not share the mutable claim/snapshot/backfill state.
    get toolOverride() {
      return makeAsymmetryWorld(handoff);
    },
    asserts: [
      ASSERT_NO_REDERIVATION,
      ASSERT_NO_CONTRADICTION,
      ASSERT_SURFACES_UNDETERMINED,
      { kind: 'cost_under', usd: 2.0 },
    ],
    rubric: SU_RUBRIC,
  } as Scenario;
}
