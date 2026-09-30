/**
 * Trace distillation (P-029, ③b / D-017).
 *
 * A full multi-hour multi-agent transcript doesn't fit the judge's context even at
 * 1M tokens, so distillation selects + budgets a run into a judge-sized input. The
 * diff is primary (the judge must see the produced code); per-role transcripts are
 * truncated; the assembled text respects a hard char budget. Deterministic — the
 * distillation is itself a noise source (validated at P-014), so it must be stable.
 *
 * v1 is selection/budgeting only (no LLM summarization); an optional LLM-summarize
 * pass for pathologically long transcripts is a later refinement.
 */

export interface RawTrace {
  /** `git diff <base-commit> HEAD` of the produced work. */
  diff: string;
  /** Per-role final outputs (the decision/summary each role emitted). */
  roleTranscripts: Array<{ role: string; runId: string; text: string }>;
  /** The run's terminal state (observability). */
  terminalState: string;
  /** Deterministic signals summary, if available. */
  signals?: Record<string, unknown>;
}

export interface DistillConfig {
  /** Hard ceiling on the distilled text length. */
  maxChars: number;
  /** Cap on the diff section (default: half the budget). */
  maxDiffChars?: number;
  /** Cap on each role transcript (default: a per-role slice of the budget). */
  maxTranscriptCharsPerRole?: number;
}

export interface DistilledTrace {
  text: string;
  /** True if any section or the whole was elided. */
  truncated: boolean;
}

const MARKER = '\n[…truncated…]';

function cap(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text.length > 0 };
  if (text.length <= max) return { text, truncated: false };
  if (max <= MARKER.length) return { text: text.slice(0, max), truncated: true };
  return { text: text.slice(0, max - MARKER.length) + MARKER, truncated: true };
}

export function distillTrace(raw: RawTrace, config: DistillConfig): DistilledTrace {
  const maxDiff = config.maxDiffChars ?? Math.floor(config.maxChars / 2);
  const perRole =
    config.maxTranscriptCharsPerRole ??
    Math.max(200, Math.floor(config.maxChars / Math.max(1, raw.roleTranscripts.length) / 2));

  let truncated = false;

  const diffCap = cap(raw.diff, maxDiff);
  truncated ||= diffCap.truncated;

  const transcriptSections = raw.roleTranscripts.map((t) => {
    const c = cap(t.text, perRole);
    truncated ||= c.truncated;
    return `### ${t.role} (${t.runId})\n${c.text}`;
  });

  const sections: string[] = [
    `## Terminal state\n${raw.terminalState}`,
    ...(raw.signals ? [`## Deterministic signals\n${JSON.stringify(raw.signals)}`] : []),
    `## Diff\n${diffCap.text}`,
    `## Role transcripts\n${transcriptSections.join('\n\n')}`,
  ];

  const assembled = sections.join('\n\n');
  const finalCap = cap(assembled, config.maxChars);
  truncated ||= finalCap.truncated;

  return { text: finalCap.text, truncated };
}
