#!/usr/bin/env npx tsx
/**
 * check-cell-live-matrix.ts — P-004's LIVE READ MATRIX, driven against a running operator
 * (agent-state-plane-verification-2026-07-27).
 *
 * All judgement lives in `cell-live-matrix.ts` and is unit-tested there. This file is the
 * thin live half: drive `POST /api/agent-mcp/run-tool` for every registered cell across
 * the four conditions, on BOTH operators, resolve which known-gap items are still open,
 * print, exit.
 *
 * ⚠ THIS MUST NOT BE ADDED TO THE CI LINT JOB. It requires a RUNNING operator on :3170
 * and :3070. CI has neither, so every read would fail, or — worse, if a future author
 * "helpfully" makes the failures non-fatal — it would observe zero squares and exit 0
 * forever while presenting as coverage. That is the defect filed as WI-6476 against
 * P-001's producer census and widened to P-003's ratchet; building it a third time
 * knowing what it is would be indefensible. `assessMatrix` refuses an empty run for
 * exactly this reason. Its runner belongs alongside the P-015 sweep, on the live box.
 *
 * ⚠ THE A/B IS NO LONGER FIXED-vs-UNFIXED. P-004's text calls :3070 an "unfixed control"
 * because this A/B is what proved WI-6444. WI-6444 is CLOSED and deployed to both ports;
 * measured 2026-07-27 the two matrices are byte-identical on every square, INCLUDING the
 * two still-open defects. Read divergence as "a change has crossed the deploy boundary on
 * one side only" — never read agreement as health.
 *
 * Usage:  npm run lint:cell-matrix          (both ports)
 *         npm run lint:cell-matrix -- --port 3170    (one port, no A/B)
 */
import {
  assessMatrix,
  compareAb,
  KNOWN_GAPS,
  type CellObservation,
  type MatrixCondition,
} from '../packages/operator-core/lib/cell-live-matrix';
import { BUILTIN_CELLS } from '../packages/operator-core/lib/cell-registrations';
import type { CellSpec } from '../packages/operator-core/lib/cell-registry';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';

const TERMINAL_STATUSES = new Set(['done', 'dropped', 'resolved', 'closed', 'passed', 'deprecated']);

/* -------------------------------------------------------------------------- */
/* The probe                                                                   */
/* -------------------------------------------------------------------------- */

interface ReadOutcome {
  payload?: Record<string, unknown>;
  error?: string;
}

/**
 * One `state:read` through the loopback palette route.
 *
 * ⚠ WHY `run-tool` WORKS HERE AT ALL, since D-013 records that it 403s arg-taking tools
 * with `not_palette_eligible`: `state:read`'s args are ALL OPTIONAL, so the §3 filter
 * does not exclude it. Its resolver tools are NOT so lucky — `dev:pipeline_position`
 * requires `path`/`sha` and does 403 there. So this route can drive the CELL layer and
 * cannot drive the resolver layer directly; a successor comparing a cell against its raw
 * resolver must use the MCP endpoint (`/api/mcp?superuser=1`) for the latter half.
 */
async function stateRead(port: string, args: Record<string, unknown>): Promise<ReadOutcome> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/agent-mcp/run-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'state:read', args }),
    });
  } catch (e) {
    return { error: `fetch failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
  let env: { ok?: boolean; error?: string; result?: { content?: Array<{ text?: string }> } };
  try {
    env = (await res.json()) as typeof env;
  } catch {
    return { error: 'unparseable envelope' };
  }
  if (!env.ok) return { error: `envelope: ${env.error ?? 'unknown'}` };
  const text = env.result?.content?.[0]?.text;
  if (typeof text !== 'string') return { error: 'no tool payload' };
  try {
    return { payload: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { error: 'unparseable tool payload' };
  }
}

/** Turn a raw `state:read` payload into the comparable observation shape. */
function observe(
  cell: string,
  condition: MatrixCondition,
  port: string,
  spec: CellSpec | undefined,
  out: ReadOutcome,
): CellObservation {
  const declaresHoist = spec?.unknownHoist !== undefined;
  const declaresAssessment = spec?.assessment !== undefined && spec.assessment !== null;
  if (out.error !== undefined || !out.payload) {
    return {
      cell,
      condition,
      port,
      status: 'value',
      declaresHoist,
      declaresAssessment,
      readError: out.error ?? 'no payload',
    };
  }
  const p = out.payload;
  const status = p.status as CellObservation['status'];
  const hoistRaw = p.unknownHoist as CellObservation['hoist'] | undefined;
  return {
    cell,
    condition,
    port,
    status,
    ...(status === 'value' ? { value: p.value } : {}),
    ...(status === 'unknown'
      ? { unknownCode: (p.unknown as { code?: string } | undefined)?.code }
      : {}),
    // `null` (no field emitted) and an emitted hoist are DIFFERENT facts — do not merge
    // them here, or `hoist-missing` is erased before the verdict logic ever sees it.
    ...(declaresHoist ? { hoist: hoistRaw ?? null } : {}),
    declaresHoist,
    // Distinguish an omitted assessment from an explicitly unavailable one. The
    // former is a delivery-contract break; the latter carries its own safe action.
    ...(declaresAssessment
      ? { assessment: (p.assessment as CellObservation['assessment'] | undefined) ?? null }
      : {}),
    declaresAssessment,
    keys: Object.keys(p).sort(),
  };
}

/* -------------------------------------------------------------------------- */
/* Subjects                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The subject to use per declared parameter, for each of the two subject conditions.
 *
 * The degrading subjects are chosen to be UNAMBIGUOUSLY empty rather than merely odd: a
 * path no commit has ever touched, an owner id no session has ever used. A subject that
 * merely happens to be quiet today would make this square flap.
 */
const SUBJECTS: Record<string, { withValue: string | null; degrades: string }> = {
  // Keep the positive control STABLE. CLAUDE.md is a shared hot file and routinely
  // carries a peer's newer/dirty edit, which correctly makes its assessment
  // unavailable and turns a valid probe into a false matrix failure. This README is
  // tracked, clean, present in main, and deployed; the matrix still verifies that live
  // truth rather than assuming it from this comment.
  path: { withValue: 'apps/operator/README.md', degrades: 'does/not/exist.probe.ts' },
  // Resolved live from the DB — see `resolveLiveHolder`.
  ownerId: { withValue: null, degrades: 'su-no-such-owner-p004-probe' },
};

/** A never-registered cell id, for the reachable half of the P-019 non-oracle pair. */
const UNREGISTERED_PROBE = 'p004.never.registered.probe';

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const portArg = argv.indexOf('--port');
  const ports = portArg >= 0 ? [argv[portArg + 1]] : ['3170', '3070'];

  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });

  let openGapItems = new Set<string>();
  let liveHolder: string | null = null;
  try {
    const refs = [...new Set(Object.values(KNOWN_GAPS))];
    if (refs.length > 0) {
      const rows = await sql<Array<{ feature_id: string; status: string }>>`
        SELECT feature_id, status FROM harness_shared.work_items
        WHERE feature_id = ANY(${refs}) AND workspace_id = ${process.env.PAPERCUSP_WORKSPACE_ID ?? 'papercusp-workspace'}
      `;
      for (const r of rows) if (!TERMINAL_STATUSES.has(r.status)) openGapItems.add(r.feature_id);
    }
    // A real holder for the agent.goal "subject with a value" square. Without one, that
    // square is NOT OBSERVED and is reported as such — never fabricated.
    const holders = await sql<Array<{ taken_by: string }>>`
      SELECT taken_by FROM harness_shared.work_items
      WHERE taken_by IS NOT NULL AND status NOT IN ('done','dropped','resolved','closed','passed','deprecated')
      ORDER BY updated_ts DESC LIMIT 1
    `;
    liveHolder = holders[0]?.taken_by ?? null;
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (liveHolder) SUBJECTS.ownerId.withValue = liveHolder;

  const byPort = new Map<string, CellObservation[]>();
  const notObserved: string[] = [];

  for (const port of ports) {
    const obs: CellObservation[] = [];
    for (const spec of BUILTIN_CELLS) {
      const rel = spec.callerRelativity;
      const param = rel.kind === 'parameter' ? rel.param : null;

      if (param === null) {
        // A global/ambient cell has exactly one square: read it and judge the answer.
        obs.push(observe(spec.cell, 'subject-with-value', port, spec, await stateRead(port, { cell: spec.cell })));
        continue;
      }

      const subj = SUBJECTS[param];
      if (!subj) {
        notObserved.push(`${spec.cell}: no probe subject defined for parameter "${param}"`);
        continue;
      }

      // (a) a subject known to have a value
      if (subj.withValue === null) {
        notObserved.push(
          `${spec.cell}/subject-with-value: no live subject could be resolved for "${param}" — square NOT observed`,
        );
      } else {
        obs.push(
          observe(spec.cell, 'subject-with-value', port, spec, await stateRead(port, { cell: spec.cell, as: subj.withValue })),
        );
      }

      // (b) a subject whose headline must degrade
      obs.push(
        observe(spec.cell, 'subject-degrades', port, spec, await stateRead(port, { cell: spec.cell, as: subj.degrades })),
      );

      // (d) the subject withheld
      obs.push(observe(spec.cell, 'subject-missing', port, spec, await stateRead(port, { cell: spec.cell })));
    }

    // (c) the reachable half of the non-oracle pair.
    //
    // ⚠ NOT THE WHOLE OF P-019, and saying so is the point. Every built-in cell is
    // `visibility:{kind:'workspace'}` and this route runs as ONE fixed operator principal,
    // so there is no live reader for whom a built-in cell is out-of-audience — the
    // out-of-audience half is simply not reachable here, and pretending otherwise would
    // be a fabricated green. What IS reachable is that an unregistered cell answers
    // `absent`; the audience half is gated statically over BUILTIN_CELLS by P-006's
    // `cell-access-parity.test.ts`, which is where that assertion belongs.
    obs.push(
      observe(UNREGISTERED_PROBE, 'out-of-audience', port, undefined, await stateRead(port, { cell: UNREGISTERED_PROBE })),
    );

    byPort.set(port, obs);
  }

  /* ---------------------------------------------------------------------- */

  let failed = false;
  for (const [port, obs] of byPort) {
    const a = assessMatrix(obs, { openGapItems });
    console.log(`\n─── :${port} ───────────────────────────────────────────`);
    console.log(a.refusal ?? a.headline);
    for (const sq of a.squares) {
      if (sq.verdict === 'ok') continue;
      const tag = sq.knownGap ? `[${sq.knownGap}]` : '';
      console.log(`  ${sq.verdict.toUpperCase().padEnd(17)} ${sq.cell} / ${sq.condition} ${tag}`);
      console.log(`      ${sq.detail}`);
    }
    if (!a.ok) failed = true;
  }

  if (notObserved.length > 0) {
    console.log('\n─── NOT OBSERVED (stated, never counted as a pass) ───');
    for (const n of notObserved) console.log(`  • ${n}`);
  }

  if (byPort.size === 2) {
    const [left, right] = [...byPort.entries()];
    const div = compareAb(left[1], right[1]);
    console.log(`\n─── A/B  :${left[0]} vs :${right[0]} ───`);
    if (div.length === 0) {
      console.log(
        '  no divergence — the two operators answer every square identically. ⚠ This does NOT mean the ' +
          'matrix is healthy: a defect present in both agrees perfectly. It means the deploy boundary is ' +
          'not the explanation for anything above.',
      );
    } else {
      failed = true;
      for (const d of div) {
        console.log(`  DIVERGENT  ${d.cell} / ${d.condition}: :${left[0]}=${d.left} vs :${right[0]}=${d.right}`);
      }
    }
  }

  console.log('');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('check-cell-live-matrix failed:', e);
  process.exit(1);
});
