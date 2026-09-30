/**
 * composition-oracles.ts — the pure invariant evaluation for the hermetic
 * 2-swarm composition rig (shared-hive-loop-e2e-testing-2026-06-10, the plan's
 * "Oracles" section). Mirrors the gym's `evaluateWakeOracles` shape: the rig
 * collects evidence (PG rows, claim stores, side-effect ledgers), this module
 * judges it — pure, deterministic, directly unit-testable.
 *
 * The five oracle families, verbatim from the plan:
 *  - Exactly-once dispatch — each work item executes on exactly one swarm, or
 *    duplicates are detected and deterministically reconciled to one winner.
 *  - Convergence — all swarms' PGs reach the same fixpoint; no echo loops.
 *  - Steering monotonicity — the Mug's decision at wake N+1 reflects work
 *    completed by remote cups during cycle N.
 *  - Lease safety — a steal never yields two live executors; stolen-run side
 *    effects are not duplicated (or are reconciled with one winner adopted).
 *  - Liveness — a non-empty backlog drains; every item reaches the terminal
 *    state through the autonomous chain.
 */

/** One backlog row as read from a cell's PG (the federated view). */
export interface BacklogRow {
  feature_id: string;
  status: string | null;
  taken_by: string | null;
  feature_order: number | null;
  item_kind: string | null;
  origin: string;
}

/** One row of a cell's side-effect ledger — the EXTERNAL action a pipeline
 *  performed (the stand-in for git commits / spawns, which do NOT federate). */
export interface SideEffectRow {
  work_item_id: string;
  executed_by: string;
  executed_at_ms: number;
}

export interface CompositionEvidence {
  /** The seeded backlog ids every oracle ranges over. */
  backlogIds: string[];
  /** Terminal status expected for a completed item (the rig uses 'passed'). */
  terminalStatus: string;
  /** Each cell's full backlog view at settle (cell name → rows). */
  featuresByCell: Record<string, BacklogRow[]>;
  /** Each cell's side-effect ledger at settle. */
  sideEffectsByCell: Record<string, SideEffectRow[]>;
  /** Did repeated merge+drain reach (and hold) a fixed point? */
  fixedPoint: boolean;
  /**
   * Steering monotonicity probe: the backlog view the Mug's NEXT turn read
   * on the steering cell (turn N+1), plus which items the REMOTE cell
   * completed during cycle N. Omit to skip the oracle (chaos tests that never
   * run a second turn).
   */
  steering?: {
    nextTurnView: BacklogRow[];
    remoteCompletedIds: string[];
  };
  /**
   * Items where a cross-cell duplicate execution was EXPECTED and reconciled
   * (lease-steal / partition tests). For these, exactly-once relaxes to
   * "duplicates detected + exactly one winner adopted". Each entry names the
   * item and the adopted winner cell.
   */
  reconciledDuplicates?: Array<{ workItemId: string; winnerCell: string }>;
}

export interface OracleVerdict {
  pass: boolean;
  failures: string[];
}

/** Group every cell's side effects by work item → the set of executing cells. */
export function executionsByItem(
  sideEffectsByCell: Record<string, SideEffectRow[]>,
): Map<string, Set<string>> {
  const byItem = new Map<string, Set<string>>();
  for (const [cell, rows] of Object.entries(sideEffectsByCell)) {
    for (const r of rows) {
      let s = byItem.get(r.work_item_id);
      if (!s) byItem.set(r.work_item_id, (s = new Set()));
      s.add(cell);
    }
  }
  return byItem;
}

export function evaluateCompositionOracles(ev: CompositionEvidence): OracleVerdict {
  const failures: string[] = [];
  const cells = Object.keys(ev.featuresByCell);
  const reconciled = new Map((ev.reconciledDuplicates ?? []).map((r) => [r.workItemId, r.winnerCell]));

  // ── Exactly-once dispatch ──────────────────────────────────────────────────
  const executions = executionsByItem(ev.sideEffectsByCell);
  for (const id of ev.backlogIds) {
    const ranOn = executions.get(id) ?? new Set<string>();
    if (reconciled.has(id)) {
      // A declared duplicate: it MUST have actually duplicated (else the test
      // didn't exercise what it claims) and the winner must be one executor.
      if (ranOn.size < 2)
        failures.push(`exactly-once: ${id} declared reconciled-duplicate but ran on ${ranOn.size} cell(s)`);
      if (!ranOn.has(reconciled.get(id)!))
        failures.push(`exactly-once: ${id} reconciled winner ${reconciled.get(id)} never executed it`);
    } else if (ranOn.size !== 1) {
      failures.push(
        `exactly-once: ${id} executed on ${ranOn.size} cell(s) [${[...ranOn].join(', ')}] — expected exactly 1`,
      );
    }
  }

  // ── Convergence: every cell's PG shows the SAME backlog fixpoint ───────────
  if (!ev.fixedPoint) failures.push('convergence: merge+drain never reached a stable fixed point (echo loop?)');
  const canon = (rows: BacklogRow[]) =>
    [...rows]
      .sort((x, y) => (x.feature_id < y.feature_id ? -1 : 1))
      .map((r) => `${r.feature_id}|${r.status}|${r.taken_by ?? ''}|${r.feature_order ?? ''}`)
      .join('\n');
  const views = cells.map((c) => ({ c, v: canon(ev.featuresByCell[c]) }));
  for (let i = 1; i < views.length; i++) {
    if (views[i].v !== views[0].v) {
      failures.push(
        `convergence: cell ${views[i].c} backlog view diverges from ${views[0].c}:\n` +
          `--- ${views[0].c} ---\n${views[0].v}\n--- ${views[i].c} ---\n${views[i].v}`,
      );
    }
  }

  // ── Liveness: every backlog item reached the terminal status everywhere ────
  for (const c of cells) {
    const byId = new Map(ev.featuresByCell[c].map((r) => [r.feature_id, r]));
    for (const id of ev.backlogIds) {
      const row = byId.get(id);
      if (!row) failures.push(`liveness: ${id} missing from cell ${c}'s PG`);
      else if (row.status !== ev.terminalStatus)
        failures.push(`liveness: ${id} on cell ${c} ended '${row.status}', expected '${ev.terminalStatus}'`);
    }
  }

  // ── Steering monotonicity: the next Mug turn SEES remote completions ─────
  if (ev.steering) {
    const view = new Map(ev.steering.nextTurnView.map((r) => [r.feature_id, r]));
    for (const id of ev.steering.remoteCompletedIds) {
      const row = view.get(id);
      if (!row) failures.push(`steering: Mug's next turn is blind to remotely-completed ${id} (row missing)`);
      else if (row.status !== ev.terminalStatus)
        failures.push(
          `steering: Mug's next turn sees ${id} as '${row.status}', not '${ev.terminalStatus}' — ` +
            'remote completion did not reach the steering swarm before its next wake',
        );
    }
  }

  return { pass: failures.length === 0, failures };
}
