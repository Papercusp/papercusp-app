/**
 * su-render-baseline.ts — measurement + scoring helpers for the DETERMINISTIC su render
 * baseline (identities-v1-2026-08-30 P-018 / R12 / R17).
 *
 * WHY. Every Part B move of the identities plan (fleet postures → `fleet-posture` slot,
 * mode prose → per-axis identities, doc parts addressed by stack, PROMPT_ROLES through the
 * chain, …) is scored in BYTES PER SECTION against a fixed reference render, and the union
 * stack must later render BYTE-EQUIVALENT to that reference for fixed inputs. A live
 * `~/.papercusp/launch-context/session-*.md` cannot be that reference — it varies by
 * session (178,037 B on 2026-09-02, 135,172 B on 2026-09-03). So the reference is a render
 * of PINNED inputs (a frozen copy of the blueprint base + client overlay + project guide,
 * see `__fixtures__/su-render-baseline/`) through the live `renderSuPlaybook`, and this
 * module turns a rendered text into a per-`## `-section table that can be diffed.
 *
 * The helpers are pure (text in, table out) so the acceptance gate (P-035) can score a
 * fresh render — of the live base, or of a slot-assembled stack — against the recorded
 * `baseline.json` without going through vitest.
 */
import { createHash } from 'node:crypto';

export interface SuRenderSection {
  /** The `## ` heading line (trimmed); `(preamble)` for the text before the first H2. */
  heading: string;
  /** `base` = the heading line exists verbatim in the pinned base; `generated` otherwise
   *  (a spliced generator, the client overlay, or the shared-base-notes bundle). */
  origin: 'base' | 'generated';
  bytes: number;
  sha256: string;
}

export interface SuRenderMeasurement {
  totalBytes: number;
  sha256: string;
  sections: SuRenderSection[];
}

export interface SuRenderBaselineInput {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SuRenderBaseline {
  schemaVersion: 1;
  plan: string;
  item: string;
  generatedAt: string;
  /** The pinned inputs the tiers were rendered from — a fixture edit without a re-pin is
   *  caught by comparing these against the files on disk. */
  inputs: Record<'base' | 'overlay' | 'projectGuide', SuRenderBaselineInput>;
  /** Which `<!-- PAPERCUSP-SU:* -->` markers the pinned base carries (splice targets that
   *  actually fire) and which known markers it lacks (generated sections that are silently
   *  dropped by `spliceGeneratedSection`). */
  markers: { present: string[]; absent: string[] };
  tiers: Record<'full' | 'fleet', SuRenderMeasurement>;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const FENCE_RE = /^\s*(```|~~~)/;
const H2_RE = /^## /;

/**
 * Split a rendered playbook into `## ` sections (fence-aware — a `## ` inside a code block
 * is content, not a heading) and measure each. Duplicate headings are disambiguated with a
 * ` #2`, ` #3` … suffix so the table stays keyed by heading.
 */
export function measureSuRender(text: string, baseText: string): SuRenderMeasurement {
  const baseHeadings = new Set(
    baseText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => H2_RE.test(l)),
  );
  const chunks: Array<{ heading: string; lines: string[] }> = [{ heading: '(preamble)', lines: [] }];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence && H2_RE.test(line)) {
      chunks.push({ heading: line.trim(), lines: [line] });
      continue;
    }
    chunks[chunks.length - 1]!.lines.push(line);
  }
  const seen = new Map<string, number>();
  const sections: SuRenderSection[] = chunks
    .filter((c, i) => i > 0 || c.lines.some((l) => l.trim() !== ''))
    .map((c) => {
      const n = (seen.get(c.heading) ?? 0) + 1;
      seen.set(c.heading, n);
      const heading = n === 1 ? c.heading : `${c.heading} #${n}`;
      const body = c.lines.join('\n');
      return {
        heading,
        origin: c.heading === '(preamble)' || baseHeadings.has(c.heading) ? 'base' : 'generated',
        bytes: Buffer.byteLength(body, 'utf8'),
        sha256: sha256(body),
      } satisfies SuRenderSection;
    });
  return { totalBytes: Buffer.byteLength(text, 'utf8'), sha256: sha256(text), sections };
}

export interface SuRenderSectionDelta {
  heading: string;
  origin: SuRenderSection['origin'];
  baselineBytes: number | null;
  currentBytes: number | null;
  /** current − baseline (a missing side counts as 0). */
  delta: number;
  /** `same` = byte-identical; `changed` = present on both sides with a different hash;
   *  `added` / `removed` = present on one side only. */
  status: 'same' | 'changed' | 'added' | 'removed';
}

export interface SuRenderScore {
  byteEquivalent: boolean;
  totalDelta: number;
  baselineBytes: number;
  currentBytes: number;
  sections: SuRenderSectionDelta[];
}

/** Score a fresh measurement against a recorded one — the per-section byte delta table
 *  every Part B move is judged by (R12), and the byte-equivalence verdict R17 asserts. */
export function scoreAgainstBaseline(current: SuRenderMeasurement, baseline: SuRenderMeasurement): SuRenderScore {
  const cur = new Map(current.sections.map((s) => [s.heading, s]));
  const base = new Map(baseline.sections.map((s) => [s.heading, s]));
  const headings = [...new Set([...baseline.sections.map((s) => s.heading), ...current.sections.map((s) => s.heading)])];
  const sections: SuRenderSectionDelta[] = headings.map((heading) => {
    const b = base.get(heading) ?? null;
    const c = cur.get(heading) ?? null;
    const status: SuRenderSectionDelta['status'] =
      b && c ? (b.sha256 === c.sha256 ? 'same' : 'changed') : b ? 'removed' : 'added';
    return {
      heading,
      origin: (c ?? b)!.origin,
      baselineBytes: b?.bytes ?? null,
      currentBytes: c?.bytes ?? null,
      delta: (c?.bytes ?? 0) - (b?.bytes ?? 0),
      status,
    };
  });
  return {
    byteEquivalent: current.sha256 === baseline.sha256,
    totalDelta: current.totalBytes - baseline.totalBytes,
    baselineBytes: baseline.totalBytes,
    currentBytes: current.totalBytes,
    sections,
  };
}

/** Render a score as a markdown table — what a failing baseline assertion prints, and what
 *  an audit/acceptance write-up pastes. `onlyChanged` drops the `same` rows. */
export function formatScoreTable(score: SuRenderScore, opts: { onlyChanged?: boolean } = {}): string {
  const rows = score.sections.filter((s) => !opts.onlyChanged || s.status !== 'same');
  const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));
  const sign = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));
  const lines = [
    `| section | origin | baseline B | current B | Δ B | status |`,
    `|---|---|---:|---:|---:|---|`,
    ...rows.map(
      (s) => `| ${s.heading.replace(/\|/g, '\\|')} | ${s.origin} | ${fmt(s.baselineBytes)} | ${fmt(s.currentBytes)} | ${sign(s.delta)} | ${s.status} |`,
    ),
    `| **total** | | ${fmt(score.baselineBytes)} | ${fmt(score.currentBytes)} | ${sign(score.totalDelta)} | ${score.byteEquivalent ? 'byte-equivalent' : 'differs'} |`,
  ];
  return lines.join('\n');
}
