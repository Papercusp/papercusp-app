/**
 * `llm-test promote --shape <hash>` — scaffold a built-in assert stub
 * for a novel-failure shape that has recurred.
 *
 * Plan §6.6 step 3. The CLI gives the admin:
 *   1. A new file at apps/operator/lib/llm-testing/asserts/promoted-<id>.ts
 *      containing a stub `registerEvaluator('custom', ...)` plus a TODO
 *      block describing the originating findings.
 *   2. A PG update marking those findings' `promoted_to_assert_id` so
 *      the audit trail in the UI shows the lineage.
 *
 * The stub is intentionally a `'custom'`-kind evaluator (not a brand-new
 * kind). The admin decides afterward whether to promote it to a proper
 * kind in types.ts.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLongLivedAdminPool } from '../../long-lived-admin-pool';

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () => getLongLivedAdminPool('llm-testing-promote', { max: 2, prepare: false });

export interface PromoteResult {
  assertId: string;
  filePath: string;
  findingsLinkedCount: number;
  exampleClaim: string;
}

export async function promoteShape(shape: string): Promise<PromoteResult> {
  const sql = db();

  // 1. Find the originating findings for this shape.
  const findings = await sql<Array<{
    id: string;
    axis: string;
    claim: string;
    suggestion: string | null;
  }>>`
    SELECT id, axis, claim, suggestion
    FROM harness_shared.llm_test_findings
    WHERE shape = ${shape}
      AND source = 'judge'
      AND promoted_to_assert_id IS NULL
    ORDER BY id ASC
  `;

  if (findings.length === 0) {
    throw new Error(
      `No unpromoted findings with shape='${shape}'. Either the hash is wrong, the findings already got promoted, or no judge findings carry this shape.`,
    );
  }

  const axis = findings[0].axis;
  const exampleClaim = findings[0].claim;
  const assertId = `promoted-${shape.slice(0, 12)}`;
  const filePath = resolveAssertFilePath(assertId);

  if (existsSync(filePath)) {
    throw new Error(`Assert file already exists: ${filePath}. Either edit it directly or pick a fresh shape.`);
  }

  // 2. Write the stub.
  const stub = renderStub({ assertId, axis, shape, exampleClaim, findings });
  writeFileSync(filePath, stub, 'utf8');

  // 3. Mark every originating finding.
  await sql`
    UPDATE harness_shared.llm_test_findings
    SET promoted_to_assert_id = ${assertId}
    WHERE shape = ${shape}
      AND source = 'judge'
      AND promoted_to_assert_id IS NULL
  `;

  return {
    assertId,
    filePath,
    findingsLinkedCount: findings.length,
    exampleClaim,
  };
}

function resolveAssertFilePath(assertId: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'asserts', `${assertId}.ts`);
}

function renderStub(input: {
  assertId: string;
  axis: string;
  shape: string;
  exampleClaim: string;
  findings: Array<{ id: string; axis: string; claim: string; suggestion: string | null }>;
}): string {
  const findingComments = input.findings
    .slice(0, 5)
    .map((f) => ` *   - ${trunc(f.claim, 120)}${f.suggestion ? ` (suggestion: ${trunc(f.suggestion, 80)})` : ''}`)
    .join('\n');
  return `/**
 * Promoted assert: ${input.assertId}
 *
 * Axis: ${input.axis}
 * Shape: ${input.shape}
 *
 * Promoted from ${input.findings.length} judge finding(s):
${findingComments}
 *
 * TODO: replace the placeholder predicate with the real deterministic
 *       check. The plan (§6.6) says the admin decides what concrete
 *       heuristic captures the recurring failure — typically a
 *       text-/tool-/card-shaped check that mirrors what the judge was
 *       noticing.
 *
 * After implementing, consider whether this deserves its own kind in
 * types.ts (vs staying as a 'custom' wrapper). Promoted asserts default
 * to 'custom' so the change is reversible.
 */

import { registerEvaluator } from '@papercusp/testing-shell/llm';
import type { Violation } from '@papercusp/testing-shell/llm';

const ASSERT_ID = ${JSON.stringify(input.assertId)};

/**
 * Originating finding ids — the judge findings that drove this
 * assert's promotion. Storage attaches them to violation rows so the
 * UI shows lineage ("this check came from N findings in older runs").
 * Do NOT remove; promotion lineage breaks if this list is empty.
 */
const ORIGINATING_FINDING_IDS: readonly string[] = ${JSON.stringify(input.findings.map((f) => f.id))};

// Custom-kind evaluator. To use, add to a scenario's asserts:
//   { kind: 'custom', name: '${input.assertId}', eval: (run) => evaluate(run) }
//
// Or promote to a kind in types.ts and re-register here.

export function evaluate(_run: import('@papercusp/testing-shell/llm').RunSummary): Violation[] {
  // TODO: implement the deterministic predicate. Each Violation you
  // return should set originatingFindingIds: [...ORIGINATING_FINDING_IDS]
  // so the lineage reaches storage.
  return [];
}

// Auto-register a no-op 'custom' wrapper so scenarios can declare:
//   { kind: 'custom', name: ASSERT_ID, eval: evaluate }
// without further wiring.
registerEvaluator('custom', (a, run) => {
  if (a.name !== ASSERT_ID) return [];
  return evaluate(run).map((v) => ({ ...v, originatingFindingIds: [...ORIGINATING_FINDING_IDS] }));
});
`;
}

function trunc(s: string, n: number): string {
  const clean = s.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}
