/**
 * Secret scrubber for `papercusp publish`.
 *
 * Scans plugin/install tarballs for accidentally-committed secrets before
 * upload to the marketplace. Blocks publish if anything is found unless
 * --acknowledge-secrets is passed (which substitutes ${SECRET_NAME}
 * placeholders for the matched values, leaving the published artifact
 * referenceable but unusable until the consumer fills in the secret).
 *
 * Patterns:
 *   - gitleaks-equivalent rules for common providers (AWS, GitHub, Stripe, etc.)
 *   - Anthropic / OpenAI / Cloudflare key shapes
 *   - Anything matching env-shaped lines (KEY=value where KEY ends in
 *     _KEY/_SECRET/_TOKEN/_PASSWORD)
 *
 * No external regex DB dependency — patterns are inlined for portability.
 */

export interface SecretFinding {
  /** Path of the file relative to the tarball root. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** Matched rule name. */
  rule: string;
  /** Brief preview (first 24 chars of the match, with rest masked). */
  preview: string;
  /** The full match — used by replaceSecretsWithPlaceholders. */
  match: string;
  /** Suggested placeholder name based on the match shape (or rule). */
  placeholderName: string;
}

interface Pattern {
  name: string;
  /** RegExp matching the secret. Should have one capture group when possible. */
  re: RegExp;
  /** Optional: extract a placeholder name from the match. Default: rule name. */
  placeholderFromMatch?: (m: RegExpExecArray) => string;
}

const PATTERNS: Pattern[] = [
  // ── Provider-specific ────────────────────────────────────────────────
  { name: 'aws-access-key',     re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'aws-secret-access-key', re: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/g },
  { name: 'github-pat',         re: /\bghp_[A-Za-z0-9]{36,}\b/g,
                                placeholderFromMatch: () => 'GITHUB_PAT' },
  { name: 'github-oauth',       re: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-installation', re: /\bghs_[A-Za-z0-9]{36,}\b/g },
  { name: 'github-app',         re: /\bghu_[A-Za-z0-9]{36,}\b/g },
  { name: 'stripe-live-key',    re: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
                                placeholderFromMatch: () => 'STRIPE_SECRET_KEY' },
  { name: 'stripe-test-key',    re: /\bsk_test_[A-Za-z0-9]{24,}\b/g },
  { name: 'anthropic-api-key',  re: /\bsk-ant-[A-Za-z0-9_-]{40,}\b/g,
                                placeholderFromMatch: () => 'ANTHROPIC_API_KEY' },
  { name: 'openai-api-key',     re: /\bsk-[A-Za-z0-9]{48,}\b/g,
                                placeholderFromMatch: () => 'OPENAI_API_KEY' },
  { name: 'cloudflare-api-token', re: /\bcfut_[A-Za-z0-9_-]{40,}\b/g,
                                  placeholderFromMatch: () => 'CLOUDFLARE_API_TOKEN' },
  { name: 'gcp-service-account', re: /"private_key":\s*"-----BEGIN (?:RSA )?PRIVATE KEY-----/g,
                                  placeholderFromMatch: () => 'GCP_SERVICE_ACCOUNT_JSON' },

  // ── Generic env-shaped (KEY=VALUE where KEY suggests a secret) ───────
  // Match: WORD_KEY=value or WORD_SECRET=value etc.
  // Excludes obvious placeholders: ${VAR}, $VAR, your_*_here, ...
  {
    name: 'env-shaped-secret',
    re: /\b([A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD|_PWD|_APIKEY))\s*[=:]\s*["']?([^\s"'`${}<>]{12,})["']?/g,
    placeholderFromMatch: (m) => m[1],
  },
  // Bearer tokens in Authorization headers / curl commands
  {
    name: 'bearer-token',
    re: /\bBearer\s+([A-Za-z0-9_.\-+/=]{30,})\b/gi,
    placeholderFromMatch: () => 'BEARER_TOKEN',
  },
  // JWT-looking strings (xxx.yyy.zzz with base64url segments). Ignore short ones.
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    placeholderFromMatch: () => 'JWT_TOKEN',
  },
  // Private key blocks
  {
    name: 'private-key-block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    placeholderFromMatch: () => 'PRIVATE_KEY',
  },
];

/**
 * Files we skip wholesale because they're either binary or known-safe.
 */
const SKIP_PATTERNS = [
  /\.png$/i, /\.jpe?g$/i, /\.gif$/i, /\.svg$/i, /\.pdf$/i, /\.ico$/i,
  /\.woff2?$/i, /\.ttf$/i, /\.eot$/i,
  /\.lock$/, /package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/,
  /node_modules\//, /\.git\//, /dist\//, /\.next\//, /out\//,
];

/**
 * Files we ALWAYS reject (env files etc — we'll never carry them through).
 */
const HARD_REJECT_PATTERNS = [
  /^\.env$/, /^\.env\..*/, /\/\.env$/, /\/\.env\..*/,
  /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/,
  /credentials\.json$/, /service-account.*\.json$/,
];

export interface ScanInput {
  /** File path relative to the tarball root. */
  path: string;
  /** File contents as string (or null if binary). */
  contents: string | null;
}

export interface ScanResult {
  findings: SecretFinding[];
  hardReject: { path: string; reason: string }[];
  scanned: number;
  skipped: number;
}

/**
 * Scan a list of files for secrets.
 *
 * Hard-rejected paths (env files, .pem, etc.) appear in `hardReject` —
 * publish should refuse regardless of --acknowledge-secrets.
 */
export function scanFilesForSecrets(files: ScanInput[]): ScanResult {
  const findings: SecretFinding[] = [];
  const hardReject: { path: string; reason: string }[] = [];
  let scanned = 0;
  let skipped = 0;

  for (const f of files) {
    if (HARD_REJECT_PATTERNS.some((re) => re.test(f.path))) {
      hardReject.push({ path: f.path, reason: 'hard-reject path (.env/.pem/credentials/etc)' });
      continue;
    }
    if (SKIP_PATTERNS.some((re) => re.test(f.path))) {
      skipped++;
      continue;
    }
    if (f.contents === null) { skipped++; continue; }

    scanned++;
    const lines = f.contents.split(/\r?\n/);
    for (const pattern of PATTERNS) {
      // Reset lastIndex since we use /g flag
      pattern.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.re.exec(f.contents)) !== null) {
        const matchStr = m[0];
        // Find which line this match is on
        const idx = m.index;
        let line = 1;
        let cur = 0;
        for (const lineStr of lines) {
          if (cur + lineStr.length >= idx) break;
          cur += lineStr.length + 1; // +1 for newline
          line++;
        }
        const placeholderName = pattern.placeholderFromMatch
          ? pattern.placeholderFromMatch(m)
          : pattern.name.toUpperCase().replace(/-/g, '_');
        findings.push({
          file: f.path,
          line,
          rule: pattern.name,
          preview: maskPreview(matchStr),
          match: matchStr,
          placeholderName,
        });
      }
    }
  }

  return { findings, hardReject, scanned, skipped };
}

/**
 * Replace every found match with `${PLACEHOLDER_NAME}` so the published
 * artifact retains structure but doesn't ship secrets.
 *
 * Returns updated file contents keyed by path. Files without findings are
 * not included (caller assumes original).
 */
export function replaceSecretsWithPlaceholders(
  files: ScanInput[],
  findings: SecretFinding[]
): Map<string, string> {
  const updated = new Map<string, string>();
  const byFile = new Map<string, SecretFinding[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push(f);
  }

  for (const f of files) {
    if (!byFile.has(f.path) || f.contents === null) continue;
    let content = f.contents;
    // Sort findings by length descending so we replace the longest first
    // (avoids partial-match issues if one secret is a substring of another).
    const fileFindings = byFile.get(f.path)!.slice().sort((a, b) => b.match.length - a.match.length);
    for (const finding of fileFindings) {
      content = content.split(finding.match).join('${' + finding.placeholderName + '}');
    }
    updated.set(f.path, content);
  }

  return updated;
}

function maskPreview(s: string): string {
  if (s.length <= 8) return '*'.repeat(s.length);
  if (s.length <= 24) return s.slice(0, 4) + '*'.repeat(s.length - 8) + s.slice(-4);
  return s.slice(0, 8) + '*'.repeat(16) + s.slice(-4);
}

/**
 * Format findings for human-readable CLI output.
 */
export function formatFindings(result: ScanResult): string {
  const lines: string[] = [];
  if (result.hardReject.length > 0) {
    lines.push('HARD-REJECTED PATHS (cannot be published):');
    for (const r of result.hardReject) {
      lines.push(`  ${r.path}  ─  ${r.reason}`);
    }
    lines.push('');
  }
  if (result.findings.length > 0) {
    lines.push(`SECRETS DETECTED in ${new Set(result.findings.map((f) => f.file)).size} file(s):`);
    for (const f of result.findings) {
      lines.push(`  ${f.file}:${f.line}  [${f.rule}]  ${f.preview}  →  \${${f.placeholderName}}`);
    }
    lines.push('');
    lines.push('Pass --acknowledge-secrets to replace these with placeholders before publishing.');
  } else if (result.hardReject.length === 0) {
    lines.push(`Scanned ${result.scanned} file(s); ${result.skipped} skipped (binary/lockfile/build artifact). No secrets found.`);
  }
  return lines.join('\n');
}
