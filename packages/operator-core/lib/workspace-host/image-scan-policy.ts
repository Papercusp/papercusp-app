import { SEVERITY_RANK as ARTIFACT_TRUST_SEVERITY_RANK, type VulnerabilitySeverity } from './artifact-trust';
import {
  applySecretAllowances,
  WORKSPACE_HOST_SECRET_ALLOWANCES,
  type ImageScanSecretAllowance,
  type ImageScanSecretFinding,
} from './image-scan-secret-allowances';

/**
 * Policy evaluation for the workspace-host IMAGE scan, shared by every provider
 * release path (GCP, AWS, Azure).
 *
 * ## Why this module exists
 *
 * There are two different security controls in this subsystem, on two different
 * SUBJECTS, and they were being held to the same bar:
 *
 *  - The RELEASE BUNDLE — papercusp-authored content — is evaluated by
 *    `artifact-trust.ts` under an `ArtifactTrustPolicy`. Zero secrets and a
 *    severity-ranked vulnerability threshold are exactly right there, because we
 *    author every byte of it.
 *  - The VM IMAGE — that same bundle PLUS an entire Ubuntu userland — was gated by
 *    four hand-rolled copies of `vulnerabilityFindings !== 0 || secretFindings !== 0`.
 *
 * Demanding zero grype matches at ANY severity across a whole distribution is
 * unsatisfiable by construction: the first honest scan of a stock Ubuntu 24.04
 * workspace-host image measured 3922 vulnerability matches (EI-21770579023793724).
 *
 * The reason that went unnoticed for so long is the part worth remembering: the gate
 * had never once evaluated real numbers. The scanner installed gitleaks from a URL
 * that has never existed, so it always died before any evidence reached the gate.
 * **The only state in which that pipeline could publish an image was one in which its
 * own scanner was dead.** Every guard below is written to make that shape impossible
 * to reach again — each one fails CLOSED, and `severity-breakdown-mismatch` exists
 * specifically so that a missing or empty measurement can never read as a clean one.
 *
 * ## What this module does NOT do
 *
 * It does not loosen the secret bar. `maxSecretFindings: 0` is the established
 * policy and `publication-manifest.ts` hard-requires it. If an image scan reports
 * secret findings, this module fails — the open question there is the scan's SCOPE
 * (gitleaks currently reads the entire mounted userland, so its count says nothing
 * about papercusp-authored content), and scope is fixed in the scanner, not here.
 */
export const WORKSPACE_HOST_IMAGE_SCAN_POLICY_VERSION = 'workspace-host-image-scan-policy-v1';

export interface ImageScanPolicy {
  /** Findings at or above this severity are denied. Mirrors `ArtifactTrustPolicy`. */
  denyVulnerabilitiesAtOrAbove: Exclude<VulnerabilitySeverity, 'unknown'>;
  /** Maximum tolerated secret findings. */
  maxSecretFindings: number;
  /**
   * Per-finding written justifications for bundled secret findings. Empty (the default) means
   * every bundled finding counts against `maxSecretFindings`.
   *
   * This is NOT a second threshold. `maxSecretFindings` still applies, unchanged, to whatever
   * is left after justified findings are accounted for — so an unlisted finding denies exactly
   * as before. It exists because an image can legitimately ship an upstream vendor's public
   * client key or trip an entropy rule on minified code, and the only alternatives were moving
   * the bar (D-172/174/175 forbid it) or narrowing the scan (D-204 forbids it).
   *
   * Only ever consulted on a scoped verdict, and only behind the completeness proof below: an
   * allowlist applied to a partial finding list would silently excuse the findings it never saw.
   */
  secretAllowances?: readonly ImageScanSecretAllowance[];
  /**
   * Require the scanner to PROVE it covered the image before its findings are
   * believed: `mountedFilesystems >= 1` and a non-empty `candidateRootProof`.
   *
   * Deliberately REQUIRED rather than optional-defaulting-false. An optional flag is
   * exactly the shape that produced the defect this field closes — the coverage pair
   * was carried to this gate for a full day while nothing read it, because absence
   * read as acceptance. A required field forces every policy to STATE whether its
   * provider can prove coverage, so a new provider cannot inherit "no" by silence.
   *
   * Concrete provider release policies should set this TRUE once their scanner
   * emits the pair. The shared policy intentionally stays FALSE as the generic
   * compatibility baseline for callers that do not have provider-specific
   * coverage evidence.
   */
  requireCoverageProof: boolean;
  /**
   * WHICH POPULATION the thresholds above judge.
   *
   * `'all'` — every finding on the image, base userland included. The original
   * behaviour, and the honest default for a provider whose scanner cannot yet say
   * where a finding came from.
   *
   * `'papercusp-bundled'` — only findings attributed to content the release
   * actually ships (locations under the bundle path). This is D-204's ruling made
   * operative: the scanner keeps scanning the WHOLE image and additionally labels
   * each finding, so nothing is discarded and the inherited measurement — D-201's
   * entire evidentiary basis — survives intact. It narrows the SUBJECT of the
   * verdict, never the scan, and never the bar.
   *
   * It is NOT a relaxation, and the distinction is the whole point. D-201 measured
   * that 1813 of 1839 at/above-high findings are `linux-kernel`, `go-module`,
   * `binary` and `python` content inherited from the base image, which no papercusp
   * change can reach; demanding zero of those is unsatisfiable by construction, and
   * an unsatisfiable gate is one nobody can honour. Scoping makes the UNCHANGED bar
   * apply to the 26 findings we actually own — which, per D-202, it then correctly
   * DENIES until they are fixed. Thresholds do not move (D-172/174/175).
   *
   * Selecting this scope obliges the scanner to prove its attribution partitions the
   * totals exactly; see `evaluateImageScanPolicy`. Absence of that proof denies.
   */
  evaluatedScope: ImageScanEvaluatedScope;
}

/**
 * The scope labels the scanner attributes findings to, and the populations a policy
 * may judge. Kept as a closed union so an unrecognised label arriving off the wire
 * is a denial rather than a silently-new bucket nothing counts.
 */
export type ImageScanFindingScope = 'papercusp-bundled' | 'inherited-base-image';
/**
 * Deliberately NOT `'all' | ImageScanFindingScope`. A release gate judging
 * `'inherited-base-image'` alone would be a gate that ignores everything we wrote,
 * so the type refuses to express it rather than leaving an unreachable branch that
 * looks like a supported option.
 */
export type ImageScanEvaluatedScope = 'all' | 'papercusp-bundled';

/**
 * The severity boundary the scanner's attributed bucket actually measures.
 *
 * `vulnerabilityCriticalHighByScope` is computed guest-side by a jq expression that
 * hardcodes `critical` or `high`. That answers exactly one question, so a scoped
 * policy denying at any OTHER threshold would be reading an instrument that does not
 * measure what it is being asked. Rather than approximate, the scoped path refuses —
 * see `scope-attribution-mismatch`.
 */
const SCOPE_ATTRIBUTED_THRESHOLD = 'high';

/** Scope labels the scanner may emit. Anything else denies rather than opening a new bucket. */
const FINDING_SCOPES: readonly ImageScanFindingScope[] = Object.freeze([
  'papercusp-bundled',
  'inherited-base-image',
]);

/** Populations a policy may declare it judges. */
const EVALUATED_SCOPES: readonly ImageScanEvaluatedScope[] = Object.freeze(['all', 'papercusp-bundled']);

/**
 * The ratified workspace-host release security policy: deny vulnerabilities at or
 * above HIGH, allow ZERO secrets.
 *
 * This is not a new threshold scheme. It is the policy every `ArtifactTrustPolicy`
 * call site in this repository already instantiates — including this very release
 * path — lifted into one exported constant so the image gate consults the same
 * numbers instead of a fifth hand-rolled copy.
 */
export const WORKSPACE_HOST_IMAGE_SCAN_POLICY: ImageScanPolicy = Object.freeze({
  denyVulnerabilitiesAtOrAbove: 'high',
  maxSecretFindings: 0,
  // FALSE because this is the generic threshold baseline, not a provider release
  // policy. Every concrete provider release path uses its own scoped policy below,
  // which requires the scanner's filesystem/root proof.
  requireCoverageProof: false,
  // 'all' for the same reason: the baseline states thresholds, and a caller with no
  // attributing scanner must not inherit a narrower SUBJECT by silence. Same
  // required-not-optional reasoning as requireCoverageProof — a policy has to SAY
  // which population it judges.
  evaluatedScope: 'all',
});

/**
 * Build a provider-scoped policy with identical thresholds whose scanner MUST prove
 * it covered the image.
 *
 * Separate objects are intentional: flipping `requireCoverageProof` on the shared
 * baseline would change the contract for generic callers, while using the baseline
 * in a provider release path would silently allow an unmeasured scan.
 */
function providerImageScanPolicy(evaluatedScope: ImageScanEvaluatedScope = 'all'): ImageScanPolicy {
  return Object.freeze({
    ...WORKSPACE_HOST_IMAGE_SCAN_POLICY,
    requireCoverageProof: true,
    evaluatedScope,
  });
}

/**
 * GCP's guest scanner emits the coverage pair and must prove it at the release gate.
 *
 * It is also the only scanner that ATTRIBUTES findings (D-204), so it is the only
 * provider whose verdict may be scoped. The argument is passed explicitly rather than
 * defaulted, so adding a provider never grants it a narrower subject by accident —
 * a new provider gets `'all'` until its scanner earns otherwise.
 */
export const GCP_IMAGE_SCAN_POLICY: ImageScanPolicy = Object.freeze({
  ...providerImageScanPolicy('papercusp-bundled'),
  // Attached HERE and not on the baseline for the same reason `evaluatedScope` is passed
  // explicitly: allowances are statements about one concrete bundle, measured against one
  // concrete scanner. A provider that inherited them by default would be excusing findings in
  // content nobody examined. AWS and Azure carry none until their bundles are triaged.
  secretAllowances: WORKSPACE_HOST_SECRET_ALLOWANCES,
});

/**
 * AWS AMI scanners emit the coverage pair and must prove it at the release gate.
 * `'all'` until an AWS scanner emits the attribution maps: a scoped policy against a
 * non-attributing scanner denies (correctly, fail-closed), so this is a statement of
 * where AWS actually is, not a concession.
 */
export const AWS_IMAGE_SCAN_POLICY: ImageScanPolicy = providerImageScanPolicy('all');

/** Azure Compute Gallery scanners emit the coverage pair and must prove it at the release gate. Same `'all'` reasoning as AWS. */
export const AZURE_IMAGE_SCAN_POLICY: ImageScanPolicy = providerImageScanPolicy('all');

/**
 * Severity ordering, DERIVED from `artifact-trust.ts` rather than restated here, so
 * the image gate and the bundle gate cannot drift into ranking the same word
 * differently. `unknown` therefore sits BELOW `low`, exactly as the ratified policy
 * already has it — this module reuses that ordering rather than inventing a
 * stricter one.
 *
 * The single addition is `negligible`: grype's own bottom rung, which has no
 * `ArtifactTrustPolicy` equivalent because that policy never sees raw scanner
 * labels. It ranks below `unknown`, and no policy can deny it, since
 * `denyVulnerabilitiesAtOrAbove` cannot be set lower than `low`.
 */
const SEVERITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  ...ARTIFACT_TRUST_SEVERITY_RANK,
  negligible: ARTIFACT_TRUST_SEVERITY_RANK.unknown - 1,
});

export type ImageScanPolicyFailureCode =
  | 'coverage-proof-invalid'
  | 'coverage-proof-missing'
  | 'invalid-policy'
  | 'malformed-severity-breakdown'
  | 'scope-attribution-invalid'
  | 'scope-attribution-missing'
  | 'scope-attribution-mismatch'
  // The allowlist could not be applied SOUNDLY (incomplete or self-inconsistent evidence).
  // Distinct from 'secret-unjustified' on purpose: this one says the instrument failed, not
  // that the image is dirty, and the two need different repairs.
  | 'secret-allowance-unusable'
  // A justified file produced MORE findings than its entry accounts for.
  | 'secret-allowance-overflow'
  // A bundled finding matched no committed allowance.
  | 'secret-unjustified'
  | 'secret-threshold'
  | 'severity-breakdown-mismatch'
  | 'unrecognized-severity'
  | 'vulnerability-threshold';

export interface ImageScanPolicyFailure {
  code: ImageScanPolicyFailureCode;
  message: string;
}

export interface ImageScanPolicyInput {
  /** Total grype matches at any severity, as reported by the scanner. */
  vulnerabilityFindings: number;
  /** Per-severity counts keyed by grype's own severity labels. */
  vulnerabilityBySeverity: Readonly<Record<string, unknown>>;
  /** Total gitleaks findings, as reported by the scanner. */
  secretFindings: number;
  /**
   * How many filesystems the guest actually mounted off the candidate disk.
   *
   * Typed `unknown` rather than `number | undefined` deliberately: this value
   * crosses a process boundary as JSON from a guest VM, so the type it is DECLARED
   * as here is a claim about a wire payload, not a compiler-checked fact. Narrowing
   * it is this module's job, not the caller's.
   */
  mountedFilesystems?: unknown;
  /**
   * Path to the file that proves an OS root was mounted (e.g. an `/etc/os-release`
   * under the candidate mount). Same `unknown` reasoning as above.
   */
  candidateRootProof?: unknown;
  /**
   * D-204's attribution, all four typed `unknown` for the same reason as the coverage
   * pair: they cross a process boundary as JSON from a guest VM, so narrowing them is
   * this module's job, not the caller's.
   *
   * `vulnerabilityByScope` / `secretsByScope` — every finding bucketed by origin.
   * `vulnerabilityCriticalHighByScope` — the at/above-high subset, bucketed the same way.
   * `bundleCatalogedArtifacts` — how many SBOM ARTIFACTS (packages, not findings) were
   * cataloged under the bundle path. This is the field that makes a scoped verdict
   * safe: it is the one number that distinguishes "we looked at the bundle and it is
   * clean" from "we never found the bundle, so of course nothing was attributed to it".
   */
  vulnerabilityByScope?: unknown;
  vulnerabilityCriticalHighByScope?: unknown;
  secretsByScope?: unknown;
  bundleCatalogedArtifacts?: unknown;
  /**
   * Every papercusp-bundled secret finding, as {rule, file, line} — and whether that list is
   * the WHOLE bundled population or was cut by the scanner's cap.
   *
   * `unknown` for the same reason as the four above: guest JSON, narrowed here.
   *
   * These are what make a per-finding allowlist possible at all. Until they existed this module
   * received bundled COUNTS and nothing else, so the only way to pass a bundle containing a
   * justified finding would have been to move `maxSecretFindings` off zero — precisely the
   * threshold move D-172/174/175 forbid.
   */
  secretBundledSample?: unknown;
  secretBundledSampleComplete?: unknown;
}

export interface ImageScanPolicyVerdict {
  version: typeof WORKSPACE_HOST_IMAGE_SCAN_POLICY_VERSION;
  accepted: boolean;
  /** Findings at or above the denied severity. This is what the gate acts on. */
  policyViolatingVulnerabilities: number;
  /** Everything below the threshold: recorded as evidence, never a pass/fail input. */
  toleratedVulnerabilities: number;
  totalVulnerabilities: number;
  /** Every secret finding on the image. Recorded as evidence, whatever the scope. */
  secretFindings: number;
  /**
   * The secret findings the gate actually acted on. Equal to `secretFindings` under
   * `evaluatedScope: 'all'`; under a scoped policy it is the attributed bucket alone.
   * Kept as its own field rather than redefining `secretFindings`, so a stored verdict
   * never silently changes what an existing field means.
   */
  policyViolatingSecrets: number;
  /**
   * WHICH population the counts above describe — echoed from the policy so a reader
   * of a stored verdict can never mistake a scoped pass for a whole-image one. A
   * verdict that does not say what it judged is the same class of ambiguity as a
   * count that does not say whether it was truncated.
   */
  evaluatedScope: ImageScanEvaluatedScope;
  failures: readonly ImageScanPolicyFailure[];
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

type ScopeMapReading =
  | { ok: true; bundled: number; total: number }
  | { ok: false; failure: ImageScanPolicyFailure };

/**
 * Narrow one attribution map off the wire.
 *
 * An UNRECOGNISED scope key denies outright rather than being folded into a bucket.
 * That is deliberately stricter than the `unrecognized-severity` rule one screen
 * down, and for a different reason: an unknown SEVERITY is a finding whose danger we
 * cannot rank, so counting it as violating is a safe over-approximation. An unknown
 * SCOPE means the scanner has changed how it partitions the image, which invalidates
 * the arithmetic this whole verdict rests on — there is no safe way to guess which
 * side of the boundary those findings fall on, so the honest answer is to stop.
 */
function readScopeMap(value: unknown, field: string): ScopeMapReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      failure: {
        code: 'scope-attribution-invalid',
        message: `${field} must be an object keyed by finding scope; received ${JSON.stringify(value)}.`,
      },
    };
  }
  let total = 0;
  let bundled = 0;
  for (const [label, rawCount] of Object.entries(value as Record<string, unknown>)) {
    if (!FINDING_SCOPES.includes(label as ImageScanFindingScope)) {
      return {
        ok: false,
        failure: {
          code: 'scope-attribution-invalid',
          message:
            `${field} contains unrecognised scope '${label}'; known scopes are ${FINDING_SCOPES.join(', ')}. ` +
            `A scanner that has re-partitioned the image cannot have its attribution read as before.`,
        },
      };
    }
    if (!isSafeCount(rawCount)) {
      return {
        ok: false,
        failure: {
          code: 'scope-attribution-invalid',
          message: `${field}['${label}'] must be a non-negative safe integer; received ${JSON.stringify(rawCount)}.`,
        },
      };
    }
    total += rawCount;
    if (label === 'papercusp-bundled') bundled += rawCount;
  }
  return { ok: true, bundled, total };
}

type BundledFindingsReading =
  | { ok: true; findings: readonly ImageScanSecretFinding[] }
  | { ok: false; failure: ImageScanPolicyFailure };

/**
 * Narrow the guest's `secretBundledSample` into typed findings.
 *
 * Every malformed shape denies rather than being skipped. A dropped row here would shrink the
 * population an allowlist is checked against, which is the false-GREEN direction: the finding
 * that failed to parse is exactly the one nobody then judges.
 */
function readBundledFindings(value: unknown): BundledFindingsReading {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      failure: {
        code: 'secret-allowance-unusable',
        message: `secretBundledSample must be an array of findings; received ${JSON.stringify(value)}.`,
      },
    };
  }
  const findings: ImageScanSecretFinding[] = [];
  for (const [index, row] of value.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return {
        ok: false,
        failure: {
          code: 'secret-allowance-unusable',
          message: `secretBundledSample[${index}] must be an object; received ${JSON.stringify(row)}.`,
        },
      };
    }
    const { rule, file } = row as { rule?: unknown; file?: unknown };
    if (typeof rule !== 'string' || rule.length === 0 || typeof file !== 'string' || file.length === 0) {
      return {
        ok: false,
        failure: {
          code: 'secret-allowance-unusable',
          message:
            `secretBundledSample[${index}] must carry non-empty string 'rule' and 'file'; received ` +
            `${JSON.stringify(row)}. A finding with no location cannot be matched against an allowance.`,
        },
      };
    }
    findings.push({ rule, file });
  }
  return { ok: true, findings };
}

/**
 * Evaluate a scanner measurement against the ratified image policy.
 *
 * Every failure mode below is fail-CLOSED: a measurement this function cannot fully
 * account for is rejected, never tolerated. In particular the sum of
 * `vulnerabilityBySeverity` must reconcile exactly against `vulnerabilityFindings`,
 * so a breakdown that is empty, partial, or silently dropped cannot present itself
 * as "zero findings at or above the threshold".
 */
export function evaluateImageScanPolicy(
  input: ImageScanPolicyInput,
  policy: ImageScanPolicy = WORKSPACE_HOST_IMAGE_SCAN_POLICY,
): ImageScanPolicyVerdict {
  const failures: ImageScanPolicyFailure[] = [];
  const scopeIsKnown = EVALUATED_SCOPES.includes(policy.evaluatedScope as ImageScanEvaluatedScope);
  let judgedSecrets = isSafeCount(input.secretFindings) ? input.secretFindings : -1;
  const verdict = (accepted: boolean, violating: number, tolerated: number): ImageScanPolicyVerdict => ({
    version: WORKSPACE_HOST_IMAGE_SCAN_POLICY_VERSION,
    accepted,
    policyViolatingVulnerabilities: violating,
    toleratedVulnerabilities: tolerated,
    totalVulnerabilities: isSafeCount(input.vulnerabilityFindings) ? input.vulnerabilityFindings : -1,
    secretFindings: isSafeCount(input.secretFindings) ? input.secretFindings : -1,
    policyViolatingSecrets: judgedSecrets,
    // Echo the policy's own value ONLY when it is a scope this build recognises.
    // An unrecognised one has already denied via invalid-policy below; reporting it
    // verbatim would put an uninterpretable label on a stored verdict.
    evaluatedScope: scopeIsKnown ? policy.evaluatedScope : 'all',
    failures,
  });

  const threshold = SEVERITY_RANK[policy.denyVulnerabilitiesAtOrAbove];
  if (
    typeof threshold !== 'number' ||
    !isSafeCount(policy.maxSecretFindings) ||
    typeof policy.requireCoverageProof !== 'boolean' ||
    !scopeIsKnown
  ) {
    failures.push({
      code: 'invalid-policy',
      message:
        `Policy is unusable: denyVulnerabilitiesAtOrAbove '${policy.denyVulnerabilitiesAtOrAbove}' ` +
        `must be a known severity, maxSecretFindings '${policy.maxSecretFindings}' a non-negative integer, ` +
        `requireCoverageProof '${policy.requireCoverageProof}' a boolean, and evaluatedScope ` +
        `'${String(policy.evaluatedScope)}' one of ${EVALUATED_SCOPES.join(', ')}.`,
    });
    judgedSecrets = -1;
    return verdict(false, -1, -1);
  }

  // ── Scan coverage ────────────────────────────────────────────────────────────
  // Checked BEFORE any finding count, because "did this scan cover the image" is
  // prior to "what did it find". A scan that mounted nothing reports zero findings,
  // and zero findings is the shape of a perfect result — the same dead-instrument
  // failure the severity reconciliation below already defends against, one level up.
  //
  // Two rules, and the second applies to EVERY provider:
  //   1. If the policy REQUIRES proof, absence is a denial.
  //   2. If a value is PRESENT, it is validated regardless of the policy — so a
  //      provider that starts emitting a malformed proof is caught the day it does,
  //      not the day someone remembers to flip the flag on.
  const hasMounted = input.mountedFilesystems !== undefined && input.mountedFilesystems !== null;
  const hasRootProof = input.candidateRootProof !== undefined && input.candidateRootProof !== null;

  if (policy.requireCoverageProof && (!hasMounted || !hasRootProof)) {
    const absent = [!hasMounted ? 'mountedFilesystems' : null, !hasRootProof ? 'candidateRootProof' : null]
      .filter(Boolean)
      .join(' and ');
    failures.push({
      code: 'coverage-proof-missing',
      message:
        `Policy requires proof the scanner covered the image, but ${absent} ` +
        `${absent.includes(' and ') ? 'are' : 'is'} absent. An unproven scan cannot be read as a clean one.`,
    });
    return verdict(false, -1, -1);
  }

  if (hasMounted && !(isSafeCount(input.mountedFilesystems) && (input.mountedFilesystems as number) >= 1)) {
    failures.push({
      code: 'coverage-proof-invalid',
      message:
        `mountedFilesystems must be a safe integer >= 1; received ${JSON.stringify(input.mountedFilesystems)}. ` +
        `A scan that mounted no filesystem has measured nothing.`,
    });
    return verdict(false, -1, -1);
  }

  if (hasRootProof && !(typeof input.candidateRootProof === 'string' && input.candidateRootProof.trim() !== '')) {
    failures.push({
      code: 'coverage-proof-invalid',
      message:
        `candidateRootProof must be a non-empty string; received ${JSON.stringify(input.candidateRootProof)}. ` +
        `Without it the scan cannot show it mounted an OS root rather than an empty or data-only partition.`,
    });
    return verdict(false, -1, -1);
  }

  if (!isSafeCount(input.vulnerabilityFindings) || !isSafeCount(input.secretFindings)) {
    failures.push({
      code: 'malformed-severity-breakdown',
      message: 'Scanner counts must be non-negative safe integers.',
    });
    return verdict(false, -1, -1);
  }

  const breakdown = input.vulnerabilityBySeverity;
  if (typeof breakdown !== 'object' || breakdown === null || Array.isArray(breakdown)) {
    failures.push({
      code: 'malformed-severity-breakdown',
      message: 'vulnerabilityBySeverity must be an object keyed by severity.',
    });
    return verdict(false, -1, -1);
  }

  let violating = 0;
  let tolerated = 0;
  let counted = 0;
  for (const [label, rawCount] of Object.entries(breakdown)) {
    if (!isSafeCount(rawCount)) {
      failures.push({
        code: 'malformed-severity-breakdown',
        message: `Severity '${label}' has a non-integer count.`,
      });
      return verdict(false, -1, -1);
    }
    counted += rawCount;
    const rank = SEVERITY_RANK[label.trim().toLowerCase()];
    if (typeof rank !== 'number') {
      // An unrecognised label is not evidence of safety. A severity this build does
      // not know about counts as violating, so a scanner that starts emitting a new
      // label turns the gate RED and gets a human's attention — rather than silently
      // widening what passes.
      failures.push({
        code: 'unrecognized-severity',
        message: `Severity '${label}' is not a known severity; counting its ${rawCount} finding(s) as policy-violating.`,
      });
      violating += rawCount;
      continue;
    }
    if (rank >= threshold) violating += rawCount;
    else tolerated += rawCount;
  }

  // The reconciliation that makes an absent measurement impossible to misread as a
  // clean one. Without it, `vulnerabilityBySeverity: {}` reports zero violations
  // while `vulnerabilityFindings` is in the thousands — precisely the shape of the
  // original defect, where a dead instrument was indistinguishable from a pass.
  if (counted !== input.vulnerabilityFindings) {
    failures.push({
      code: 'severity-breakdown-mismatch',
      message:
        `vulnerabilityBySeverity sums to ${counted} but vulnerabilityFindings is ` +
        `${input.vulnerabilityFindings}; the measurement does not account for every finding.`,
    });
    return verdict(false, -1, -1);
  }

  // ── Scope attribution ────────────────────────────────────────────────────────
  // Everything above measured the WHOLE image, and that measurement stays intact:
  // D-204 ruled that findings are ATTRIBUTED, never that the scan is narrowed,
  // because the inherited population is D-201's entire evidentiary basis and a scan
  // that only ever looks at one directory cannot prove it mounted an OS at all.
  //
  // A scoped policy changes only WHICH of those findings the thresholds judge. Every
  // check below fails CLOSED, and the reason is specific to this direction of change:
  // the failure mode of scoping is not a false RED, it is a false GREEN. Get the
  // bundle path wrong and every finding attributes to 'inherited-base-image', the
  // bundled bucket reads 0, and an unsatisfiable gate silently becomes a vacuously
  // satisfied one — the same shape as the gitleaks installer that never installed and
  // the root that was never mounted. So a scoped verdict is earned by PROOF that the
  // attribution accounts for every finding and that the bundle was actually cataloged,
  // never by the mere presence of the fields.
  if (policy.evaluatedScope === 'papercusp-bundled') {
    // 1. The instrument must answer the question this policy asks. The scanner's
    //    attributed bucket is computed guest-side over `critical` or `high` only, so
    //    at any other threshold it is simply not a measurement of what is being
    //    denied. Approximating here would be the quietest possible way to break the
    //    bar, so refuse instead.
    if (policy.denyVulnerabilitiesAtOrAbove !== SCOPE_ATTRIBUTED_THRESHOLD) {
      failures.push({
        code: 'scope-attribution-mismatch',
        message:
          `A scoped verdict reads vulnerabilityCriticalHighByScope, which measures only ` +
          `'critical' and 'high'. This policy denies at or above ` +
          `'${policy.denyVulnerabilitiesAtOrAbove}', which that bucket cannot answer.`,
      });
      return verdict(false, -1, -1);
    }

    // 2. Presence. Absence is a denial, never a clean read — the same rule the
    //    coverage proof applies one screen up.
    const absent = [
      input.vulnerabilityByScope == null ? 'vulnerabilityByScope' : null,
      input.vulnerabilityCriticalHighByScope == null ? 'vulnerabilityCriticalHighByScope' : null,
      input.secretsByScope == null ? 'secretsByScope' : null,
      input.bundleCatalogedArtifacts == null ? 'bundleCatalogedArtifacts' : null,
    ].filter((field): field is string => field !== null);
    if (absent.length > 0) {
      failures.push({
        code: 'scope-attribution-missing',
        message:
          `Policy judges the '${policy.evaluatedScope}' scope, but this scanner did not attribute ` +
          `its findings: ${absent.join(', ')} absent. An unattributed scan cannot be read as a scoped one.`,
      });
      return verdict(false, -1, -1);
    }

    // 3. The bundle was actually cataloged. THE check that separates "we looked at the
    //    bundle and it is clean" from "we never found the bundle". Counted in SBOM
    //    ARTIFACTS — packages, not findings — because a bundle can legitimately have
    //    zero findings but can never legitimately have zero packages. This is the
    //    packages-not-findings proof D-204 gated the scoped verdict on.
    if (!isSafeCount(input.bundleCatalogedArtifacts) || (input.bundleCatalogedArtifacts as number) < 1) {
      failures.push({
        code: 'scope-attribution-invalid',
        message:
          `bundleCatalogedArtifacts must be a safe integer >= 1; received ` +
          `${JSON.stringify(input.bundleCatalogedArtifacts)}. Zero cataloged bundle packages means the ` +
          `scan never found the release, so an empty bundled bucket proves nothing about it.`,
      });
      return verdict(false, -1, -1);
    }

    const byScope = readScopeMap(input.vulnerabilityByScope, 'vulnerabilityByScope');
    if (!byScope.ok) {
      failures.push(byScope.failure);
      return verdict(false, -1, -1);
    }
    const criticalHighByScope = readScopeMap(
      input.vulnerabilityCriticalHighByScope,
      'vulnerabilityCriticalHighByScope',
    );
    if (!criticalHighByScope.ok) {
      failures.push(criticalHighByScope.failure);
      return verdict(false, -1, -1);
    }
    const secretsByScope = readScopeMap(input.secretsByScope, 'secretsByScope');
    if (!secretsByScope.ok) {
      failures.push(secretsByScope.failure);
      return verdict(false, -1, -1);
    }

    // 4. The partitions must be TOTAL. Each attribution has to account for exactly the
    //    findings the same scan already reported, or some findings fell out of the
    //    arithmetic — and the ones that fall out are precisely the ones nobody judges.
    //    The critical/high map reconciles against `violating`, which was derived from
    //    an INDEPENDENT breakdown (by severity), so this also cross-checks two
    //    instruments against each other rather than trusting either alone.
    const reconciliations: readonly (readonly [string, number, number])[] = [
      ['vulnerabilityByScope', byScope.total, input.vulnerabilityFindings],
      ['vulnerabilityCriticalHighByScope', criticalHighByScope.total, violating],
      ['secretsByScope', secretsByScope.total, input.secretFindings],
    ];
    for (const [field, attributed, expected] of reconciliations) {
      if (attributed !== expected) {
        failures.push({
          code: 'scope-attribution-mismatch',
          message:
            `${field} sums to ${attributed} but the scan reported ${expected}; the attribution does ` +
            `not account for every finding, so no scope's count can be trusted.`,
        });
        return verdict(false, -1, -1);
      }
    }

    // 5. A bucket cannot hold more at/above-threshold findings than it holds findings.
    if (criticalHighByScope.bundled > byScope.bundled) {
      failures.push({
        code: 'scope-attribution-mismatch',
        message:
          `vulnerabilityCriticalHighByScope reports ${criticalHighByScope.bundled} at/above-'${SCOPE_ATTRIBUTED_THRESHOLD}' ` +
          `findings in the '${policy.evaluatedScope}' scope, but vulnerabilityByScope reports only ` +
          `${byScope.bundled} findings there in total.`,
      });
      return verdict(false, -1, -1);
    }

    violating = criticalHighByScope.bundled;
    tolerated = byScope.bundled - criticalHighByScope.bundled;
    judgedSecrets = secretsByScope.bundled;

    // 6. Per-finding justification. Only reached when the policy actually carries allowances;
    //    with none, `judgedSecrets` stays the raw bundled count and the bar behaves exactly as
    //    it did before this block existed.
    //
    //    Every branch here DENIES rather than falling through to the unmodified count, because
    //    the failure mode of an allowlist is a false GREEN: excuse a finding you never saw and
    //    the gate reports clean on a bundle carrying a real credential. So the list has to be
    //    provably complete before a single finding is excused.
    //    NOTE ON DEGRADATION: when the allowlist cannot be applied soundly, this block records
    //    WHY and then leaves `judgedSecrets` at the raw bundled count — it never returns early.
    //    That way the mechanism can never make a verdict weaker OR differently-shaped than it was
    //    before allowances existed: an unusable list degrades exactly to the old behaviour, and
    //    the image still denies through `secret-threshold` on the honest number. Returning early
    //    here would have replaced a true "this image exceeds the bar" with a narrower complaint
    //    about the instrument, which is the less actionable of the two.
    const allowances = policy.secretAllowances ?? [];
    if (allowances.length > 0 && judgedSecrets > 0) {
      const sample =
        input.secretBundledSampleComplete === true
          ? readBundledFindings(input.secretBundledSample)
          : ({
              ok: false,
              failure: {
                code: 'secret-allowance-unusable',
                message:
                  `Policy carries ${allowances.length} secret allowance(s), but the scanner did not ` +
                  `report secretBundledSampleComplete === true (received ` +
                  `${JSON.stringify(input.secretBundledSampleComplete)}). An allowlist applied to a ` +
                  `partial finding list would excuse the findings it never saw, so none were applied ` +
                  `and every bundled finding is judged.`,
              },
            } as const);

      if (!sample.ok) {
        failures.push(sample.failure);
      } else if (sample.findings.length !== judgedSecrets) {
        // The list and the census are two independent projections of the same scan. If they
        // disagree, one of them is wrong and there is no safe way to tell which.
        failures.push({
          code: 'secret-allowance-unusable',
          message:
            `secretBundledSample holds ${sample.findings.length} finding(s) but secretsByScope reports ` +
            `${judgedSecrets} in the '${policy.evaluatedScope}' scope. The enumeration and the census ` +
            `disagree, so neither can be trusted to drive an allowlist; none were applied.`,
        });
      } else {
        const outcome = applySecretAllowances(sample.findings, allowances);
        for (const { allowance, matched } of outcome.overflowed) {
          failures.push({
            code: 'secret-allowance-overflow',
            message:
              `Allowance for '${allowance.rule}' at '${allowance.filePattern}' justifies ` +
              `${allowance.maxFindings} finding(s) but ${matched} were found. The surplus is ` +
              `unexplained: a new secret in an already-justified file is still a new secret.`,
          });
        }
        if (outcome.overflowed.length === 0) {
          // What survives is what the bar judges. Unjustified findings are named individually —
          // a bare count would send the next reader back to a scan they may not be able to re-run.
          judgedSecrets = outcome.unjustified.length;
          if (outcome.unjustified.length > 0) {
            const named = outcome.unjustified
              .slice(0, 10)
              .map((finding) => `${finding.rule} @ ${finding.file}`)
              .join('; ');
            failures.push({
              code: 'secret-unjustified',
              message:
                `${outcome.unjustified.length} bundled secret finding(s) match no committed allowance: ` +
                `${named}${outcome.unjustified.length > 10 ? '; …' : ''}. Each must be investigated and ` +
                `either fixed or justified in writing — never waved through as a group.`,
            });
          }
        }
      }
    }
  }

  if (violating > 0) {
    failures.push({
      code: 'vulnerability-threshold',
      message:
        `${violating} vulnerability finding(s) at or above '${policy.denyVulnerabilitiesAtOrAbove}'` +
        `${policy.evaluatedScope === 'all' ? '' : ` in the '${policy.evaluatedScope}' scope`} ` +
        `(${tolerated} below the threshold, recorded as evidence).`,
    });
  }

  if (judgedSecrets > policy.maxSecretFindings) {
    failures.push({
      code: 'secret-threshold',
      message:
        `Secret scan found ${judgedSecrets}` +
        `${policy.evaluatedScope === 'all' ? '' : ` in the '${policy.evaluatedScope}' scope`}; ` +
        `policy allows ${policy.maxSecretFindings}.`,
    });
  }

  return verdict(failures.length === 0, violating, tolerated);
}
