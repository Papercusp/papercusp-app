/**
 * P-010: the operator documentation for the ratified-design comparison contract
 * asserts code-describing facts — refusal codes, invalid reasons, reference
 * classes, flag names, per-class gate eligibility. Those are a second copy of a
 * truth the code owns, and CLAUDE.md's derived-truth ladder says such a copy
 * must be derived, pinned, or attested rather than hand-maintained.
 *
 * It cannot be DERIVED (rung 1): the page is explanatory prose whose value is
 * the judgement around the vocabulary, not the vocabulary itself. So this is
 * rung 2 — a build-time divergence check.
 *
 * The check runs BOTH directions on purpose, because the two failures are
 * different and only one of them is loud:
 *
 *   forward  — a constant exists in code but the doc never mentions it. That is
 *              an operator meeting an `invalid` reason the manual does not
 *              explain, at the exact moment they are already confused.
 *   backward — the doc names a constant the code no longer has. That is worse:
 *              it reads as authoritative, and the reader has no way to discover
 *              it is stale. A rename lands in code and leaves the prose behind.
 *
 * This module is pure so the test can feed it fixtures. Extracting the doc's
 * claims from the real page and the constants from the real modules is the
 * test's job.
 */

/** Kebab-case identifiers only: excludes file paths (`/`, `.`), camelCase, and `key: value` spans. */
const VOCAB_TOKEN = /^[a-z]+(?:-[a-z]+)+$/;

/**
 * Kebab tokens the page uses that are ordinary English compounds — they name no
 * value in any source file, so the derived `knownElsewhere` check below cannot
 * vouch for them.
 *
 * This list stays SHORT by construction: anything that is a real identifier
 * somewhere in the codebase is cleared by `knownElsewhere` instead of being
 * enumerated here. An allowlist that has to grow every time an author adds a
 * code span is hand-maintained metadata describing code — the precise failure
 * this whole module exists to prevent, one level up.
 */
export const NON_VOCABULARY_TOKENS: ReadonlySet<string> = new Set([
  'fail-open',
  'zero-diff',
  'byte-identical',
  'host-to-host',
  // A CSS generic font family, named because the render-host fingerprint
  // measures its advance width (D-023). It is a value in the platform, not a
  // constant in this subsystem, so there is nothing here for it to drift from.
  'sans-serif',
]);

export interface DesignEvidenceDocFacts {
  /** Inline-code tokens harvested from the documentation page. */
  readonly docTokens: readonly string[];
  /** Full text of the page, for substring claims that are not code spans. */
  readonly docText: string;
}

export interface DesignEvidenceCodeFacts {
  readonly refusalCodes: readonly string[];
  readonly invalidReasons: readonly string[];
  readonly referenceClasses: readonly string[];
  /**
   * Why the gate reports a required case unmet (`DesignGateFailureReason`).
   *
   * Pinned for the same reason as the vocabularies above and learned the same
   * way: D-022 added `wrong-surface`, whose whole point is that its remedy is
   * the OPPOSITE of the `no-evidence` one it would otherwise be mistaken for.
   * A refusal vocabulary the page does not carry is one an operator meets for
   * the first time in a refusal, which is the worst moment to meet it.
   */
  readonly gateFailureReasons: readonly string[];
  /**
   * Why a failing reference was NOT refused (`NotEnforceableReason`, D-023).
   *
   * A vocabulary an operator meets in a message telling them their work was
   * allowed through — the moment they are least likely to go looking for an
   * explanation, and most likely to read "could not enforce" as "passed". If
   * the page does not carry the reason, that misreading is the default.
   */
  readonly notEnforceableReasons: readonly string[];
  readonly flagNames: readonly string[];
  /** referenceClass -> 'gateable' | 'advisory-only' | 'absent', as policy.ts derives it today. */
  readonly eligibility: ReadonlyMap<string, string>;
  /** `retention-days:` value on the design-evidence artifact upload step. */
  readonly ciRetentionDays: number;
  /** npm script names the page tells operators to run. */
  readonly npmScripts: readonly string[];
  /**
   * Flag names `report-cli.ts` actually reads, harvested from its `argValue`
   * calls. P-010 owes documentation validated against implemented CLI behavior,
   * and an operator following a flag the CLI silently ignores gets a default
   * they did not ask for with no error to tell them so — the worst shape of
   * documentation drift, because the command appears to work.
   */
  readonly cliFlags: readonly string[];
  /**
   * Every token that appears verbatim in the sources this page describes.
   *
   * This is what keeps the backward check honest without a growing allowlist.
   * A kebab token in the doc is only STALE PROSE if it names nothing real: if
   * it still occurs in the CI workflow, package.json, or the design-compare
   * sources, it is a live value on some other axis (a workflow key, an output
   * directory, a default policy version) and saying otherwise would be a false
   * accusation that trains authors to ignore this test.
   *
   * Derived by the caller from the actual files — rung 1 of the truth ladder —
   * rather than curated, so it maintains itself as the code changes.
   */
  readonly knownElsewhere: ReadonlySet<string>;
}

export interface DocClaimVerdict {
  readonly ok: boolean;
  readonly violations: readonly string[];
  readonly missingFromDoc: readonly string[];
  readonly staleInDoc: readonly string[];
}

/**
 * Judge one documentation page against the code it describes.
 *
 * Returns every violation at once rather than the first. An author fixing a
 * renamed constant should learn about all four sites in one run — the same
 * reason the design gate itself reports every unmet case together.
 */
export function judgeDesignEvidenceDoc(
  doc: DesignEvidenceDocFacts,
  code: DesignEvidenceCodeFacts,
): DocClaimVerdict {
  const violations: string[] = [];
  const missingFromDoc: string[] = [];
  const staleInDoc: string[] = [];

  const tokens = new Set(doc.docTokens);

  // ── forward: every live constant must be documented ──────────────────────
  const vocabularies: readonly (readonly [string, readonly string[]])[] = [
    ['verb refusal code', code.refusalCodes],
    ['invalid reason', code.invalidReasons],
    ['reference class', code.referenceClasses],
    ['gate failure reason', code.gateFailureReasons],
    ['not-enforceable reason', code.notEnforceableReasons],
  ];

  for (const [label, values] of vocabularies) {
    for (const value of values) {
      if (!tokens.has(value)) {
        missingFromDoc.push(value);
        violations.push(
          `${label} '${value}' exists in code but is not documented — an operator who hits it ` +
            'has no explanation of what it means or what to do about it.',
        );
      }
    }
  }

  for (const flag of code.flagNames) {
    if (!doc.docText.includes(flag)) {
      missingFromDoc.push(flag);
      violations.push(
        `feature flag '${flag}' is not named in the doc, so the disable path cannot be followed from it.`,
      );
    }
  }

  // ── backward: the doc must not name a constant the code dropped ──────────
  const live = new Set<string>([
    ...code.refusalCodes,
    ...code.invalidReasons,
    ...code.referenceClasses,
    ...code.gateFailureReasons,
    ...code.notEnforceableReasons,
  ]);

  for (const token of tokens) {
    if (!VOCAB_TOKEN.test(token)) continue;
    if (token.startsWith('papercusp-')) continue; // flag names, checked above
    if (NON_VOCABULARY_TOKENS.has(token)) continue;
    if (live.has(token)) continue;
    // Names something real elsewhere in the sources — a different axis, not
    // stale prose. See `knownElsewhere` for why this is derived, not curated.
    if (code.knownElsewhere.has(token)) continue;
    staleInDoc.push(token);
    violations.push(
      `the doc names '${token}', which is not a current refusal code, invalid reason, ` +
        'reference class or gate failure reason. Either the constant was renamed and the prose ' +
        'was left behind, or ' +
        `it belongs on a different axis and should be added to NON_VOCABULARY_TOKENS with a reason.`,
    );
  }

  // ── per-class gate eligibility ───────────────────────────────────────────
  // The single fact an operator acts on most, and the one whose drift is
  // silent: a class quietly promoted or demoted changes what a green means.
  for (const [cls, eligibility] of code.eligibility) {
    if (eligibility === 'absent') continue;
    const claimsGateable = claimsEligibility(doc.docText, cls, 'gateable');
    const claimsAdvisory = claimsEligibility(doc.docText, cls, 'advisory-only');
    if (eligibility === 'gateable' && !claimsGateable) {
      violations.push(
        `policy derives '${cls}' as GATEABLE but the doc does not say so on its row — a reader ` +
          'will not know this class can fail their completion.',
      );
    }
    if (eligibility === 'advisory-only' && !claimsAdvisory) {
      violations.push(
        `policy derives '${cls}' as ADVISORY-ONLY but the doc does not say so on its row — a ` +
          'reader may believe a green from this class gates something. It does not.',
      );
    }
  }

  // ── CI retention + runnable scripts ──────────────────────────────────────
  if (!doc.docText.includes(`retention-days: ${code.ciRetentionDays}`)) {
    violations.push(
      `the doc does not state the live artifact retention (${code.ciRetentionDays} days); a ` +
        'reviewer planning when to fetch captures would be guessing.',
    );
  }

  for (const script of code.npmScripts) {
    if (!doc.docText.includes(script)) {
      violations.push(`npm script '${script}' exists but the doc never tells an operator to run it.`);
    }
  }

  // ── the CLI contract, both directions ────────────────────────────────────
  const documentedFlags = new Set(
    doc.docTokens
      .map((t) => /^--([a-z][a-z-]*)=?$/.exec(t)?.[1])
      .filter((f): f is string => f !== undefined),
  );

  for (const flag of code.cliFlags) {
    if (!documentedFlags.has(flag)) {
      violations.push(
        `report-cli reads '--${flag}=' but the doc does not document it — an operator cannot ` +
          'discover a flag that only exists in the source.',
      );
    }
  }

  for (const flag of documentedFlags) {
    if (!code.cliFlags.includes(flag)) {
      violations.push(
        `the doc documents '--${flag}=' but report-cli never reads it. The CLI would silently ` +
          'ignore it and apply a default, so the operator gets a run they did not ask for and ' +
          'no error saying so.',
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    missingFromDoc,
    staleInDoc,
  };
}

/**
 * Does the doc assert `eligibility` for `cls`?
 *
 * Scoped to the same LINE rather than the whole document, because the page
 * necessarily discusses both words in prose near each other. A table row is one
 * line, which is exactly the granularity the claim is made at.
 */
function claimsEligibility(docText: string, cls: string, eligibility: string): boolean {
  return docText
    .split('\n')
    .some((line) => line.includes(cls) && line.toLowerCase().includes(eligibility));
}

/**
 * Harvest inline-code spans from markdown/MDX.
 *
 * Fenced blocks are stripped first: a code sample legitimately contains
 * identifiers that are not documentation claims, and treating them as claims
 * would make the backward check fire on the example rather than on the prose.
 */
export function extractInlineCodeTokens(markdown: string): string[] {
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, '\n');
  const out: string[] = [];
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    out.push(match[1].trim());
  }
  return out;
}
