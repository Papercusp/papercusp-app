/**
 * secret-detect.ts — write-time detection of credential-shaped memory content
 * (EI-10371 stage 1: FLAG, DON'T TOUCH).
 *
 * The memory write paths store whatever an agent hands them, verbatim — and a
 * live scan (2026-07-12) found 16 real connection strings with embedded
 * passwords already at rest. A stored secret then rides every downstream
 * surface: recall into future agent contexts, the settings page, the export
 * file, pending federation. This module makes that class VISIBLE at write
 * time: callers stamp `metadata.possible_secret` + `possible_secret_classes`
 * and surface a warning — the content itself is never altered or refused
 * (masking/refusing is a product-policy fork that needs owner review with
 * real-world flag-precision data in hand; deliberately not taken here).
 *
 * HIGH-CONFIDENCE patterns only: every regex requires a vendor prefix, a
 * structural shape (scheme://user:pass@), or both. No entropy heuristics —
 * a false "may contain a credential" chip on ordinary prose costs more trust
 * than a missed exotic token. PURE module (no imports, no I/O) by design:
 * it runs inline on every write path and route tests need no mocks for it.
 */

export interface SecretDetection {
  matched: boolean;
  /** Stable kebab-case pattern-class names, in PATTERNS order. */
  classes: string[];
}

const PATTERNS: ReadonlyArray<{ cls: string; re: RegExp }> = [
  { cls: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
  // Legacy OpenAI keys are 48 alnum after `sk-`; project keys carry `proj-`.
  // The legacy arm requires 32+ so `sk-` prose ("sk-learning") never trips it.
  { cls: 'openai-api-key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{32,}\b/ },
  { cls: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { cls: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { cls: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { cls: 'slack-token', re: /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/ },
  { cls: 'private-key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  // Two `eyJ` base64url segments + a signature — a bare "eyJ..." fragment alone
  // (someone quoting a header) does not match.
  { cls: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  // scheme://user:password@ — the class that actually exists in the live store
  // (postgres:// with embedded passwords). The password part excludes `/`, so
  // `http://localhost:3070/api` (port, no @) can never match.
  { cls: 'url-with-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i },
  // Requires a digit somewhere in the token so prose like
  // "Bearer token-based-authentication" stays clean.
  { cls: 'bearer-token', re: /\bBearer\s+(?=[A-Za-z0-9_\-.=+/]*\d)[A-Za-z0-9_\-.=+/]{20,}/ },
];

/** Scan `text` against the high-confidence credential patterns. */
export function detectPossibleSecrets(text: string): SecretDetection {
  const classes: string[] = [];
  if (text) {
    for (const p of PATTERNS) {
      if (p.re.test(text)) classes.push(p.cls);
    }
  }
  return { matched: classes.length > 0, classes };
}

/** The legible warning a write path returns alongside a flagged store. */
export function possibleSecretWarning(classes: string[]): string {
  const what = classes.length > 0 ? classes.join(', ') : 'credential-shaped content';
  return (
    `This memory looks like it contains a credential (${what}). ` +
    `It was stored UNCHANGED and flagged (metadata.possible_secret) — it will ride recall, ` +
    `the settings page, and exports. If it is a real secret: rotate it, then memory:forget ` +
    `this entry or re-write it without the secret.`
  );
}
