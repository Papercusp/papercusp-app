/**
 * Long-op narration policy — what to say, when, and for how long.
 *
 * Per /docs/agents/operator-persona §6: narration uses a side-channel
 * legacy TTS call (NOT the EL Conv AI agent), so the templates are
 * deterministic and independent of any LLM in the loop. This file
 * defines the kinds, expected durations, mid-cadence, and the literal
 * strings the narration playback engine sends to TTS.
 *
 * Pure data + pure functions. No side effects.
 */

export type OpKind = 'replan' | 'supervisor' | 'cleanup' | 'provision' | 'smokeTest' | 'scan' | 'delegate';

export type NarrationMode = 'default' | 'sober';

export interface OpPolicy {
  kind: OpKind;
  /** Expected duration range in milliseconds, used only for tuning + mid-cadence math. */
  expectedMin: number;
  expectedMax: number;
  /** Mid-update cadence (ms between updates after the first). 0 = no mid updates. */
  midCadenceMs: number;
  /** Earliest time after start to fire the first mid update (ms). */
  midFirstAt: number;
  /** Maximum number of mid updates before falling silent. */
  midMaxFires: number;
  /** Whether kickoff fires audio (false → silent kickoff). */
  speakKickoff: boolean;
  /** Whether completion fires audio. */
  speakCompletion: boolean;
}

export const OP_POLICIES: Record<OpKind, OpPolicy> = {
  replan: {
    kind: 'replan',
    expectedMin: 30_000, expectedMax: 120_000,
    midCadenceMs: 0, midFirstAt: 30_000, midMaxFires: 1,
    speakKickoff: true, speakCompletion: true,
  },
  supervisor: {
    kind: 'supervisor',
    expectedMin: 10_000, expectedMax: 45_000,
    midCadenceMs: 0, midFirstAt: 30_000, midMaxFires: 1,
    speakKickoff: true, speakCompletion: true,
  },
  cleanup: {
    kind: 'cleanup',
    expectedMin: 15_000, expectedMax: 60_000,
    midCadenceMs: 0, midFirstAt: 30_000, midMaxFires: 1,
    speakKickoff: true, speakCompletion: true,
  },
  provision: {
    kind: 'provision',
    expectedMin: 60_000, expectedMax: 600_000,
    // Provision can be very long — emit periodic updates capped at 4.
    midCadenceMs: 60_000, midFirstAt: 60_000, midMaxFires: 4,
    speakKickoff: true, speakCompletion: true,
  },
  smokeTest: {
    kind: 'smokeTest',
    expectedMin: 5_000, expectedMax: 30_000,
    midCadenceMs: 0, midFirstAt: 0, midMaxFires: 0,
    speakKickoff: false, speakCompletion: true,
  },
  scan: {
    kind: 'scan',
    expectedMin: 3_000, expectedMax: 15_000,
    midCadenceMs: 0, midFirstAt: 0, midMaxFires: 0,
    // Scan completion is silent unless suggestions surfaced — that's
    // handled by the caller (HarnessDashboard's existing scan plumbing
    // only narrates when there's something to say).
    speakKickoff: false, speakCompletion: false,
  },
  delegate: {
    kind: 'delegate',
    expectedMin: 5_000, expectedMax: 60_000,
    // Periodic "still researching" while the delegate is mid-run. Fires
    // first at 30s, then every 30s, capped at 3 — keeps the user
    // tethered to the conversation without becoming chatty. Voice
    // already says "looking into that" before delegating, so kickoff
    // stays silent.
    midCadenceMs: 30_000, midFirstAt: 30_000, midMaxFires: 3,
    speakKickoff: false, speakCompletion: true,
  },
};

export interface KickoffCtx { slug?: string }

export function kickoffText(kind: OpKind, ctx: KickoffCtx = {}): string | null {
  const p = OP_POLICIES[kind];
  if (!p.speakKickoff) return null;
  switch (kind) {
    case 'replan':     return ctx.slug ? `Replanning ${ctx.slug}.` : 'Replanning.';
    case 'supervisor': return 'Running supervisor.';
    case 'cleanup':    return 'Cleaning up.';
    case 'provision':  return ctx.slug ? `Provisioning ${ctx.slug}.` : 'Provisioning.';
    default:           return null;
  }
}

export function midText(kind: OpKind, fireIndex: number): string | null {
  switch (kind) {
    case 'replan':     return 'Still scoping.';
    case 'supervisor': return 'Still reviewing.';
    case 'cleanup':    return 'Still pruning.';
    case 'provision':  return fireIndex === 0 ? 'Still working.' : 'Still going.';
    case 'delegate':   return fireIndex === 0 ? 'Still researching.' : fireIndex === 1 ? 'Still on it.' : 'Still working through it.';
    default:           return null;
  }
}

export interface CompletionCtx {
  slug?: string;
  outcome: 'ok' | 'fail';
  reason?: string;
  counts?: Record<string, number>;
}

export function completionText(kind: OpKind, ctx: CompletionCtx): { text: string; mode: NarrationMode } | null {
  const p = OP_POLICIES[kind];
  if (!p.speakCompletion) return null;

  if (ctx.outcome === 'fail') {
    const tail = ctx.reason ? `: ${ctx.reason}.` : '.';
    switch (kind) {
      case 'replan':     return { text: `Replan failed${tail}`, mode: 'sober' };
      case 'supervisor': return { text: `Supervisor failed${tail}`, mode: 'sober' };
      case 'cleanup':    return { text: `Cleanup failed${tail}`, mode: 'sober' };
      case 'provision':  return { text: `Provisioning failed${tail}`, mode: 'sober' };
      case 'smokeTest':  return { text: `Smoke test failed${tail}`, mode: 'sober' };
      case 'delegate':   return { text: `Delegate failed${tail}`, mode: 'sober' };
      default:           return null;
    }
  }

  // Success — try to include concrete counts, fall back to plain "done".
  const fmtCounts = (counts?: Record<string, number>) => {
    if (!counts) return null;
    const entries = Object.entries(counts).filter(([, v]) => v > 0);
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${v} ${k}`).join(', ');
  };

  switch (kind) {
    case 'replan': {
      const c = fmtCounts(ctx.counts);
      return { text: c ? `Replan done — ${c}.` : 'Replan done.', mode: 'default' };
    }
    case 'supervisor': {
      const o = ctx.reason ?? 'ok';
      return { text: `Supervisor: ${o}.`, mode: 'default' };
    }
    case 'cleanup': {
      const c = fmtCounts(ctx.counts);
      return { text: c ? `Cleanup done — ${c}.` : 'Cleanup done.', mode: 'default' };
    }
    case 'provision':
      return { text: 'Provisioning complete.', mode: 'default' };
    case 'smokeTest':
      return { text: 'Smoke test passed.', mode: 'default' };
    case 'delegate':
      // Short cue — full delegate text is rendering in the operator panel.
      return { text: 'Delegate finished — details in the panel.', mode: 'default' };
    default:
      return null;
  }
}

/**
 * Compute the wall-clock times when mid-updates should fire from a
 * given start. Only the first `midMaxFires` are returned. Helper for
 * tests; the runtime scheduler uses the policy fields directly.
 */
export function midSchedule(kind: OpKind, startedAt: number): number[] {
  const p = OP_POLICIES[kind];
  if (!p.midMaxFires) return [];
  const out: number[] = [];
  let t = startedAt + p.midFirstAt;
  for (let i = 0; i < p.midMaxFires; i++) {
    out.push(t);
    if (!p.midCadenceMs) break;
    t += p.midCadenceMs;
  }
  return out;
}
