/**
 * pot-git/secrets-guard.ts — refuse to publish a commit whose changed content
 * carries a secret (Phase 7 G-10, cross-machine-coord-parity-and-trust-2026-07-01
 * / P-043; D-011). The sibling of run-git-sync.ts's oversized-blob guard: that
 * one blocks a blob GitHub would reject; this one blocks a blob no one should
 * ever replicate to peers. REQUIRED before multi-owner autocommit replication —
 * once a device's raw autocommits federate to other owners' machines, a leaked
 * key is exfiltrated hive-wide, so the leak must be caught at PUBLISH time.
 *
 * PRECISION over recall: a false positive BLOCKS a legitimate commit, so the
 * rule set is deliberately high-signal — known credential SHAPES (AWS keys, PEM
 * private-key blocks, GitHub/Slack/Stripe token prefixes) plus a generic
 * "secret-named assignment to a high-entropy value" rule. It does NOT entropy-scan
 * arbitrary strings (git shas, minified assets, lockfile hashes would all trip
 * it). The caller decides what to scan (the publish diff); this module is pure.
 */

/** One secret match in a changed file. */
export interface SecretFinding {
  path: string;
  /** 1-indexed line. */
  line: number;
  /** The rule id that matched (stable, for allowlisting / messaging). */
  rule: string;
  /** A redacted excerpt (the secret itself is masked) for the operator message. */
  excerpt: string;
}

interface Rule {
  id: string;
  re: RegExp;
}

/** High-signal credential shapes. Each `re` is applied per line (global, so a
 *  line with two keys yields two findings). */
const RULES: Rule[] = [
  // AWS access key ids (long-lived AKIA + temporary ASIA).
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // GitHub tokens (personal/oauth/server/refresh/fine-grained).
  { id: 'github-token', re: /\bgh[posru]_[A-Za-z0-9]{36,255}\b/g },
  // Slack tokens.
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Stripe live secret keys.
  { id: 'stripe-secret-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  // Google API keys.
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  // Private key PEM blocks (RSA/EC/DSA/OpenSSH/PGP/plain).
  { id: 'private-key-pem', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  // Generic bearer/JWT-ish: a secret-named assignment to a long high-entropy value.
  {
    id: 'secret-assignment',
    re: /\b(?:secret|password|passwd|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]?([A-Za-z0-9+/_\-]{20,})['"]?/gi,
  },
];

/** Shannon entropy (bits/char) of a string — used to keep the generic
 *  secret-assignment rule from firing on obvious non-secrets (e.g. a value like
 *  "changeme-in-production-please" is low entropy; a real token is high). */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Min entropy for the generic secret-assignment value to count as a secret. */
const SECRET_ASSIGNMENT_MIN_ENTROPY = 3.2;
const CODE_FILE_EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/i;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const IDENTIFIER_PART_RE = /[A-Za-z0-9_$]/;

/** Obvious placeholder values — suppress the generic rule so docs/examples don't
 *  block a commit (a real secret won't contain these markers). */
const PLACEHOLDER_RE =
  /your|here|goes|example|changeme|change-me|placeholder|dummy|sample|redacted|xxxx|<[a-z]|\btest\b|todo|fixme|none|null|undefined/i;

function mask(secret: string): string {
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/** Documented, non-functional example credentials that must NOT be treated as
 *  secrets by the placeholder-blind shape rules. AWS reserves the literal
 *  `EXAMPLE` suffix for its docs keys (AKIAIOSFODNN7EXAMPLE, ASIAIOSFODNN7EXAMPLE,
 *  the AKIAI44QH8DHBEXAMPLE family) — a real issued access-key id never ends in
 *  "EXAMPLE", so skipping them costs no real-secret recall while it stops a doc
 *  that merely CITES the example key from wedging the entire publish plane. */
function isDocumentedExample(ruleId: string, match: string): boolean {
  if (ruleId === 'aws-access-key-id') return match.endsWith('EXAMPLE');
  return false;
}

/** Scan one file's text for secrets. Pure. */
export function scanTextForSecrets(path: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 4096) continue; // skip minified/one-line blobs — no line-secrets there
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.re.exec(line)) !== null) {
        // The generic assignment rule captures the value in group 1 — gate it on
        // entropy so a placeholder ("your-secret-here") doesn't trip the build.
        if (rule.id === 'secret-assignment') {
          const value = m[1] ?? '';
          const valueIndex = m.index + m[0].lastIndexOf(value);
          const precedingCharacter = line[valueIndex - 1] ?? '';
          const followingCharacter = line[valueIndex + value.length] ?? '';
          const isQuotedValue = precedingCharacter === "'" || precedingCharacter === '"';
          if (
            CODE_FILE_EXTENSION_RE.test(path) &&
            !isQuotedValue &&
            IDENTIFIER_RE.test(value) &&
            !IDENTIFIER_PART_RE.test(precedingCharacter) &&
            !IDENTIFIER_PART_RE.test(followingCharacter)
          ) continue;
          if (shannonEntropy(value) < SECRET_ASSIGNMENT_MIN_ENTROPY) continue;
          if (PLACEHOLDER_RE.test(value)) continue; // an obvious example/placeholder, not a secret
          findings.push({ path, line: i + 1, rule: rule.id, excerpt: mask(value) });
        } else {
          // Documented example credentials are not secrets. AWS reserves the
          // literal `EXAMPLE` suffix for its non-functional docs keys
          // (AKIAIOSFODNN7EXAMPLE / ASIAIOSFODNN7EXAMPLE, etc.), used verbatim in
          // runbooks — and a real issued key ending in "EXAMPLE" is not a thing.
          // The shape rules are otherwise placeholder-blind, so without this a doc
          // that merely CITES the example key wedges the whole publish plane
          // (canonical stall root-caused in the P-402 soak, 2026-07-19).
          if (isDocumentedExample(rule.id, m[0])) continue;
          findings.push({ path, line: i + 1, rule: rule.id, excerpt: mask(m[0]) });
        }
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++; // guard zero-width
      }
    }
  }
  return findings;
}

/** Files that legitimately contain credential SHAPES as fixtures — the secrets
 *  scanner's OWN test suite. They are real-shaped BY DESIGN, so scanning them
 *  self-wedges the publish plane: the guard scans EVERY blob in (baseline,head],
 *  incl. every historical version of a file, so the instant such a file is
 *  edited its literal-fixture blob enters the range and can NEVER leave it
 *  (re-assembling the fixtures in a later commit does not remove the earlier
 *  blob). Exempt by EXACT repo path — keep this set MINIMAL and never add
 *  product code. (P-402 canonical-stall follow-on, 2026-07-19.) */
const FIXTURE_FILES: ReadonlySet<string> = new Set([
  'packages/operator-core/lib/sync/pot-git/secrets-guard.test.ts',
  // Sibling guard: the Claude Code PreToolUse secrets hook embeds credential
  // SHAPES as detection patterns + self-test fixtures (its PEM self-test case
  // is a bare private-key header literal — deliberately NOT reproduced here, so
  // this scanner's own source stays clean). That blob wedged the papercusp
  // own-head publish plane 2026-07-20 (identical class to the .test.ts above) —
  // a real-issued key never lives in a secrets detector's own fixture set, so
  // exempting it costs no real-secret recall.
  'apps/operator/scripts/hooks/cc/pretooluse-secrets-guard.mjs',
  // This scanner's OWN source. It is the one product file GUARANTEED to carry
  // credential-shape-adjacent text — the RULES regexes above, plus any comment
  // that documents a shape. The rules are hand-written to not self-match, but a
  // single explanatory comment containing a bare literal (a PEM header) is
  // enough to wedge the publish plane, and the offending blob then lives in the
  // range forever (proven 2026-07-20 — a comment on THIS very exemption did
  // exactly that). Exempt by exact path; the write-time PreToolUse secrets hook
  // + code review remain as defense, and a real secret does not live in a
  // scanner's source. Do NOT read this as license to exempt other product code.
  'packages/operator-core/lib/sync/pot-git/secrets-guard.ts',
  // A DIFFERENT subsystem's redactor test — same class, different owner. The
  // session-parts scrubber (`redactPartSecrets` / `cleanPartText`) can only be
  // tested with credential-shaped inputs, so its suite embeds them by
  // construction: AWS's own published example key, plus two 20-char hex
  // placeholders behind `api_key:` / `API_KEY=` (deliberately NOT reproduced
  // here, per the convention above — this scanner's source stays clean).
  // Those are fixtures, not issued credentials.
  // This wedged own-head publish on 2026-07-28 (head 8c0a625b4291 NOT published,
  // 2 findings at :130 and :165) — the same self-wedge the entries above
  // describe, arriving from a subsystem whose authors would never think to look
  // at this file. The general rule this makes explicit: ANY test of a
  // redaction/detection function is a fixture file, wherever it lives in the
  // tree. PREFER the runtime escape hatch (pot_git:secrets_exemptions) over
  // adding an entry here: as of WI-6641 it is reachable from an ORDINARY
  // workspace-scoped session (it was `workspace_forbidden` before — the reason
  // this static entry had to be hand-written and deployed while the publish
  // plane stayed frozen ~8h). A runtime exemption needs no code edit, no
  // restart and no deploy; it applies on the very next git-sync tick.
  'packages/operator-core/lib/search/session-turn-parts.test.ts',
  // The voice-credentials encryption-at-rest integration test: it intentionally
  // writes credential-SHAPED literals (`sk_eleven_...`, `sk_plaintext_...`) as
  // fixtures to prove the plaintext key never lands in the row. Its in-file
  // regression test asserts `scanForSecrets([...this file's CURRENT content])`
  // returns [] — but that only proves the scanner is happy with today's
  // wording; a HISTORICAL blob (commit b3279dba9f, before the fixture literal
  // was reworded to include a PLACEHOLDER_RE marker) contained
  // `sk_plaintext_supersecret_9999`, which the shape rules do flag, and that
  // blob is permanently inside the own-head publish range (EI-20191187592939864
  // froze publication on it 2026-08-11; cleared via a runtime path exemption).
  // Editing the CURRENT wording can never un-flag a blob already in history,
  // so — same as every other entry in this set — the fix is a PATH exemption,
  // not a content one. The runtime exemption for this exact path is retired
  // now that this static entry covers it permanently (EI-20216447367071456).
  'packages/operator-core/lib/voice-credentials.integration.test.ts',
]);

/** True if `path` is a designated credential-fixture file exempt from the scan. */
export function isFixtureFile(path: string): boolean {
  return FIXTURE_FILES.has(path);
}

/** Scan a set of changed files. `path` is used only for reporting + the .env
 *  heuristic; pass the NEW content of each changed/added file. Designated
 *  fixture files (isFixtureFile) are skipped — see FIXTURE_FILES. */
export function scanForSecrets(files: { path: string; content: string }[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const f of files) {
    if (isFixtureFile(f.path)) continue;
    out.push(...scanTextForSecrets(f.path, f.content));
  }
  return out;
}

/** True iff any changed file carries a secret — the publish path's fast gate. */
export function hasSecrets(files: { path: string; content: string }[]): boolean {
  return files.some((f) => !isFixtureFile(f.path) && scanTextForSecrets(f.path, f.content).length > 0);
}

/** A one-line operator message for a set of findings (secrets already masked). */
export function describeSecretFindings(findings: SecretFinding[]): string {
  if (findings.length === 0) return 'no secrets found';
  const head = findings
    .slice(0, 5)
    .map((f) => `${f.path}:${f.line} [${f.rule}] ${f.excerpt}`)
    .join('; ');
  const more = findings.length > 5 ? ` (+${findings.length - 5} more)` : '';
  return `refusing to publish — ${findings.length} secret(s): ${head}${more}`;
}
