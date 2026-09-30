/**
 * image-scan-secret-allowances — the COMMITTED, per-finding justification list for secret
 * findings inside papercusp-bundled image content.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A THRESHOLD MOVE ─────────────────────────────────
 * `maxSecretFindings` is 0 and stays 0 (hard-required by publication-manifest.ts; D-172 /
 * D-174 / D-175 forbid moving a threshold to make a gate pass), and the scan root is not
 * narrowed (D-204 rules attribution, not narrowing). Neither of those lets a release ship
 * when the bundled population is non-empty for reasons that are genuinely fine — an upstream
 * vendor's public client key, or an entropy match on minified code that is not a key at all.
 *
 * So the bar does not move; each individual finding is justified IN WRITING, in a committed
 * file, and anything NOT on this list still denies. D-212 is the governing ruling: every entry
 * records which of three things it is —
 *   (a) an upstream third-party constant vendored under our path,
 *   (b) a scanner false positive (entropy match on non-secret text), or
 *   (c) a real papercusp credential — which is NEVER allowlisted; it is removed and rotated.
 * There are no (c) entries here, and there must never be one. A finding that is really a
 * leaked credential is a bug to fix, not a line to add.
 *
 * ── WHY ENTRIES DO NOT NAME LINE NUMBERS OR EXACT FILENAMES ─────────────────────────────
 * Both move on every rebuild, and a rebuild is imminent (WI-1203796 re-cuts the bundle to
 * clear the npm findings). `serve.mjs` line numbers shift whenever anything upstream of them
 * changes, and SPA chunk filenames embed a content hash — `chunk-ZUYEQ4TG-50072df8.js` is the
 * same module as `chunk-ZUYEQ4TG-BQBy34Os.js` in another build. An allowlist keyed on either
 * would go stale on the next cut and re-red the gate for no security reason, which is exactly
 * how allowlists train people to widen them carelessly.
 *
 * `maxFindings` is what keeps the pattern honest: it pins how many findings that (rule, path)
 * pair is known to produce, so a NEW secret appearing in an already-justified file still
 * denies instead of hiding inside an existing allowance.
 */

/** The scanner's rule ids, as gitleaks emits them. */
export type ImageScanSecretRule = string;

export interface ImageScanSecretAllowance {
  /** gitleaks RuleID this entry justifies. Matched exactly — never a pattern. */
  readonly rule: ImageScanSecretRule;
  /**
   * Glob over the finding's file path. `*` matches any run of characters INCLUDING `/`;
   * every other character is literal. Anchored at both ends.
   *
   * Deliberately not a regular expression: these are authored by hand under time pressure
   * during a release, and a regex typo silently widens an allowlist (`.` matching anything)
   * where a glob typo simply stops matching and denies.
   */
  readonly filePattern: string;
  /**
   * How many findings this entry may account for. A count, not a licence: if the file starts
   * producing MORE than this, the surplus is unjustified and the gate denies.
   */
  readonly maxFindings: number;
  /** Why this is not a leaked credential. Prose, specific to the finding — never a rubber stamp. */
  readonly reason: string;
}

/**
 * Compile a `filePattern` glob to an anchored RegExp.
 *
 * Every metacharacter is escaped before `*` is re-introduced, so a pattern can only ever match
 * what it literally says plus its wildcards.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*');
  return new RegExp(`^${escaped}$`);
}

/** A single bundled finding, as carried by the scanner's `secretBundledSample`. */
export interface ImageScanSecretFinding {
  readonly rule: string;
  readonly file: string;
  readonly line?: number;
}

export interface SecretAllowanceOutcome {
  /** Findings matched by no allowance — these are what the gate judges. */
  readonly unjustified: readonly ImageScanSecretFinding[];
  /** Entries whose matched count exceeded `maxFindings`, with both numbers. */
  readonly overflowed: readonly { readonly allowance: ImageScanSecretAllowance; readonly matched: number }[];
  /** Entries that matched nothing at all — stale, and reported so the list can shrink. */
  readonly unused: readonly ImageScanSecretAllowance[];
}

/**
 * Apply the allowances to a complete bundled finding list.
 *
 * Order matters only in that each finding is consumed by the FIRST entry that matches it, so
 * two overlapping entries cannot both count the same finding and quietly double the budget.
 */
export function applySecretAllowances(
  findings: readonly ImageScanSecretFinding[],
  allowances: readonly ImageScanSecretAllowance[],
): SecretAllowanceOutcome {
  const compiled = allowances.map((allowance) => ({
    allowance,
    match: globToRegExp(allowance.filePattern),
    matched: 0,
  }));
  const unjustified: ImageScanSecretFinding[] = [];

  for (const finding of findings) {
    const entry = compiled.find(
      (candidate) => candidate.allowance.rule === finding.rule && candidate.match.test(finding.file),
    );
    if (entry) entry.matched += 1;
    else unjustified.push(finding);
  }

  return {
    unjustified,
    overflowed: compiled
      .filter((entry) => entry.matched > entry.allowance.maxFindings)
      .map((entry) => ({ allowance: entry.allowance, matched: entry.matched })),
    unused: compiled.filter((entry) => entry.matched === 0).map((entry) => entry.allowance),
  };
}

/**
 * The workspace-host bundle's justified secret findings.
 *
 * MEASURED 2026-08-30 against the published bundle at
 * `.papercusp/p046-r14-publication/extracted/` — the same artifact baked into
 * `papercusp-workspace-host-0-0-18-candidate`, confirmed by the content-hashed filename
 * `spa/assets/chunk-ZUYEQ4TG-50072df8.js` appearing in both. gitleaks 8.30.1 (the pinned
 * version) reported exactly 31 findings there, matching the image scan's bundled census
 * to the unit. Every one of the 31 is accounted for below.
 *
 * RE-MEASURED 2026-09-02 for the r19 rebake (pin aea66c75), whose sidecar rebuild grew
 * serve.mjs by 1.16MB: 32 findings, again matching the image scan's bundled census (2 + 30)
 * to the unit. The delta was established by SET DIFFERENCE against the r18 bundle, not by
 * re-reading a longer list — r18 scans to exactly 29, and that reproduction of the committed
 * number is what makes the diff trustworthy. Of the 30: 28 are byte-identical to findings
 * already justified below, one is a pure minifier renumbering ('result28=key14' →
 * 'result27=key14', the same fragment under a new temp-var index), and exactly ONE is new.
 * The generic-api-key entry names it and where it comes from.
 *
 * ⛔ SHRINK-ONLY IN SPIRIT: adding an entry means a new unexplained secret appeared in content
 * we ship. That is a finding to investigate first and justify second, never a line to append
 * to make a red gate green.
 */
export const WORKSPACE_HOST_SECRET_ALLOWANCES: readonly ImageScanSecretAllowance[] = Object.freeze([
  {
    rule: 'gcp-api-key',
    filePattern: '*/spa/*chunk-ZUYEQ4TG*.js',
    maxFindings: 2,
    reason:
      'Upstream @excalidraw public Firebase client key. The identical 39-character AIzaSy… value ' +
      'is present in the published upstream package at ' +
      'node_modules/@excalidraw/excalidraw/dist/prod/chunk-ZUYEQ4TG.js — it is excalidraw\'s own ' +
      'collaboration-backend config, vendored under our bundle path, not a papercusp credential. ' +
      'Firebase browser keys are project identifiers shipped in every client; access is gated by ' +
      'Firebase security rules, not by the key being secret. Two findings because the build emits ' +
      'the same chunk twice, under spa/assets/ and spa/excalidraw/.',
  },
  {
    rule: 'generic-api-key',
    filePattern: '*/serve.mjs',
    maxFindings: 30,
    reason:
      'The bundled server is a single ~57MB minified file, and gitleaks\' generic-api-key rule is ' +
      'entropy-based, so it matches high-entropy NON-secret text. All 30 were read individually: ' +
      '20 are base64-encoded tokenizer vocabulary (decoding the matches gives ordinary words in ' +
      'several languages — " Canaveral", " subreddit", " richten", " gerçekle", Arabic script, ' +
      '"UITextFiel"); 8 are minified JS source fragments (matches begin "e4.sortKey===v", ' +
      '"EMPTY_SET3=new", "consumed=await", "this.signature", "parent=keyOfRow", "result27=key14", ' +
      'and — the only finding r19 genuinely added — "verdictFns=await", which is the minified form ' +
      'of `const verdictFns = await import(...)` at packages/operator-core/lib/harness/routines/' +
      'release-actions.ts:1026. gitleaks flags it because the ADJACENT minified token ends ' +
      '"...signWithDeviceKey,", so the rule\'s `key`-keyword proximity check captures the next ' +
      'assignment; the captured text is an identifier and the `await` operator, carrying no value ' +
      'at all, let alone a credential); 1 is POSTHOG_PUBLIC_DEFAULTS.projectKey ' +
      'from posthog-public-defaults.ts, a PostHog write-only ingestion key designed to ship in ' +
      'clients; and 1 is CANONICAL_INVITE_SECRET from harness/canonical-hive-invite.ts, which that ' +
      'file documents as a DISCOVERY TOKEN deliberately committed under dogfood-silent-canonical-' +
      'hive-join D-001/P-003 — it only lets a fresh install request the hive, with real access ' +
      'gated by GitHub repo permissions and the owner-signed admission allowlist, and the hive ' +
      'PRIVATE key is explicitly kept out of that file. maxFindings pins the count so a genuinely ' +
      'new secret landing in serve.mjs still denies rather than hiding among these.',
  },
]);
