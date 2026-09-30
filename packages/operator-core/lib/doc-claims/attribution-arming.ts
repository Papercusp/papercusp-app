/**
 * DOC CLAIM — coverage attribution is armed on the paths that run the fleet's tests.
 * Plan: design-to-code-coverage-seam-2026-09-02 (P-006).
 *
 * WHY A PIN AND NOT JUST A COMMENT. `PAPERCUSP_TEST_ATTRIBUTION=1` is a single line in a child
 * env, which is exactly the shape of edit that gets dropped by an unrelated refactor of the
 * surrounding block. When it goes, nothing fails: the sink's first statement is a cached
 * boolean, so a disarmed run is byte-for-byte an ordinary green run and the only symptom is a
 * table that stays empty — indistinguishable from "no test exercises a seam". An instrument
 * whose failure mode is silence needs a guard, or it is a claim rather than a mechanism.
 *
 * WHY THIS COVERS ONLY THE `.mjs` PATH. The gate's own chokepoint, `buildGreenCheckpointEnv`,
 * is an exported pure function, so it is pinned BEHAVIOURALLY in green-checkpoint.test.ts —
 * asserting the env a fork actually receives, which is strictly better evidence than asserting
 * the source that builds it. `scripts/affected-tests.mjs` builds its child env inline inside a
 * large scheduling function with no exported seam, so source is the best available instrument
 * there. That asymmetry is deliberate and worth stating: prefer the behavioural pin wherever a
 * seam exists, and reach for text only where one does not.
 */

/** The one arming switch (mirrors `coverage-census/attribution/context.ts`'s ATTRIBUTION_ENV). */
export const ATTRIBUTION_ENV_NAME = 'PAPERCUSP_TEST_ATTRIBUTION';

/**
 * An assignment of the arming env to the literal '1', in either the object-literal form used in
 * a child-env map (`PAPERCUSP_TEST_ATTRIBUTION: "1"`) or the property form used on a mutable env
 * (`env.PAPERCUSP_TEST_ATTRIBUTION = "1"`). Quotes may be single or double.
 */
const ARMED_ASSIGNMENT = new RegExp(
  `(?:\\.)?${ATTRIBUTION_ENV_NAME}\\s*[:=]\\s*['"]1['"]`,
);

/**
 * Strip line comments so a MENTION of the switch inside prose is never mistaken for a wiring.
 * This file's own subject makes that failure mode concrete: every real arming site here sits
 * under a long explanatory comment that names the variable repeatedly, so a naive scan would
 * pass on a block whose actual assignment had been deleted.
 *
 * Deliberately line-oriented and deliberately NOT a JS parser: a block comment spanning an
 * assignment would defeat it, which is a trade this guard accepts (that shape does not occur in
 * either subject, and both are covered by a control below). Getting this wrong is safe in one
 * direction only — the guard can under-report an arming that IS present (a loud, fixable
 * failure), never over-report one that is absent.
 */
export function stripLineComments(source: string): string[] {
  return source.split('\n').map((line) => {
    const idx = line.indexOf('//');
    if (idx === -1) return line;
    // Keep the prefix; a `//` inside a string literal is not a case either subject contains,
    // and truncating there can only lose a match, never invent one.
    return line.slice(0, idx);
  });
}

export interface AttributionArmingInput {
  /** Contents of `scripts/affected-tests.mjs`. */
  affectedTestsSource: string;
}

export interface AttributionArmingVerdict {
  ok: boolean;
  /** 1-based line numbers carrying a real (non-commented) arming assignment. */
  affectedTestsArmedAt: number[];
  problems: string[];
}

export function judgeAttributionArming(
  input: AttributionArmingInput,
): AttributionArmingVerdict {
  const lines = stripLineComments(input.affectedTestsSource);
  const armedAt: number[] = [];
  lines.forEach((line, i) => {
    if (ARMED_ASSIGNMENT.test(line)) armedAt.push(i + 1);
  });

  const problems: string[] = [];
  if (armedAt.length === 0) {
    problems.push(
      `scripts/affected-tests.mjs no longer arms ${ATTRIBUTION_ENV_NAME}='1' in the child env ` +
        `it spawns tasks with. Every test the fleet runs through test:affected / test:related ` +
        `(including the green-checkpoint gate, whose greenCmd resolves to this runner) then ` +
        `contributes NO surface→test evidence — and does so silently, because a disarmed sink ` +
        `is indistinguishable from a suite that exercises no seam. Restore the assignment in ` +
        `the childEnv object, or, if this was deliberate, delete this claim and say why in ` +
        `plan deterministic-coverage-census-2026-08-17.`,
    );
  }

  return { ok: problems.length === 0, affectedTestsArmedAt: armedAt, problems };
}
