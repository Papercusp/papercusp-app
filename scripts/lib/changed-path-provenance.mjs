// Where `affected-tests.mjs` got its blast radius from, reported at the top of every run.
//
// EI-20812741760514969. `scripts/affected-tests.mjs` with no `--changed-paths` derives the
// changed-path set from git: committed (`<base>...HEAD`) + working tree + untracked +
// dirty submodules. On a single-developer checkout that is exactly right. On the shared
// fleet checkout it is not — the tree carries the WHOLE fleet's work, and `origin/main`
// (the default base) only fast-forwards on a green checkpoint, so it routinely sits
// hundreds of commits behind HEAD. Measured on this box 2026-08-18: 2,272 committed paths
// against a base 1,532 commits behind, versus 1 uncommitted and 1 untracked. An agent
// verifying a three-file edit got 71 workspaces / 89 tasks.
//
// The failure is silent and it inverts the one this repo already documents. CLAUDE.md warns
// about UNDER-selection ("'green' can mean 'nothing ran'") and prescribes `--print-affected`
// as the probe — but the probe takes `--changed-paths` while the documented RUN
// (`npm run test:affected`) does not, so an agent measures one radius and then runs a far
// larger one. Nothing reported the mismatch; the only symptom was "this is slower than the
// estimate", which reads as slowness, not as wrong scope.
//
// This module is REPORT-ONLY on purpose. The broad derivation is CORRECT for the
// green-checkpoint gate, whose job is to certify the whole candidate — so the fix is to
// disclose the provenance, never to silently narrow what the gate runs.
//
// Split out as a module (rather than inlined into the 3,700-line runner) so the wording and
// the leg arithmetic are unit-testable hermetically, with no repo history, no clean tree and
// no multi-minute run — the same reason `--changed-paths` itself exists.

/** Emit the marker on stdout for every run; parsers filter by this prefix. */
export const DERIVATION_MARKER = "AFFECTED_DERIVATION";

/**
 * Changed-path count at or above which an unscoped git-derived radius gets the loud banner.
 * A handful of paths on a clean checkout is the normal single-developer case and needs no
 * warning; a set this size on a shared tree is never one agent's edit.
 */
export const SHARED_TREE_PATH_WARN = 25;

/**
 * @typedef {Object} ChangedPathLegs
 * @property {number} [committed] paths from `git diff <base>...HEAD`
 * @property {number} [uncommitted] paths from `git diff HEAD` (working tree)
 * @property {number} [untracked] paths from `git ls-files --others --exclude-standard`
 * @property {number} [submoduleDirty] submodule roots reported dirty
 */

/**
 * @typedef {Object} DerivationSummary
 * @property {string} source one of explicit | git-status | range | all | git-fallback-all
 * @property {boolean} scoped true when the caller named the paths (`--changed-paths`)
 * @property {number} total deduped changed-path count (0 when the source implies no path set)
 * @property {ChangedPathLegs} legs per-leg counts, empty unless source is git-status
 * @property {string|null} base the git ref the committed leg was diffed against
 * @property {number|null} baseCommitsBehind how far `base` trails HEAD, when measurable
 * @property {string|null} range the `from..to` the range probe used
 */

/**
 * Normalize what the runner observed into the shape both renderers read.
 *
 * Every field is optional at the call site because the runner legitimately knows different
 * things on different paths (`--all` shells no git at all; a git failure that degrades to
 * every workspace has no legs to report). Missing is rendered as missing rather than as
 * zero — a fabricated `0` here would read as a measurement.
 *
 * @param {Object} input
 * @param {string} input.source
 * @param {number} [input.total]
 * @param {ChangedPathLegs} [input.legs]
 * @param {string|null} [input.base]
 * @param {number|null} [input.baseCommitsBehind]
 * @param {string|null} [input.range]
 * @returns {DerivationSummary}
 */
export function summarizeDerivation({
  source,
  total,
  legs,
  base,
  baseCommitsBehind,
  range,
} = {}) {
  const src = String(source || "unknown");
  const cleanLegs = {};
  for (const [k, v] of Object.entries(legs || {})) {
    if (Number.isFinite(v)) cleanLegs[k] = Number(v);
  }
  return {
    source: src,
    scoped: src === "explicit",
    total: Number.isFinite(total) ? Number(total) : 0,
    legs: cleanLegs,
    base: base ?? null,
    baseCommitsBehind: Number.isFinite(baseCommitsBehind)
      ? Number(baseCommitsBehind)
      : null,
    range: range ?? null,
  };
}

/**
 * The one machine-readable line, emitted on every run and every `--print-affected` probe.
 *
 * Deliberately a single `key=value` line with a stable prefix: the existing consumers of this
 * script's stdout (green-checkpoint's `AFFECTED_WS\t` scan) filter by prefix, so an extra line
 * is inert for them, and a triager reading a truncated log tail can grep ONE line to learn
 * what the run was scoped to.
 *
 * @param {DerivationSummary} summary
 * @param {{ workspaces?: number, guards?: number, tasks?: number }} [selection]
 * @returns {string}
 */
export function formatDerivationMarker(summary, selection = {}) {
  const parts = [
    DERIVATION_MARKER,
    `source=${summary.source}`,
    `changedPaths=${summary.total}`,
  ];
  for (const leg of ["committed", "uncommitted", "untracked", "submoduleDirty"]) {
    if (summary.legs[leg] != null) parts.push(`${leg}=${summary.legs[leg]}`);
  }
  if (summary.base) parts.push(`base=${summary.base}`);
  if (summary.baseCommitsBehind != null)
    parts.push(`baseBehind=${summary.baseCommitsBehind}`);
  if (summary.range) parts.push(`range=${summary.range}`);
  for (const [key, value] of [
    ["workspaces", selection.workspaces],
    ["guards", selection.guards],
    ["tasks", selection.tasks],
  ]) {
    if (Number.isFinite(value)) parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

/**
 * Which git leg contributed the most paths — the field that points at the right lever.
 *
 * It is what makes the banner actionable rather than merely alarming: a radius dominated by
 * `committed` means the BASE has drifted (nothing to do with anyone's dirty tree), while one
 * dominated by `uncommitted`/`untracked` really is the fleet's in-flight work. The filed
 * report assumed the second; the measurement was overwhelmingly the first.
 *
 * @param {DerivationSummary} summary
 * @returns {string|null}
 */
export function dominantLeg(summary) {
  let best = null;
  for (const [leg, count] of Object.entries(summary.legs)) {
    if (count <= 0) continue;
    if (!best || count > best[1]) best = [leg, count];
  }
  return best ? best[0] : null;
}

/**
 * Human-facing disclosure lines for an unscoped, git-derived radius. Empty array when the
 * caller scoped the run itself, when the source implies no derivation to disclose, or when
 * the set is small enough to be one person's edit.
 *
 * @param {DerivationSummary} summary
 * @param {{ workspaces?: number, tasks?: number, runCommand?: string }} [selection]
 * @returns {string[]}
 */
export function derivationBannerLines(summary, selection = {}) {
  if (summary.scoped) return [];
  if (summary.source !== "git-status") return [];
  if (summary.total < SHARED_TREE_PATH_WARN) return [];

  const legText =
    [
      summary.legs.committed != null
        ? `committed vs ${summary.base ?? "base"} ${summary.legs.committed}` +
          (summary.baseCommitsBehind != null
            ? ` (that base is ${summary.baseCommitsBehind} commit(s) behind HEAD)`
            : "")
        : null,
      summary.legs.uncommitted != null
        ? `uncommitted ${summary.legs.uncommitted}`
        : null,
      summary.legs.untracked != null
        ? `untracked ${summary.legs.untracked}`
        : null,
      summary.legs.submoduleDirty != null
        ? `submodule-dirty ${summary.legs.submoduleDirty}`
        : null,
    ]
      .filter(Boolean)
      .join(", ") || "leg breakdown unavailable";

  const runCommand = selection.runCommand || "npm run test:affected";
  const scope = [];
  if (Number.isFinite(selection.workspaces))
    scope.push(`${selection.workspaces} workspace(s)`);
  if (Number.isFinite(selection.tasks)) scope.push(`${selection.tasks} task(s)`);

  const lines = [
    "!!!!!! affected-tests: this run's blast radius was DERIVED FROM THE TREE, not from your edit.",
    `!!!!!! ${summary.total} changed path(s)${scope.length ? ` -> ${scope.join(", ")}` : ""} — ${legText}.`,
    "!!!!!! On a shared checkout that set is the WHOLE FLEET's work, so a failure below may belong to a peer.",
    `!!!!!! To verify YOUR OWN edit, scope it:  ${runCommand} -- --changed-paths <your,changed,files>`,
  ];
  const leg = dominantLeg(summary);
  if (leg === "committed") {
    lines.push(
      `!!!!!! Most of it is the COMMITTED leg, i.e. base drift — not anyone's dirty tree. ` +
        `Scoping (above) is still the fix; committing or reverting work is not.`,
    );
  }
  lines.push(
    "!!!!!! (This wide scope is CORRECT for the green-checkpoint gate, which certifies the whole candidate.)",
  );
  return lines;
}
