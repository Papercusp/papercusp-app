/**
 * format-cli — pure-logic formatting for the substrate-status CLI.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24.
 *
 * Extracted from scripts/substrate-status.mjs so the verdict / exit
 * code mapping has unit-test coverage. The CLI script wraps this with
 * fetch + process.exit; the logic itself is pure.
 *
 * Exit codes (used by CI / monitoring scripts):
 *   0  substrate off, idle (no harnesses booted), OR every booted harness healthy
 *   1  any booted harness degraded / unhealthy / booting
 *   2  reserved for the script wrapper to use on fetch failure
 */

import type { SubstrateHealthVerdict } from './health';
import type { WorkspaceSubstrateSummary } from './summary';

export interface FormatCliInput {
  enabled: boolean;
  bootedCount: number;
  harnesses?: ReadonlyArray<{
    workspaceId: string;
    harnessSlug: string;
    verdict: SubstrateHealthVerdict;
    reasons?: ReadonlyArray<string>;
  }>;
  summary?: WorkspaceSubstrateSummary | null;
}

export interface FormatCliOutput {
  lines: string[];
  exitCode: 0 | 1;
}

const BAD_VERDICTS: ReadonlyArray<SubstrateHealthVerdict> = [
  'booting',
  'degraded',
  'unhealthy',
];

function verdictMark(v: SubstrateHealthVerdict): string {
  switch (v) {
    case 'healthy':
      return '✓';
    case 'disabled':
      return '·';
    case 'booting':
      return '⏳';
    case 'degraded':
      return '!';
    case 'unhealthy':
      return '✗';
  }
}

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

function summarySegments(s: WorkspaceSubstrateSummary): string {
  const segs: string[] = [];
  if (s.healthy) segs.push(`${s.healthy}✓`);
  if (s.booting) segs.push(`${s.booting}⏳`);
  if (s.degraded) segs.push(`${s.degraded}!`);
  if (s.unhealthy) segs.push(`${s.unhealthy}✗`);
  if (s.disabled) segs.push(`${s.disabled}·`);
  return segs.length > 0 ? segs.join(' ') : '—';
}

/**
 * Pure formatter — returns lines (caller prints) + exit code (caller
 * uses).
 *
 * Behavior matches the CLI:
 *   - Substrate off → header + hint, exit 0.
 *   - On + no booted → header + idle hint, exit 0 (idle ground state —
 *     no harness has been shared; not an alarm).
 *   - On + booted → header + summary + table, exit 1 iff any
 *     row's verdict is in BAD_VERDICTS.
 */
export function formatSubstrateStatus(
  input: FormatCliInput,
): FormatCliOutput {
  const lines: string[] = [];
  const hcount = `${input.bootedCount} harness${
    input.bootedCount === 1 ? '' : 'es'
  }`;
  lines.push(
    `Substrate: ${input.enabled ? '✓ ON' : '· off'}   booted: ${hcount}`,
  );

  if (!input.enabled) {
    // The substrate always boots (Stage 4d removed the opt-in gate); this
    // branch only renders when a caller explicitly forces the disabled view.
    lines.push('  → substrate reported disabled.');
    return { lines, exitCode: 0 };
  }
  if (input.bootedCount === 0) {
    // Always-on substrate: zero booted harnesses is the idle ground state
    // (no harness has been shared), not an alarm — so exit 0, not 1. A real
    // boot failure surfaces as a per-harness 'unhealthy'/'booting' row or a
    // boot-history boot_fail event, not as "nothing booted".
    lines.push('  → substrate on; no shared harnesses booted (idle).');
    return { lines, exitCode: 0 };
  }

  if (input.summary) {
    lines.push(
      `Workspace summary: ${input.summary.worstVerdict}   ${summarySegments(input.summary)}`,
    );
  }

  lines.push('');
  lines.push(`  ${pad('workspace', 24)} ${pad('harness', 24)} verdict`);

  const harnesses = input.harnesses ?? [];
  let anyBad = false;
  for (const h of harnesses) {
    if ((BAD_VERDICTS as ReadonlyArray<string>).includes(h.verdict)) {
      anyBad = true;
    }
    lines.push(
      `  ${pad(h.workspaceId, 24)} ${pad(h.harnessSlug, 24)} ${verdictMark(h.verdict)} ${h.verdict}`,
    );
    if (h.reasons && h.reasons.length > 0 && h.verdict !== 'healthy') {
      for (const r of h.reasons) {
        lines.push(`      · ${r}`);
      }
    }
  }
  return { lines, exitCode: anyBad ? 1 : 0 };
}
