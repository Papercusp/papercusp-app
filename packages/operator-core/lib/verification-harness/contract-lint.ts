/**
 * R-10 (expensive-verification-loops-2026-09-29, P-006): a new slow harness cannot skip the
 * verification-harness contract.
 *
 * A "long-running harness" is a script in one of HARNESS_SCAN_DIRS whose file-name stem has a
 * HARNESS_NAME_TOKENS token (verify, drill, e2e, smoke, rehearsal, battery, soak, scenario).
 * Such a script must declare the contract: a shell script sources
 * libs/generic/verification-harness/bin/vh.sh and calls `vh_init`; a JS/TS script imports
 * @papercusp/verification-harness and calls `runHarness(`.
 *
 * Scripts that predate the contract are listed in contract-lint-allowlist.json, each with a
 * reason. The allowlist only shrinks:
 * - a harness that is neither conforming nor listed is a finding (`missing-contract`);
 * - a listed harness that now declares the contract is a finding (`allowlisted-but-conforming`);
 * - a listed path that is missing or no longer harness-named is a finding (`allowlist-entry-stale`).
 * `measureNonConforming(repoRoot)` returns the live non-conforming set, which is where the
 * allowlist is re-seeded from. Never re-seed it from a hand-run grep.
 *
 * The guard runs as `lint:vh-contract` (operator-core), which affected-tests attaches to every
 * change under scripts/ and papercusp-desktop/bin/. That is how adding a script there runs it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const HARNESS_SCAN_DIRS = ['scripts', 'papercusp-desktop/bin', 'papercusp-desktop/bin/vm-rig'] as const;

export const HARNESS_NAME_TOKENS = [
  'verify',
  'drill',
  'e2e',
  'smoke',
  'rehearsal',
  'battery',
  'soak',
  'scenario',
] as const;

const HARNESS_EXT = /\.(sh|mjs|mts|ts)$/;
/** Tests, shell self-tests and type declarations are not harnesses. */
const NOT_A_HARNESS = /\.(test|spec|selftest)\.[a-z]+$|\.d\.mts$/;

export type ContractLintReason = 'missing-contract' | 'allowlisted-but-conforming' | 'allowlist-entry-stale';

export interface ContractLintFinding {
  path: string;
  reason: ContractLintReason;
  detail: string;
}

export interface HarnessSource {
  /** Repository-relative POSIX path. */
  path: string;
  content: string;
}

export function isLongRunningHarnessPath(relPath: string): boolean {
  const base = path.posix.basename(relPath);
  if (!HARNESS_EXT.test(base) || NOT_A_HARNESS.test(base)) return false;
  const tokens = base.replace(HARNESS_EXT, '').toLowerCase().split(/[-_.]/);
  return tokens.some((t) => (HARNESS_NAME_TOKENS as readonly string[]).includes(t));
}

/** Code lines only: a shell `#` comment or a `//` / `*` comment line cannot satisfy the contract. */
function codeLines(content: string): string[] {
  return content.split('\n').filter((l) => {
    const t = l.trim();
    return t !== '' && !t.startsWith('#') && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

export function declaresContract(relPath: string, content: string): boolean {
  const lines = codeLines(content);
  if (relPath.endsWith('.sh')) {
    return (
      lines.some((l) => l.includes('verification-harness/bin/vh.sh')) &&
      lines.some((l) => /^\s*vh_init\s+\S/.test(l))
    );
  }
  return (
    lines.some((l) => /from\s+['"]@papercusp\/verification-harness['"]/.test(l)) &&
    lines.some((l) => /\brunHarness\s*\(/.test(l))
  );
}

export function lintHarnessContracts(
  sources: readonly HarnessSource[],
  allowlist: Readonly<Record<string, string>>,
): ContractLintFinding[] {
  const findings: ContractLintFinding[] = [];
  const harnesses = new Set<string>();
  for (const src of sources) {
    if (!isLongRunningHarnessPath(src.path)) continue;
    harnesses.add(src.path);
    const listed = Object.hasOwn(allowlist, src.path);
    const conforming = declaresContract(src.path, src.content);
    if (conforming && listed) {
      findings.push({
        path: src.path,
        reason: 'allowlisted-but-conforming',
        detail: 'declares the contract now: remove its contract-lint-allowlist.json entry',
      });
    } else if (!conforming && !listed) {
      findings.push({
        path: src.path,
        reason: 'missing-contract',
        detail: src.path.endsWith('.sh')
          ? 'long-running harness without the contract: source libs/generic/verification-harness/bin/vh.sh, declare phases (vh_phase) and call vh_init'
          : 'long-running harness without the contract: run it through runHarness from @papercusp/verification-harness',
      });
    }
  }
  for (const [listedPath, reason] of Object.entries(allowlist)) {
    if (!harnesses.has(listedPath)) {
      findings.push({
        path: listedPath,
        reason: 'allowlist-entry-stale',
        detail: 'listed in contract-lint-allowlist.json but not a harness-named script in a scanned directory: remove the entry',
      });
    } else if (!reason.trim()) {
      findings.push({ path: listedPath, reason: 'allowlist-entry-stale', detail: 'allowlist entry has an empty reason' });
    }
  }
  return findings.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every harness-named script in the scan dirs (non-recursive per dir), with its content. */
export function collectHarnessSources(repoRoot: string): HarnessSource[] {
  const out: HarnessSource[] = [];
  for (const dir of HARNESS_SCAN_DIRS) {
    const abs = path.join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (!isLongRunningHarnessPath(rel)) continue;
      const file = path.join(abs, name);
      if (!statSync(file).isFile()) continue;
      out.push({ path: rel, content: readFileSync(file, 'utf8') });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The live non-conforming harness set: the only source the allowlist is re-seeded from. */
export function measureNonConforming(repoRoot: string): string[] {
  return collectHarnessSources(repoRoot)
    .filter((s) => !declaresContract(s.path, s.content))
    .map((s) => s.path);
}

export const CONTRACT_LINT_ALLOWLIST_FILE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'contract-lint-allowlist.json',
);

/**
 * The allowlist as path -> reason text. Each entry names a key in the file's `reasons` map; an
 * entry naming an unknown key resolves to '' so the lint reports it (an entry must say why).
 */
export function loadContractLintAllowlist(file: string = CONTRACT_LINT_ALLOWLIST_FILE): Record<string, string> {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    reasons?: Record<string, string>;
    entries?: Record<string, string>;
  };
  const reasons = parsed.reasons ?? {};
  const out: Record<string, string> = {};
  for (const [p, key] of Object.entries(parsed.entries ?? {})) {
    out[p] = Object.hasOwn(reasons, key) ? (reasons[key] ?? '') : '';
  }
  return out;
}
