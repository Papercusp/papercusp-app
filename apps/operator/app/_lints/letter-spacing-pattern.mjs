// apps/operator/app/_lints/letter-spacing-pattern.mjs
//
// THE ONE DEFINITION of the banned-letter-spacing pattern that `lint:design-primitives`
// enforces, extracted so an edit-time hook can reuse it instead of forking the regex
// (EI-20023819609804890).
//
// WHY THIS FILE EXISTS
//   `lint:design-primitives` is a green-checkpoint leg, so a banned `letter-spacing`
//   bites ONLY at the fleet gate — hours later, on whichever unrelated agent is waiting
//   on a deploy, never on the author who typed it. hud.css alone has now red-pinned the
//   fleet THREE times on this single rule (2026-08-02, and twice on 2026-08-09).
//
//   The remedy tried so far was PROSE: that file carries FOUR separate comments warning
//   about this rule (L564, L782, L885, and the one added with the third fix at L1372).
//   It broke anyway, which is the finding — a comment can only reach someone who happens
//   to read that region of a 1,445-line stylesheet, and the author adding a NEW uppercase
//   micro-label is by definition writing somewhere else in it. A fourth comment would
//   have been the fourth instance of a remedy already measured to fail.
//
// WHY A SHARED MODULE RATHER THAN A REGEX IN THE HOOK
//   Mirrors the explicit rule in posttooluse-mock-cast-escape-nudge.mjs: re-implementing
//   a guard's matcher forks it and drifts. This regex is subtle in a way that invites
//   exactly that — the negative lookahead is what distinguishes the BANNED `0.04em` from
//   the REQUIRED `letter-spacing: 0`, and a hand-rewrite that drops it would fire on
//   every compliant declaration in the tree.
//
// ⚠ COMMENT STRIPPING IS LOAD-BEARING, NOT HYGIENE.
//   hud.css:564 contains the literal text `letter-spacing:0.09em` INSIDE a comment
//   explaining why it was removed. Match raw text and the warning comments themselves
//   become offenders — the tool would fire hardest on the best-documented file, which is
//   the same detector inversion this repo has now measured several times. The lint avoids
//   this via its own `stripComments`; this module stops CSS block comments the same way.
//
//   The strip here is deliberately BROADER than the lint's (which only opens a block
//   comment at line start): it removes `/* … */` anywhere. For an ADVISORY nudge, over-
//   stripping is the safe direction — it can only cost a missed nudge, never a false
//   accusation, and the gate remains the authority either way.

/**
 * A FRESH regex each call — never a shared instance.
 *
 * `/g` regexes are STATEFUL (`lastIndex` advances on a match), and this exact class of
 * bug is called out in design-primitives.test.ts: a single shared `/g` pattern reused
 * across files "silently misses that file's offence" roughly every other time. Handing
 * out a new object makes that unreachable by construction rather than by discipline.
 */
export function nonzeroLetterSpacingRe() {
  return /\b(?:letter-spacing|letterSpacing)\s*:\s*(?:['"])?(?!0(?:\s*(?:[;,'"}]|!important)|\s*$))[0-9.]+(?:em|px|rem)?(?:['"])?/gm;
}

/** Blank out `/* … *\/` spans, preserving newlines so line numbers stay truthful. */
export function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Every banned declaration in `rawText`, as `{ line, snippet }`.
 *
 * Takes RAW file text and strips internally, so a caller cannot forget the step that
 * makes the result meaningful.
 */
export function findNonzeroLetterSpacing(rawText) {
  const code = stripCssComments(rawText);
  const found = [];
  for (const match of code.matchAll(nonzeroLetterSpacingRe())) {
    found.push({
      line: code.slice(0, match.index).split('\n').length,
      snippet: match[0].trim(),
    });
  }
  return found;
}
