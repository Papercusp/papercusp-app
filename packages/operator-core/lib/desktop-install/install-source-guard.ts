/**
 * Source-tree guard for `installPapercuspFiles()` (WI-37405).
 *
 * ## The defect this closes
 *
 * `installPapercuspFiles()` resolves the SOURCE it copies from out of the calling
 * process's own tree, then writes a SINGLE SHARED dest (`~/.papercusp/**`). Any
 * process that boots an operator from a scratch checkout therefore installs THAT
 * tree's hooks machine-wide, for every agent on the box.
 *
 * Measured 2026-08-09 (EI-19956921121874213): 19 of the installed agent hooks in
 * `~/.papercusp/hooks/cc` were 8-day-old copies from `~/papercupai-workspace/.gym-probe/`
 * (git rev 674d76ef1e, 2026-08-01) — including `pretooluse-locks-acquire.sh`,
 * `posttooluse-locks-release.sh`, `pretooluse-secrets-guard.mjs`,
 * `pretooluse-nul-byte-edit-guard.mjs` and `ask-gate-mirror.sh`. The file-locking,
 * secrets and NUL-byte rails the whole fleet relies on were running eight-day-old code.
 *
 * ## Why this is NOT the cwd bug (EI-19445483716744925), and why that matters
 *
 * `resolveOperatorAppRoot()` now walks the module layout and returns the real
 * `apps/operator` root for source, dist-host, and packaged sidecar trees. Before
 * EI-19445483716744925, its fixed two-hop walk landed on `packages/operator-core`
 * in the current source tree, so every lookup fell through to the
 * `process.cwd()`-rooted candidates. That was a real bug and is filed separately.
 *
 * It is TEMPTING to conclude it is the root cause here and that fixing it — making
 * resolution module-relative instead of cwd-relative — closes this hole. **It does not.**
 * Measured 2026-08-09: all three `.gym-probe/{work,repro,substrate}` trees are FULL
 * checkouts carrying their own `packages/operator-core` AND their own
 * `apps/operator/scripts/hooks/cc`. So an operator booted from inside one of them
 * resolves module-relative straight back into the sandbox, and the clobber is identical.
 * Module-relative resolution removes the dependence on where a process was STARTED; it
 * does nothing about which TREE it was started from. Only this guard addresses that.
 *
 * ## Fail-safe posture — read before widening anything here
 *
 * This code runs on EVERY operator boot. A guard that wrongly refuses the canonical
 * root stops all hook installs fleet-wide, which is strictly worse than the bug it
 * prevents. Two properties keep that from happening, and both must survive any edit:
 *
 *  1. The markers are NARROW and matched as path SEGMENTS, never as substrings of the
 *     whole path. A canonical checkout cannot accidentally match one.
 *  2. Refusal never invents a source. It removes poisoned candidates and lets the
 *     caller fall through to the next legitimate one — or, if nothing legitimate
 *     remains, install NOTHING and say so loudly. Installing nothing leaves whatever
 *     is already on disk intact; that is always safer than overwriting it with
 *     sandbox content.
 *
 * The test suite pins both directions: every negative case has a POSITIVE control
 * asserting that real canonical paths still pass.
 */

import * as path from 'node:path';

/**
 * A scratch/sandbox marker, matched against resolved path SEGMENTS.
 *
 * ⚠ Substring matching against the whole path is deliberately NOT used: a home
 * directory or repo name that happened to contain a marker would silently disable
 * installs for that user. Each entry below states the segment shape it matches.
 */
export type ScratchMarker =
  | '.gym-probe'
  | '-simtmp-'
  | '.papercusp/worktrees'
  | 'tmp-root';

export type SourceClassification =
  | { scratch: true; marker: ScratchMarker; segment: string }
  | { scratch: false };

/** Temp roots a shared install must never source from. */
const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp'];

/**
 * Classify a source path as canonical or scratch.
 *
 * Pure and total — no fs access, so it is safe to call on paths that do not exist
 * and cheap enough to run over every candidate on every boot.
 */
export function classifySourcePath(candidate: string): SourceClassification {
  const resolved = path.resolve(candidate);
  const segments = resolved.split(path.sep).filter(Boolean);

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];

    // A gym/probe sandbox tree. Segment-exact: `.gym-probe`.
    if (seg === '.gym-probe') return { scratch: true, marker: '.gym-probe', segment: seg };

    // Transient simulation/checkpoint trees, e.g. `papercusp-checkpoint-simtmp-a1b2`.
    // Substring WITHIN one segment (never across the whole path) — the token is
    // distinctive enough that a real directory name will not carry it by accident.
    if (seg.includes('-simtmp-')) return { scratch: true, marker: '-simtmp-', segment: seg };

    // Agent isolation worktrees: `.papercusp/worktrees/<slug>`. These are legitimate
    // places to EDIT (migration/synthesis roles are assigned them on purpose) and
    // illegitimate places to INSTALL machine-wide from — which is exactly this guard.
    if (seg === 'worktrees' && segments[i - 1] === '.papercusp') {
      return { scratch: true, marker: '.papercusp/worktrees', segment: `${segments[i - 1]}/${seg}` };
    }
  }

  // Temp roots. Anchored at the ROOT of the path so a directory merely named `tmp`
  // deeper in a canonical checkout (e.g. `<repo>/packages/x/tmp`) does not match.
  for (const root of TMP_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return { scratch: true, marker: 'tmp-root', segment: root };
    }
  }

  return { scratch: false };
}

export type SourceFilterOptions = {
  /**
   * The install DESTINATION root (normally the user's home). When the dest is ITSELF
   * inside a scratch tree, scratch sources are ALLOWED: an isolated gym run that has
   * correctly redirected HOME into its own sandbox is installing into itself and
   * harms nobody. The invariant this guard actually enforces is narrower than
   * "never install from scratch" — it is **a scratch source may not write a
   * canonical, shared destination**.
   */
  dest?: string;
  /**
   * Escape hatch for a deliberate scratch→shared install. Off by default; when set,
   * candidates are passed through and the refusals are still reported for logging.
   */
  allowScratch?: boolean;
};

export type SourceFilterResult = {
  /** Candidates safe to install from, in the caller's original preference order. */
  accepted: string[];
  /** Candidates removed, each with the marker that disqualified it. */
  refused: Array<{ candidate: string; marker: ScratchMarker; segment: string }>;
  /** True when the dest is itself scratch, so scratch sources were allowed through. */
  destIsScratch: boolean;
};

/**
 * Remove scratch-tree candidates from a source-resolution candidate list.
 *
 * Order-preserving, so a caller's existing most-specific-first preference is intact.
 * Returns the refusals rather than logging them itself — the caller owns the message,
 * and a silent refusal would reproduce the invisible-failure shape this whole guard
 * exists to end.
 */
export function filterInstallSources(
  candidates: readonly string[],
  opts: SourceFilterOptions = {},
): SourceFilterResult {
  const destIsScratch = opts.dest ? classifySourcePath(opts.dest).scratch : false;
  const passthrough = destIsScratch || opts.allowScratch === true;

  const accepted: string[] = [];
  const refused: SourceFilterResult['refused'] = [];

  for (const candidate of candidates) {
    const verdict = classifySourcePath(candidate);
    if (!verdict.scratch) {
      accepted.push(candidate);
      continue;
    }
    refused.push({ candidate, marker: verdict.marker, segment: verdict.segment });
    if (passthrough) accepted.push(candidate);
  }

  return { accepted, refused, destIsScratch };
}

/** Human-readable refusal line for the operator log. */
export function describeRefusals(what: string, result: SourceFilterResult): string | null {
  if (result.refused.length === 0) return null;
  const detail = result.refused.map((r) => `${r.candidate} [${r.marker}]`).join(', ');
  if (result.destIsScratch) {
    return `[desktop-install] ${what}: dest is itself a scratch tree — ALLOWING scratch source(s): ${detail}`;
  }
  return `[desktop-install] ${what}: REFUSED scratch source(s), will not install these into a shared destination: ${detail}`;
}
