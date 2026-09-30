/**
 * CLAUDE.md's log-triage recipes must anchor each house machine-line marker on the
 * field only a REAL emitter writes — never the bare marker (WI-37636; sibling of
 * `gate-candidate-ref.ts` / `retired-surfaces.ts`, same P-004 family).
 *
 * WHY this needs a guard rather than prose. vitest echoes TEST NAMES into the very
 * log these recipes grep, and `green-checkpoint.test.ts:4919` is named
 * "...in the house GATE_HELD_BY / AFFECTED_TESTS_RESULT shape" — so both markers
 * appear as impostors whenever that suite is selected, i.e. exactly when the gate is
 * judging the release path and someone is triaging. Measured 2026-08-10 on
 * `…-cand-a68d051e8fd8.log`: the bare form returned that test name, ALL 6 matches
 * were impostors, and ZERO real machine lines existed — on a legitimately GREEN run,
 * where the absence IS the signal. The failure therefore reads as an answer.
 *
 * The fix landed as corrected prose in CLAUDE.md, which nothing enforced; this judge
 * is what keeps it from silently regressing on the next edit.
 *
 * SCOPING: only lines inside a fenced code block are judged. CLAUDE.md necessarily
 * QUOTES the bad form in prose to warn about it (the warning beside these very
 * recipes contains a literal bare `grep -o 'GATE_HELD_BY.*'`), so judging prose would
 * fire on the documentation of the bug itself. Fenced blocks are where recipes a
 * reader COPIES actually live.
 */

/**
 * THE RULE IS THE PROPERTY, NOT THE SPELLING: a real emitted line always continues
 * `MARKER <key>=…`; a test name never does (`GATE_HELD_BY / AFFECTED_TESTS_RESULT
 * shape`). So the judge requires *some* `key=` field, not one specific key.
 *
 * That distinction is load-bearing and was learned the expensive way IN THIS FILE.
 * The first version pinned one required field per marker, derived from the lines I had
 * happened to observe — and it was WRONG for `TEST_FILE_RESULT`, which really emits
 * `TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed`. A rule demanding
 * `TEST_FILE_RESULT status=` therefore (a) flags a correct recipe and (b) sends an
 * agent to grep a string no real log contains. The emitters also legitimately vary
 * their first field (`GATE_HELD_BY count=` and `entries=`; `AFFECTED_TESTS_RESULT
 * status=` and `failed=`), so any one-key rule is form-blind by construction.
 *
 * CANONICAL_ANCHOR below is therefore only a SUGGESTION used in the violation message.
 * It is never what the judge enforces.
 */
export const CANONICAL_ANCHOR: Readonly<Record<string, string>> = Object.freeze({
  GATE_HELD_BY: 'count=',
  GATE_PROMOTION: 'candidate=',
  AFFECTED_TESTS_RESULT: 'status=',
  AFFECTED_TESTS_FAILING_FILES: 'run=',
  // EI-19416573016968871. The SELECTION counterpart to the break set. Its whole purpose is
  // to make "X is absent from this run" decidable, so a recipe that greps it unanchored —
  // matching the vitest test names that echo the marker — would hand back an impostor match
  // for precisely the question the line exists to answer.
  AFFECTED_TESTS_SELECTED_FILES: 'run=',
  // WI-38300. Emitted only when absorption's residue is load-correlated, so its ABSENCE is
  // the common case — which is exactly the shape that makes a bare grep dangerous here: a
  // run with no load-suspect residue matches only the vitest test names that echo the
  // marker, and that impostor match reads as a positive finding.
  AFFECTED_TESTS_LOAD_SUSPECT: 'tasks=',
  TEST_FILE_RESULT: 'requested=',
});

/** A real machine line continues with a `key=` field; prose and test names do not. */
const ANCHOR_FIELD = '[A-Za-z][A-Za-z0-9_]*=';

export interface UnanchoredSite {
  readonly line: number;
  readonly marker: string;
  readonly suggestedAnchor: string;
  readonly text: string;
}

export interface MachineLineGrepVerdict {
  readonly ok: boolean;
  readonly checkedLines: number;
  readonly unanchoredSites: readonly UnanchoredSite[];
  readonly violations: readonly string[];
}

/** A doc too short to contain the recipes is a FAILED READ, never a clean bill. */
const MIN_PLAUSIBLE_CHARS = 2000;

/**
 * `AFFECTED_TESTS_FAILING_FILES` contains no other marker as a substring, and no two
 * markers here are prefixes of one another — but sort longest-first anyway so a future
 * marker cannot be shadowed by a shorter sibling.
 */
const MARKERS = Object.keys(CANONICAL_ANCHOR).sort((a, b) => b.length - a.length);

export function judgeMachineLineGrepAnchors(markdown: string): MachineLineGrepVerdict {
  if (markdown.trim().length < MIN_PLAUSIBLE_CHARS) {
    throw new Error(
      `Refusing to judge machine-line grep anchors: read only ${markdown.trim().length} char(s), ` +
        `expected >= ${MIN_PLAUSIBLE_CHARS}. A failed/short read must not be reported as clean.`,
    );
  }

  const lines = markdown.split('\n');
  const unanchoredSites: UnanchoredSite[] = [];
  let inFence = false;
  let checkedLines = 0;

  lines.forEach((text, index) => {
    if (text.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    // Prose deliberately quotes the bad form to warn about it — see SCOPING above.
    if (!inFence || !text.includes('grep')) return;

    checkedLines += 1;
    for (const marker of MARKERS) {
      if (!text.includes(marker)) continue;
      // Every occurrence must be anchored; one anchored use does not excuse a bare one.
      const anchored = new RegExp(`${marker}\\s+${ANCHOR_FIELD}`, 'g');
      const occurrences = text.split(marker).length - 1;
      const anchoredCount = (text.match(anchored) ?? []).length;
      if (anchoredCount < occurrences) {
        unanchoredSites.push({
          line: index + 1,
          marker,
          suggestedAnchor: CANONICAL_ANCHOR[marker]!,
          text: text.trim(),
        });
      }
    }
  });

  const violations = unanchoredSites.map(
    (s) =>
      `CLAUDE.md:${s.line} greps the bare marker \`${s.marker}\` — follow it with the ` +
      `key=value field a real emitted line carries, e.g. \`${s.marker} ${s.suggestedAnchor}\` ` +
      `(any \`key=\` satisfies the rule; the emitters vary their first field). ` +
      `A bare grep also matches vitest TEST NAMES echoed into the same log (WI-37636), ` +
      `so it returns plausible prose where the honest answer is no match. Line: ${s.text}`,
  );

  return { ok: violations.length === 0, checkedLines, unanchoredSites, violations };
}
