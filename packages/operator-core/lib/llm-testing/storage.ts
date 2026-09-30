/**
 * PG persistence for llm_test_runs / llm_test_findings.
 *
 * Plan §7. Inserts one row per single SUT-vs-Sim run (matrix groups
 * share matrix_group_id), then one row per finding (assert violations
 * + judge findings + variance findings).
 *
 * Schema lives in libs/papercusp/libs/db/sql/073-llm-testing.sql.
 */

// `postgres` stays imported for the JSONValueCompat type below — NOT for building a pool.
import postgres from 'postgres';
import { sharedUtilityPoolMax } from '../resource-profile';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { getLongLivedAdminPool } from '../long-lived-admin-pool';

import {
  simActionToTurnContext,
  type RunReport,
  type SingleRunReport,
  type SimHistoryEntry,
  type SimTurnContext,
} from '@papercusp/testing-shell/llm';
import { normalizeToolResultEvidence } from './tool-result-evidence';

/**
 * EI-9319: postgres.js's `sql.json()` param type is a structural JSONValue
 * (readonly index signature of JSONValue|undefined|function) that our plain
 * interfaces (PersonaTraits, etc.) and `unknown`-typed helper returns don't
 * structurally satisfy, even though they ARE valid JSON at runtime — this repo
 * uses `sql.json()` deliberately here (fresh non-getOrgPg pool; see
 * agent-insights/postgres-js-jsonb-binding "NOT affected" list), so the fix is
 * a narrow escape hatch at the call site, not a rewrite to ::jsonb casting.
 */
type JSONValueCompat = Parameters<ReturnType<typeof postgres>['json']>[0];

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Still a DEDICATED pool rather than getOrgPg, so the EI-9319
// `sql.json()` reasoning above is unchanged by this migration.
const db = () => getLongLivedAdminPool('llm-testing-storage', {
  max: sharedUtilityPoolMax(),
  prepare: false,
});

export async function persistRunReport(report: RunReport, rubricVersion: string, scenarioHash: string): Promise<void> {
  const sql = db();
  for (const run of report.runs) {
    await persistSingleRun(sql, run, report.matrixGroupId, rubricVersion, scenarioHash);
  }
}

async function persistSingleRun(
  sql: ReturnType<typeof postgres>,
  r: SingleRunReport,
  matrixGroupId: string | undefined,
  rubricVersion: string,
  scenarioHash: string,
): Promise<void> {
  const s = r.summary;

  const findingsCount = {
    error: r.violations.filter((v) => v.severity === 'error').length
      + r.judge.findings.filter((f) => f.severity === 'error').length,
    warn: r.violations.filter((v) => v.severity === 'warn').length
      + r.judge.findings.filter((f) => f.severity === 'warn').length,
    info: r.violations.filter((v) => v.severity === 'info').length
      + r.judge.findings.filter((f) => f.severity === 'info').length,
  };

  const transcriptRaw = JSON.stringify(s.turns.flatMap((t) => t.rawSseTape));
  const transcriptRawBytes = zstdCompressSync(Buffer.from(transcriptRaw, 'utf8'));

  await sql`
    INSERT INTO harness_shared.llm_test_runs (
      id, scenario_id, scenario_version, scenario_target, scenario_hash,
      identity_hash, matrix_group_id, matrix_index,
      rubric_version, sut_model, judge_model,
      persona_id, persona_traits_json,
      workspace_mode, transport_mode,
      status, started_at, finished_at,
      cost_usd, cap_breaches,
      scores_json, findings_count,
      transcript_raw_zstd, transcript_norm_json,
      telemetry_json, asserts_json, judge_json, metadata_json
    ) VALUES (
      ${s.runId}, ${s.scenarioId}, ${s.scenarioVersion}, ${s.scenarioTarget}, ${scenarioHash},
      ${s.identityHash}, ${matrixGroupId ?? null}, ${s.matrixIndex ?? null},
      ${rubricVersion}, ${s.sutModel}, ${s.judgeModel},
      ${s.personaId}, ${sql.json(s.personaTraits as unknown as JSONValueCompat)},
      ${s.workspaceMode}, ${s.transportMode},
      ${r.status === 'passed' ? 'passed' : r.status === 'errored' ? 'errored' : 'failed'},
      ${s.startedAt}, ${s.finishedAt},
      ${s.totalCostUsd}, ${s.capBreaches},
      ${sql.json(r.judge.scores)}, ${sql.json(findingsCount)},
      ${transcriptRawBytes}, ${sql.json(normalizeTurns(s.turns, r.simHistory) as unknown as JSONValueCompat)},
      ${sql.json({ toolInvocations: s.toolInvocations, continueChainRows: s.continueChainRows, ...(s.variantId ? { variantId: s.variantId } : {}) } as unknown as JSONValueCompat)},
      ${sql.json({ asserts: 'see-scenario', violations: r.violations } as unknown as JSONValueCompat)},
      ${sql.json({ scores: r.judge.scores, findings: r.judge.findings, notes: r.judge.notes, judgeOverruledAssert: r.judge.judgeOverruledAssert, costUsd: r.judge.costUsd } as unknown as JSONValueCompat)},
      ${sql.json({ ...(s.timeout ? { timeout: s.timeout } : {}) } as unknown as JSONValueCompat)}
    )
  `;

  // Findings (one row each — assert violations + judge findings).
  for (const v of r.violations) {
    await sql`
      INSERT INTO harness_shared.llm_test_findings (
        run_id, source, severity, axis, assert_kind, shape,
        evidence_turn_idx, claim, suggestion, copy_prompt,
        promoted_from
      ) VALUES (
        ${s.runId}, 'assert', ${v.severity}, NULL, ${v.assertKind}, NULL,
        ${v.evidenceTurnIdx ?? null}, ${v.claim}, ${v.suggestion ?? null}, NULL,
        ${v.originatingFindingIds ?? []}
      )
    `;
  }
  for (const f of r.judge.findings) {
    await sql`
      INSERT INTO harness_shared.llm_test_findings (
        run_id, source, severity, axis, assert_kind, shape,
        evidence_turn_idx, claim, suggestion, copy_prompt
      ) VALUES (
        ${s.runId}, 'judge', ${f.severity}, ${f.axis}, NULL, ${f.shape},
        ${f.evidenceTurnIdx ?? null}, ${f.claim}, ${f.suggestion ?? null}, ${f.copyPrompt}
      )
    `;
  }
}

/**
 * Latest recorded verdict per scenario id — the read side the delta safety gate
 * (agent-tool-delta-protocol P-016, apps/operator/lib/release/delta-gate.ts)
 * consumes instead of running the live model synchronously. Returns, for each
 * requested scenario, the status + finished_at of its MOST-RECENT completed run
 * (finished_at IS NOT NULL), or status:null when it has never run. The gate
 * classifies these against a freshness window.
 */
export async function latestScenarioVerdicts(
  scenarioIds: readonly string[],
): Promise<Array<{ scenarioId: string; status: 'passed' | 'failed' | 'errored' | null; finishedAtMs: number | null }>> {
  const ids = [...scenarioIds];
  if (ids.length === 0) return [];
  const sql = db();
  // DISTINCT ON (scenario_id) → the newest completed run per scenario.
  const rows = (await sql`
    SELECT DISTINCT ON (scenario_id)
      scenario_id, status, finished_at
    FROM harness_shared.llm_test_runs
    WHERE scenario_id = ANY(${ids}) AND finished_at IS NOT NULL
    ORDER BY scenario_id, finished_at DESC
  `) as unknown as Array<{ scenario_id: string; status: string; finished_at: Date | string | null }>;
  const byId = new Map(rows.map((r) => [r.scenario_id, r]));
  return ids.map((scenarioId) => {
    const r = byId.get(scenarioId);
    if (!r) return { scenarioId, status: null, finishedAtMs: null };
    const status =
      r.status === 'passed' || r.status === 'failed' || r.status === 'errored' ? r.status : null;
    const finishedAtMs = r.finished_at ? new Date(r.finished_at).getTime() : null;
    return { scenarioId, status, finishedAtMs };
  });
}

/** Decompress a transcript_raw_zstd bytea cell back to the raw SSE JSON array. */
export function decompressTranscript(bytes: Buffer | Uint8Array): unknown[] {
  const decompressed = zstdDecompressSync(Buffer.from(bytes));
  return JSON.parse(decompressed.toString('utf8')) as unknown[];
}

function normalizeTurns(
  turns: SingleRunReport['summary']['turns'],
  simHistory?: SimHistoryEntry[],
): unknown {
  const contexts = simContextsForHistory(simHistory);
  return turns.map((t, idx) => {
    // Prefer the explicit history projection. The turn fallback keeps
    // hand-built/in-memory reports and already-enriched callers readable.
    const context = contexts[idx] ?? (
      t.userText !== undefined
        ? {
            userText: t.userText,
            simThought: t.simThought ?? '',
            simKind: t.simKind ?? 'text',
          }
        : undefined
    );
    return {
      idx,
      assistantText: t.assistantText,
      toolCalls: t.toolCalls,
      toolResults: normalizeToolResultEvidence(t.toolResults),
      cards: t.cards,
      controlTags: t.controlTags,
      finishReason: t.finishReason,
      costUsd: t.costUsd,
      latencyMs: t.latencyMs,
      error: t.error,
      ...(context ? {
        userText: context.userText,
        simThought: context.simThought,
        simKind: context.simKind,
      } : {}),
    };
  });
}

function simContextsForHistory(
  simHistory?: SimHistoryEntry[],
): Array<SimTurnContext | undefined> {
  if (!simHistory) return [];
  const contexts: Array<SimTurnContext | undefined> = [];
  let pending: SimTurnContext | undefined;
  for (const entry of simHistory) {
    if (entry.who === 'sim') {
      pending = simActionToTurnContext(entry.action);
    } else {
      contexts.push(pending);
      pending = undefined;
    }
  }
  return contexts;
}
