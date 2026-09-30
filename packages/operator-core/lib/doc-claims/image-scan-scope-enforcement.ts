/**
 * Keep `gcp-image-family.ts`'s SCOPE prose honest about whether policy actually READS the
 * scope-attribution fields.
 *
 * The pair this guards drifted once already and cost real planning time. The scope fields on
 * `GcpImageScanEvidence` were introduced as carry-only, and their doc comment said so:
 * "EVIDENCE ONLY — no policy reads them yet, deliberately." Later `GCP_IMAGE_SCAN_POLICY`
 * became `providerImageScanPolicy('papercusp-bundled')`, which makes `evaluateImageScanPolicy`
 * read exactly those fields — and the comment stayed. A reader trusting it concludes the GCP
 * gate still measures the whole mounted image, where linux-kernel alone carries 1054 findings
 * at or above high, and therefore that no bundle-side remediation can ever green the gate.
 * That is the opposite of the truth, and it is the expensive direction to be wrong in: it
 * argues for not doing work that would in fact succeed.
 *
 * This is the "derive, pin, or attest" ladder's PIN rung. The comment cannot be derived from
 * the policy (it is prose about intent), so instead the two are checked against each other:
 * a scoped policy and stale carry-only wording cannot both be present.
 */

/**
 * The phrasings that assert the fields are inert. Any of them contradicts a scoped policy.
 *
 * "EVIDENCE ONLY" needs a LOOKBEHIND, not a lookahead: the retraction that makes it acceptable
 * ("NO LONGER EVIDENCE ONLY") sits BEFORE the phrase, so a lookahead scanning the rest of the
 * sentence reads the correction as if it were the claim and fires on the fixed text.
 */
const CARRY_ONLY_PHRASES: readonly RegExp[] = [
  /no policy reads (?:them|these)/i,
  /(?<!\bno longer\s)evidence only\b/i,
  /\bnot read by (?:any )?policy\b/i,
];

/** The scope-attribution fields a `papercusp-bundled` verdict is computed from. */
export const SCOPE_ATTRIBUTION_FIELDS: readonly string[] = [
  'vulnerabilityByScope',
  'vulnerabilityCriticalHighByScope',
  'secretsByScope',
  'bundleCatalogedArtifacts',
];

export interface ImageScanScopeVerdict {
  ok: boolean;
  /** Stale carry-only assertions found in the prose while the policy is scoped. */
  staleAssertions: readonly string[];
  /** Scope-attribution fields the prose never names, so a reader cannot check the claim. */
  unnamedFields: readonly string[];
  violations: readonly string[];
}

/**
 * Judge one documentation body against the evaluated scope the policy actually declares.
 *
 * `evaluatedScope` is passed in rather than imported so the fixture controls can exercise both
 * sides of the coupling — the point of the guard is the RELATION between the two, and a judge
 * that could only ever see the live value could not be shown to fail.
 */
export function judgeImageScanScopeDocs(
  doc: string,
  evaluatedScope: string,
): ImageScanScopeVerdict {
  const violations: string[] = [];

  // An unscoped policy imposes nothing: carry-only wording is then simply accurate.
  if (evaluatedScope !== 'papercusp-bundled') {
    return { ok: true, staleAssertions: [], unnamedFields: [], violations };
  }

  const staleAssertions = CARRY_ONLY_PHRASES.filter((pattern) => pattern.test(doc)).map(
    (pattern) => pattern.source,
  );
  for (const assertion of staleAssertions) {
    violations.push(
      `policy evaluates the 'papercusp-bundled' scope, but the prose still asserts the scope ` +
        `fields are carry-only (matched /${assertion}/). The gate reads them; say so.`,
    );
  }

  const unnamedFields = SCOPE_ATTRIBUTION_FIELDS.filter((field) => !doc.includes(field));
  for (const field of unnamedFields) {
    violations.push(
      `a scoped verdict is denied outright when ${field} is absent from the scan, so the prose ` +
        `must name it — a reader cannot verify a requirement it never mentions.`,
    );
  }

  return {
    ok: violations.length === 0,
    staleAssertions,
    unnamedFields,
    violations,
  };
}
