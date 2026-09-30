/**
 * content-lint PROBE — ask a registered content detector "would you flag THIS
 * content?" for ARBITRARY content, including a path that is not in the tracked
 * tree (EI-19457795809466683).
 *
 * ## Why this exists
 *
 * Every registered detector already has a pure predicate, and every per-detector
 * `scripts/check-*.mjs` wrapper adds exactly one thing on top: TREE ENUMERATION.
 * That enumeration is also what makes them useless for the question you actually
 * have during an incident — they walk `git ls-files`, so handing one a path
 * outside the tracked tree is silently ignored, and there is no way at all to ask
 * about content you are holding in your hand (a stdin buffer, a line from a log,
 * a file you have not written yet).
 *
 * So the only way to answer "does this guard catch X" was to hand-roll a probe
 * that imports the detector module by absolute path. That question gets asked at
 * precisely the worst moment — right after a guard has FAILED to catch something
 * in production — i.e. under time pressure, on the fleet's commit path, where a
 * wrong answer is expensive in both directions. The originating item reports four
 * consecutive confident-wrong verdicts produced exactly that way.
 *
 * ## The two DECIDABLE layers — and the one that is not
 *
 * A detector answering "no" is not one answer, it is several, and they demand
 * different actions. Through the `ContentDetector` interface exactly two of them
 * are decidable, and this module reports those two SEPARATELY rather than
 * collapsing them into a single boolean (collapsing them is the whole bug):
 *
 *   1. `out-of-scope` — `matches(fileName)` is false. The detector will never
 *      look at this file at all. A "no" here says nothing whatsoever about the
 *      content, and the fix is usually to the detector's scope, not the file.
 *   2. `clean` / `flagged` — the detector actually RAN on the text.
 *
 * The third layer is NOT decidable from out here, and this module deliberately
 * does not pretend otherwise. Several detectors apply a private CONTENT gate
 * before scanning (`sql-comment-backtick` has `USES_SQL_TAG` / `HAS_RAW_DDL`,
 * both module-private consts), so a `clean` verdict can mean either "the content
 * is genuinely fine" or "the file never reached the scan". Nothing on the
 * `ContentDetector` interface exposes that distinction, so `clean` is reported
 * as what it provably is — "this detector did not flag this content" — and NEVER
 * as "this content is fine". That ambiguity is real and load-bearing: it is the
 * exact confusion behind WI-9253, where `sql-comment-backtick` returned "no" for
 * a file it was structurally blind to, and the honest answer is to name it rather
 * than to invent a certainty the interface cannot supply.
 *
 * ## The filename is an INPUT, not decoration
 *
 * `matches` is a function OF THE PATH, so probing without a realistic filename
 * silently answers about the wrong scope. That is why {@link probeContent}
 * requires `fileName` and the CLI requires an explicit `--as=<path>` for stdin
 * rather than defaulting one: a defaulted filename produces a confident answer to
 * a question you did not ask.
 *
 * ## A run that measured NOTHING must not report clean
 *
 * If no detector is in scope, every detector is `out-of-scope`, nothing ran, and
 * a plain "no hits" would be a false green of exactly the kind this repo keeps
 * getting burned by (`tsc -p .` checking zero files, `-t` matching zero tests,
 * `test:affected` selecting zero suites — each reported success having measured
 * nothing). {@link probeExitCode} returns MISUSE for that case, never CLEAN.
 */
import { DEFAULT_CONTENT_DETECTORS, type ContentDetector } from './registry';

/** What one detector concluded about the probed content. */
export type DetectorVerdict =
  /** `matches(fileName)` was false — the detector never inspected the text. */
  | { key: string; glob: string; status: 'out-of-scope' }
  /** The detector ran and did not flag. NOT proof the content is fine — see the
   *  module header: a private content gate may have excluded it before scanning. */
  | { key: string; glob: string; status: 'clean' }
  /** The detector ran and flagged, with its own human-readable message. */
  | { key: string; glob: string; status: 'flagged'; message: string }
  /** The detector threw. Reported rather than swallowed: a detector that cannot
   *  run is not a detector that found nothing. */
  | { key: string; glob: string; status: 'error'; message: string };

export interface ProbeResult {
  /** The path the detectors were asked about (the real path, or `--as`). */
  fileName: string;
  /** One verdict per detector considered, in registry order. */
  verdicts: DetectorVerdict[];
  /** Verdicts with status 'flagged' — the hits. */
  flagged: Extract<DetectorVerdict, { status: 'flagged' }>[];
  /** How many detectors actually RAN (in scope). Zero means nothing was measured. */
  ranCount: number;
  /** Detector keys requested via `only` that are not registered. */
  unknownKeys: string[];
}

/** Exit-code semantics, shared by the CLI and its tests so they cannot drift. */
export const PROBE_EXIT = {
  /** Every in-scope detector ran and none flagged. */
  CLEAN: 0,
  /** At least one detector flagged. */
  FLAGGED: 1,
  /** The run measured nothing, or was asked something impossible. */
  MISUSE: 2,
} as const;

/**
 * Run registered content detectors against arbitrary content.
 *
 * Pure apart from the detectors themselves: no filesystem access, no tree
 * enumeration, no process exit. The CLI shim (`scripts/content-lint.mjs`) adds
 * argument parsing and IO; everything decidable lives here so it is unit-testable
 * without spawning a process — the same D-003 split the per-detector scripts use.
 */
export async function probeContent(opts: {
  fileName: string;
  text: string;
  /** Defaults to the full registry. */
  detectors?: ContentDetector[];
  /** Restrict to these detector keys. Unknown keys are reported, not ignored. */
  only?: string[] | null;
}): Promise<ProbeResult> {
  const { fileName, text } = opts;
  const registry = opts.detectors ?? DEFAULT_CONTENT_DETECTORS;
  const only = opts.only && opts.only.length > 0 ? opts.only : null;

  const known = new Set(registry.map((d) => d.key));
  const unknownKeys = only ? only.filter((k) => !known.has(k)) : [];
  const selected = only ? registry.filter((d) => only.includes(d.key)) : registry;

  const verdicts: DetectorVerdict[] = [];
  for (const detector of selected) {
    const base = { key: detector.key, glob: detector.glob };
    let inScope: boolean;
    try {
      inScope = await detector.matches(fileName);
    } catch (err) {
      verdicts.push({ ...base, status: 'error', message: `scope predicate threw: ${errText(err)}` });
      continue;
    }
    if (!inScope) {
      verdicts.push({ ...base, status: 'out-of-scope' });
      continue;
    }
    try {
      const message = await detector.detect(fileName, text);
      verdicts.push(message ? { ...base, status: 'flagged', message } : { ...base, status: 'clean' });
    } catch (err) {
      verdicts.push({ ...base, status: 'error', message: `detector threw: ${errText(err)}` });
    }
  }

  return {
    fileName,
    verdicts,
    flagged: verdicts.filter(
      (v): v is Extract<DetectorVerdict, { status: 'flagged' }> => v.status === 'flagged',
    ),
    ranCount: verdicts.filter((v) => v.status !== 'out-of-scope').length,
    unknownKeys,
  };
}

/**
 * The exit code for a probe result.
 *
 * MISUSE (not CLEAN) when an unknown detector key was requested, or when NOTHING
 * ran — a run that measured nothing must never be reportable as a pass. See the
 * module header for why that rule is load-bearing here.
 */
export function probeExitCode(result: ProbeResult): number {
  if (result.unknownKeys.length > 0) return PROBE_EXIT.MISUSE;
  if (result.ranCount === 0) return PROBE_EXIT.MISUSE;
  if (result.verdicts.some((v) => v.status === 'error')) return PROBE_EXIT.MISUSE;
  return result.flagged.length > 0 ? PROBE_EXIT.FLAGGED : PROBE_EXIT.CLEAN;
}

/** Human-readable report. The CLI prints this; kept here so tests can assert it. */
export function formatProbeResult(result: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`content-lint probe: ${result.fileName}`);

  for (const v of result.verdicts) {
    if (v.status === 'flagged') lines.push(`  ✗ ${v.key}  FLAGGED — ${v.message}`);
    else if (v.status === 'error') lines.push(`  ! ${v.key}  ERROR — ${v.message}`);
    else if (v.status === 'clean') lines.push(`  ✓ ${v.key}  did not flag`);
    else lines.push(`  · ${v.key}  out of scope (${v.glob})`);
  }

  if (result.unknownKeys.length > 0) {
    lines.push('');
    lines.push(`  ! unknown detector key(s): ${result.unknownKeys.join(', ')}`);
  }

  if (result.ranCount === 0) {
    lines.push('');
    lines.push(
      '  ⚠ NOTHING RAN — every detector considered is out of scope for this filename, so this ' +
        'run measured NOTHING. This is NOT a clean result. The filename is a real input to every ' +
        "detector's scope predicate: check the path you passed (or `--as=<path>` for stdin).",
    );
  } else if (result.flagged.length === 0) {
    lines.push('');
    lines.push(
      `  ${result.ranCount} detector(s) ran and none flagged. Note "did not flag" is not proof the ` +
        'content is fine: some detectors apply a private content gate before scanning, so a file ' +
        'they are structurally blind to also reports as not-flagged (this is the WI-9253 confusion).',
    );
  }

  return lines.join('\n');
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
