/**
 * `runRedQueenDrill` — the SHARED red-queen vaccination orchestration (flag →
 * governor → drill cycle), the single source of truth both the
 * `system:red-queen-drill` routine action AND the `red-queen:drill` deterministic
 * blueprint step run (deterministic-blueprints-migration-2026-06-13 P-122 / D-004
 * — provably behavior-neutral: one gated cycle, two callers).
 *
 * Behavior-neutral migration: the drill's origin=drill provenance, the SANDBOX
 * workspace isolation, the real-watchdog detection + known-remedy heal, and the
 * MTTSH + zero-leak assertions ALL live inside `runRedQueenTick` — wrapping it
 * preserves every one. The frontier P-001 arming gate (flag + governor budget) is
 * unchanged; dark stays dark. SQL-only, zero spend.
 *
 * A leaf module (imports sandbox + governor) — no import cycle.
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOrgPg } from '@papercusp/db-org';
import type { GovernorVerdict } from '../learning-governor/core';
import { redQueenGovernorGate } from './governor';
import { defaultDrillCycleDeps, runRedQueenTick, type DrillCycleDeps, type RedQueenTickResult } from './sandbox';

export interface RedQueenDrillDeps {
  /** Flag check (default: the live `papercusp-red-queen` getFlag). */
  flag?: (installSlug: string) => Promise<boolean>;
  /** Governor preflight gate (default: the live `redQueenGovernorGate`). */
  governorGate?: (workspaceId: string) => Promise<GovernorVerdict>;
  /** Drill cycle deps (default: live PG-backed `defaultDrillCycleDeps`). */
  cycleDeps?: DrillCycleDeps | null;
}

export interface RedQueenDrillOutcome {
  ran: boolean;
  skipReason?: 'flag-off' | 'governor-refused';
  governorReason?: string;
  result?: RedQueenTickResult;
}

export async function runRedQueenDrill(
  input: { workspaceId: string; installSlug: string; payload?: unknown },
  deps: RedQueenDrillDeps = {},
): Promise<RedQueenDrillOutcome> {
  const flag = deps.flag ?? ((slug: string) => getFlag(FLAGS.RED_QUEEN, `routine:${slug}`));
  if (!(await flag(input.installSlug))) return { ran: false, skipReason: 'flag-off' };

  const gate = deps.governorGate ?? redQueenGovernorGate;
  const verdict = await gate(input.workspaceId);
  if (!verdict.allow) return { ran: false, skipReason: 'governor-refused', governorReason: verdict.reason };

  const p = (input.payload ?? {}) as Record<string, unknown>;
  const classId = typeof p.classId === 'string' ? p.classId : undefined;
  const cycleDeps = deps.cycleDeps ?? defaultDrillCycleDeps(getOrgPg().sql, input.workspaceId);
  const result = await runRedQueenTick(cycleDeps, { classId });
  return { ran: true, result };
}
