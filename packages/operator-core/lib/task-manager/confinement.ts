/**
 * task-manager/confinement — "what confines this task, and therefore what can kill it?"
 *
 * P-023 asked for that question to become a READ instead of a shell excursion. Diagnosing
 * it by hand required `cat /proc/<pid>/cgroup`, and finding the pid required
 * `pgrep -f <ownerId>`, which self-matches the caller's own command line — the documented
 * `pkill -f` trap, returning the caller's pid as if it were the target's.
 *
 * ── WHY THIS IS A RESOLVER AND NOT A COLUMN READ (D-111) ─────────────────────
 *
 * The obvious implementation — surface the ledger's stored `cgroup_path` — ships a wrong
 * answer, which is why this module exists. `completeSyncEnrolment` wrote that column as an
 * unconditional `/proc/<client-pid>/cgroup` read while recording `confined: true`.
 * `systemd-run --scope` FORKS the payload, so that read returns the SPAWNER's cgroup, not
 * the task's. Measured 2026-09-02 over `harness_shared.task_ledger` (confined rows whose
 * stored path does not contain their own `scope_unit`):
 *
 *   agent-session 1326/2373 wrong · bash-job 2773/2856 · test-run 62/85
 *   sidecar 0/601 · desktop 0/142 · build 0/124 · deploy 0/3   ← the calibration
 *
 * The four zero classes go through `managed-spawn`, which derives the path (WI-37509). The
 * same predicate returns zero wherever the derivation is used, so it separates the mechanism
 * rather than measuring itself.
 *
 * That stored value is not merely imprecise. It is the PRE-EI-9748 answer: it names
 * `papercup-dev-api.service`, the operator's own cgroup, when EI-9748 Route A moved agent
 * sessions into `papercusp-agent-session.slice` precisely so an operator restart stops
 * killing them. A reader asking "would restarting :3070 kill this agent?" — the decision
 * this field governs — got YES from the ledger while kernel truth said NO.
 *
 * `enroll-sync` now derives the value at the write (WI-2141828), but ~1300 historical
 * agent-session rows are NOT retroactively repaired. D-111 is therefore binding on this
 * module: a read surface must never present a stored `cgroup_path` for a confined row as
 * current truth. So we do not read that column at all for confined tasks. We DERIVE, from
 * `scope_unit`, which was correct all along — and is correct for historical rows too, which
 * is why deriving beats the alternative of only reporting post-fix rows.
 *
 * ── WHY A DISCRIMINATED UNION ────────────────────────────────────────────────
 *
 * A confined task whose scope unit was never recorded has no derivable path. Returning
 * `cgroupPath: null` beside `confined: true` would read as "not confined" — the same class
 * of silent wrong answer, one level up. The union makes the three states structurally
 * distinct, so a caller reaches "unknown" only by handling it, never by forgetting a field.
 *
 * `insideOperatorCgroup` appears ONLY on the branch where both operands are known. It is
 * absent — not `false` — everywhere else, for the same reason.
 *
 * Not to be confused with `scope-class`, which classifies a SCANNED process (is this
 * out-of-slice process an escape or a lifetime we do not own?). This answers the inverse:
 * given a ledger ROW, where does it live?
 */
import { type CgroupFs, nodeCgroupFs, readProcessCgroupPath } from './cgroup-read';
import { deriveUserManagerRoot, scopeCgroupRelPath, type TaskClass } from './types';

/** The ledger fields this resolver reads. Deliberately NOT the stored `cgroupPath` for a
 *  confined row — see the module header. */
export interface ConfinementInput {
  confined: boolean;
  scopeUnit?: string | null;
  class: string;
  /** Only consulted for UNCONFINED tasks, where the spawn-time /proc read is correct. */
  cgroupPath?: string | null;
  unconfinedReason?: string | null;
}

export type TaskConfinement =
  | {
      confined: true;
      cgroupPath: string;
      scopeUnit: string;
      /** Derived from `scope_unit` + class, so it is correct for pre-WI-2141828 rows too. */
      source: 'derived-from-scope-unit';
      /** True ⇒ an operator restart takes this task down with it. */
      insideOperatorCgroup: boolean;
    }
  | {
      confined: true;
      cgroupPath: null;
      scopeUnit: null;
      /** Confined, but nothing to derive from. NOT the same as unconfined. */
      source: 'not-derivable';
      reason: string;
    }
  | {
      confined: false;
      cgroupPath: string | null;
      scopeUnit: null;
      /** The spawn-time /proc read, which is correct when nothing forked a scope. */
      source: 'recorded-at-spawn';
      reason: string;
    };

/**
 * Resolve one ledger row's confinement.
 *
 * `fs` is injectable so tests can drive the operator's own cgroup read; production callers
 * take the default.
 */
export function resolveTaskConfinement(row: ConfinementInput, fs: CgroupFs = nodeCgroupFs): TaskConfinement {
  const ownCgroupPath = readProcessCgroupPath(process.pid, fs);

  if (!row.confined) {
    return {
      confined: false,
      cgroupPath: row.cgroupPath ?? null,
      scopeUnit: null,
      source: 'recorded-at-spawn',
      reason:
        row.unconfinedReason ??
        'not cgroup-confined: it lives in whatever cgroup its spawner did, so its spawner’s lifetime is its own',
    };
  }

  const scopeUnit = row.scopeUnit ?? null;
  if (!scopeUnit) {
    return {
      confined: true,
      cgroupPath: null,
      scopeUnit: null,
      source: 'not-derivable',
      reason:
        'confined, but no scope unit was recorded, so its cgroup path cannot be derived — this is UNKNOWN, not unconfined',
    };
  }

  const cgroupPath = scopeCgroupRelPath(deriveUserManagerRoot(ownCgroupPath), row.class as TaskClass, scopeUnit);
  return {
    confined: true,
    cgroupPath,
    scopeUnit,
    source: 'derived-from-scope-unit',
    insideOperatorCgroup: isInside(cgroupPath, ownCgroupPath),
  };
}

/** Containment in the cgroup hierarchy: `a` is inside `b` when it IS `b` or sits beneath it.
 *  Compared segment-wise so `…/papercusp-agent.slice` is never read as inside
 *  `…/papercusp-agent-session.slice`'s prefix by accident. */
function isInside(path: string, ancestor: string | null): boolean {
  if (!ancestor) return false;
  const norm = (p: string) => p.replace(/\/+$/, '');
  const a = norm(path);
  const b = norm(ancestor);
  return a === b || a.startsWith(`${b}/`);
}
