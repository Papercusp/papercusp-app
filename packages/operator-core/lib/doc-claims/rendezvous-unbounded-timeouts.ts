/**
 * WI-1194246 — the backup↔migration rendezvous must be unbounded in BOTH timeout
 * dimensions, and this pins that invariant to the code (P-004 doc-claims family,
 * sibling of `gate-candidate-ref.ts`).
 *
 * Two sites acquire the backup-migration advisory lock and deliberately wait as long
 * as it takes for the current holder to finish:
 *   - packages/operator-core/lib/db-boot-migrate.ts
 *   - packages/operator-core/lib/backup/configure.ts
 *
 * Both historically reset only `lock_timeout`. That is a HALF opt-out:
 * `statement_timeout` also cancels a `pg_advisory_lock` wait — verified empirically
 * 2026-08-30 (statement_timeout=1s against a held advisory lock aborts with
 * "canceling statement due to statement timeout"). The rendezvous was measured
 * waiting 253.7s and 118.4s on the live box.
 *
 * harness_admin carries no role-level `statement_timeout` TODAY, which is exactly why
 * this rots silently: the half opt-out is indistinguishable from a whole one until
 * someone adds the role default WI-1194246 proposes, at which point a valid in-flight
 * snapshot becomes a failed safety rail. The guard exists so that change cannot land
 * without these sites being correct first.
 */

/** One advisory-lock acquisition that is missing a timeout opt-out. */
export interface UnguardedAcquisition {
  /** 1-indexed line of the acquisition in the (comment-stripped) source. */
  line: number;
  /** Which resets were absent — e.g. `['statement_timeout']`. */
  missing: string[];
}

export interface RendezvousVerdict {
  ok: boolean;
  /** How many backup-migration advisory-lock acquisitions were found. */
  acquisitions: number;
  unguarded: UnguardedAcquisition[];
  violations: string[];
}

/** The advisory-lock key whose acquisitions this claim governs. */
const LOCK_KEY = 'BACKUP_MIGRATION_ADVISORY_LOCK_KEY';

/** How many preceding statement lines may carry the opt-out. */
const LOOKBACK_LINES = 12;

const RESETS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'lock_timeout', re: /\block_timeout\s*=\s*(['"]?)0\1(?![A-Za-z0-9_.])/ },
  { name: 'statement_timeout', re: /\bstatement_timeout\s*=\s*(['"]?)0\1(?![A-Za-z0-9_.])/ },
];

/**
 * Strip `//` and block comments so a RATIONALE that merely MENTIONS
 * `SET statement_timeout = 0` can never satisfy the guard — only real code does.
 */
export function stripCommentsForClaim(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/**
 * Judge a source file: every backup-migration advisory-lock ACQUISITION must be
 * preceded by both `lock_timeout = 0` and `statement_timeout = 0`.
 *
 * Only acquisitions count. `pg_advisory_unlock` is a release and needs no opt-out,
 * so a file containing only releases yields `acquisitions: 0`.
 */
export function judgeRendezvousTimeouts(source: string): RendezvousVerdict {
  const lines = stripCommentsForClaim(source).split('\n');
  const unguarded: UnguardedAcquisition[] = [];
  let acquisitions = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isAcquire =
      /pg_advisory(_xact)?_lock\s*\(/.test(line) &&
      !/pg_advisory(_xact)?_unlock/.test(line) &&
      line.includes(LOCK_KEY);
    if (!isAcquire) continue;
    acquisitions += 1;

    const window = lines.slice(Math.max(0, i - LOOKBACK_LINES), i).join('\n');
    const missing = RESETS.filter((r) => !r.re.test(window)).map((r) => r.name);
    if (missing.length > 0) unguarded.push({ line: i + 1, missing });
  }

  const violations = unguarded.map(
    (u) =>
      `line ${u.line}: backup-migration advisory-lock acquisition does not reset ${u.missing.join(' + ')} ` +
      `— a role-level ${u.missing.join('/')} would cancel this deliberately-unbounded rendezvous wait (WI-1194246)`,
  );

  return { ok: violations.length === 0, acquisitions, unguarded, violations };
}
