/**
 * Comment stripping for the wave gates (P-014, P-019).
 *
 * WHY THIS IS SHARED RATHER THAN COPIED. Both wave gates ask the same question of
 * the conformance kit — "does it branch on a platform name?" — and both need the
 * same exemption: naming a platform in PROSE is documentation, naming one in
 * EXECUTABLE CODE is special-casing. Only the second is a defect.
 *
 * A second copy of this function would be the more dangerous kind of duplication,
 * because a stripper that quietly stops stripping does not fail — it makes every
 * absence claim built on it pass. One implementation means one place to get right
 * and one CONTROL (in wave-a-gate.test.ts) measuring that it still removes prose
 * and still keeps code.
 *
 * Test-support only, hence `.fixture.ts`: it ships no production behaviour and is
 * imported exclusively by the gate suites.
 */

/**
 * Strip `//` and block comments while preserving string literals.
 *
 * Both naive forms are wrong in ways that matter here: cutting at every `//` eats
 * the back half of any URL inside a string literal, and cutting at every `/*`
 * eats a string that merely contains one. So this tracks quote state.
 *
 * Regex literals are deliberately not tracked. The kit contains none whose body
 * could be mistaken for a comment, and the CONTROL in wave-a-gate.test.ts
 * measures that this function still removes prose and still keeps code — so a
 * future regression here surfaces as a failing control rather than as a guard
 * that has silently stopped looking at anything.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (quote) {
      if (ch === '\\') {
        out += ch + (source[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      out += ' ';
      continue;
    }

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      out += ' ';
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}
