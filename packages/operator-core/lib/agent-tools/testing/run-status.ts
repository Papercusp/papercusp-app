/**
 * testing:run-status — poll a detached recovery started by testing:run.
 *
 * A foreground testing:run timeout starts an independent store-backed run and
 * returns its id. This read surface exposes the same bounded snapshot that the
 * admin testing route can read, so the timeout response points to a callable
 * agent tool rather than an operator-only HTTP route or an undefined "poll".
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  getRunAsync,
  getTestRunLedgerRecoveryAsync,
  TestingRunSnapshotUnavailableError,
  type DetachedRunLedgerRecovery,
  type RunSnapshot,
} from '../../testing-run-store';

export type TestingRunStatusResult =
  | { ok: true; snapshot: RunSnapshot }
  | { ok: true; ledgerRecovery: DetachedRunLedgerRecovery }
  | { ok: false; error: 'unknown_run'; runId: string; message: string }
  | { ok: false; error: 'snapshot_unavailable'; runId: string; retryable: true; message: string };

const argsSchema = z.object({
  runId: z
    .string()
    .min(1)
    .max(120)
    .describe('Detached run id returned by testing:run after a foreground timeout.'),
});

export default defineTool({
  name: 'testing:run-status',
  // @not-a-cell live state, but a SINGLE DOOR keyed by an ephemeral run id: getRunAsync()
  // is the one local-first/durable snapshot oracle and the admin route consumes that same
  // function rather than re-deriving it. A scalar registry cell would require one entry per
  // detached run and add a read door without removing one.
  description:
    'Read detached testing:run recovery with testing:run-status { runId }. Returns the lifecycle snapshot when available; if it is missing or unreadable, terminal per-file test_runs rows for the exact run_group_id can return a ledgerRecovery verdict. An absent/expired id returns unknown_run, and an unreadable snapshot without a terminal ledger verdict returns retryable snapshot_unavailable.',
  guidance: {
    when: 'Poll the detachedRunId returned by testing:run after a foreground timeout until its snapshot reaches a terminal status.',
    notWhen:
      'Start a test run (use testing:run), read persisted test history (use testing:runs), or poll a capability:bash job (use capability:bash_output). unknown_run means neither a snapshot nor a terminal ledger verdict was found; snapshot_unavailable means the lifecycle store and terminal ledger verdict were unavailable and is retryable. Neither is evidence that the test passed.',
    chaining: 'testing:run → timeout with detachedRunId → testing:run-status { runId } until status is pass, fail, cancelled, or error.',
    seeAlso: ['testing:run (start an exact-file run)', 'testing:runs (read persisted test-run history)'],
  },
  capability: 'operator:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: argsSchema,
  async handler(args): Promise<{ data: TestingRunStatusResult }> {
    let snapshot: RunSnapshot | null;
    let snapshotUnavailable = false;
    try {
      snapshot = await getRunAsync(args.runId);
    } catch (error) {
      if (!(error instanceof TestingRunSnapshotUnavailableError)) throw error;
      snapshot = null;
      snapshotUnavailable = true;
    }
    if (snapshot) return { data: { ok: true, snapshot } };

    const ledgerRecovery = await getTestRunLedgerRecoveryAsync(args.runId);
    if (ledgerRecovery) return { data: { ok: true, ledgerRecovery } };

    if (snapshotUnavailable) {
      return {
        data: {
          ok: false,
          error: 'snapshot_unavailable',
          runId: args.runId,
          retryable: true,
          message:
            'The detached lifecycle snapshot and a terminal per-file test_runs verdict were unavailable. Retry testing:run-status; this does not mean the run is absent or that the test passed.',
        },
      };
    }
    return {
      data: {
        ok: false,
        error: 'unknown_run',
        runId: args.runId,
        message:
          'No detached test-run snapshot or terminal per-file ledger verdict is available for this runId; it may be unknown or evicted after the one-hour retention window. This is not evidence that the test passed.',
      },
    };
  },
});
