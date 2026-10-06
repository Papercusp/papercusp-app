/**
 * new-hive-git-mode-default.ts — the configurable DEFAULT `hiveGit.mode` posture
 * for NEW shared coding hives (p2p-public-release-endgame P-503, WI-10004765).
 *
 * Today a freshly created pot has no `hiveGit.mode` row, so it reads `legacy`
 * (hive-git-mode.ts `readPotGitMode` → source:'absent'). P-503 is the decision
 * whether NEW shared coding hives should default to `bridged`. This module is
 * the seam that decision flips: a single workspace-level value,
 * `PotControlPolicy.newHiveGitMode` (the existing `operator_pot_control_policy`
 * JSONB row — no migration; `hive_settings` can't hold it because it requires an
 * existing Hive row), applied ONCE at pot creation.
 *
 * Posture as shipped: the value is UNSET ⇒ `legacy` ⇒ nothing is written, so
 * pot creation behaves byte-identically to before. There is NO automatic flip
 * after the canary soak [peer:su-3ee17ad9 09:47Z] — the release leader records
 * the P-503 decision and then sets the value (pot-control-policy writer).
 *
 * Invariants:
 *  - never OVERWRITES a mode that is already set on the hive (any source other
 *    than 'absent' is left alone — including 'malformed', which is an operator
 *    concern, not ours to paper over);
 *  - an invalid configured default is reported and ignored, never written;
 *  - best-effort: every failure folds into the outcome, never throws (the
 *    caller is pot creation, which must not fail on this).
 *
 * Both dependencies are LAZY-imported so this module stays off the db/registry
 * import graph until it actually runs (hive-git-mode.ts pulls the federated
 * settings store; pot-control-policy.ts arms a managed timer).
 */
import type { PotGitMode, PotGitModeRead } from './hive-git-mode';
import type { PotControlPolicy } from '../../pot-control-policy';

const VALID_MODES: readonly PotGitMode[] = ['legacy', 'bridged', 'p2p-only'];

export type NewHiveGitModeOutcome =
  | { applied: true; mode: PotGitMode }
  | { applied: false; reason: 'default-legacy'; mode: 'legacy' }
  | { applied: false; reason: 'already-set'; mode: PotGitMode; source: PotGitModeRead['source'] }
  | { applied: false; reason: 'invalid-default'; configured: unknown }
  | { applied: false; reason: 'error'; message: string };

export interface ApplyNewHiveGitModeDeps {
  readPolicy?: (workspaceId: string) => Promise<PotControlPolicy>;
  readMode?: (workspaceId: string, potHomeSlug: string) => Promise<PotGitModeRead>;
  setMode?: (workspaceId: string, potHomeSlug: string, mode: PotGitMode) => Promise<void>;
}

/**
 * Resolve the configured default. Unset ⇒ `legacy` (the shipped posture);
 * an unrecognised value ⇒ `null` (invalid — the caller reports and ignores it).
 */
export function resolveNewHiveGitModeDefault(policy: PotControlPolicy | null | undefined): PotGitMode | null {
  const v = policy?.newHiveGitMode;
  if (v === undefined || v === null) return 'legacy';
  return (VALID_MODES as readonly unknown[]).includes(v) ? (v as PotGitMode) : null;
}

/**
 * Apply the workspace's new-hive default mode to a JUST-CREATED pot home.
 * Call it only for a brand-new pot (never for an into-pot member add).
 */
export async function applyNewHiveGitModeDefault(
  workspaceId: string,
  potHomeSlug: string,
  deps: ApplyNewHiveGitModeDeps = {},
): Promise<NewHiveGitModeOutcome> {
  try {
    const readPolicy =
      deps.readPolicy ??
      (async (ws: string) => (await import('../../pot-control-policy')).readPotControlPolicy(ws));
    const policy = await readPolicy(workspaceId);
    const mode = resolveNewHiveGitModeDefault(policy);
    if (mode === null) return { applied: false, reason: 'invalid-default', configured: policy.newHiveGitMode };
    if (mode === 'legacy') return { applied: false, reason: 'default-legacy', mode: 'legacy' };

    const readMode =
      deps.readMode ??
      (async (ws: string, slug: string) => (await import('./hive-git-mode')).readPotGitMode(ws, slug));
    const current = await readMode(workspaceId, potHomeSlug);
    if (current.source !== 'absent') {
      return { applied: false, reason: 'already-set', mode: current.mode, source: current.source };
    }

    const setMode =
      deps.setMode ??
      (async (ws: string, slug: string, m: PotGitMode) => (await import('./hive-git-mode')).setPotGitMode(ws, slug, m));
    await setMode(workspaceId, potHomeSlug, mode);
    return { applied: true, mode };
  } catch (e) {
    return { applied: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
