/**
 * Dispatcher-level restricted-hold skip for system actions that execute integration-tree code
 * (WI-10005745 — D-012 residue of WI-10005724, plan personal-data-reader-set-labels-2026-10-01).
 *
 * A session holding an active personal disclosure has no network (D-012), but code it wrote into
 * the shared tree would still RUN with the network if an unrestricted process executed it. On
 * bg-host several routines do exactly that: `cargo test`, tsx scripts, a CLI bin, the
 * green-checkpoint launcher. Each such action declares `executesIntegrationTreeCode: true` on
 * `registerSystemAction`, and both dispatchers (the durable routine workflow and the ephemeral
 * executor) ask this module before running it. A held write anywhere in the tree skips the fire;
 * the skip is recorded by the caller, never silent, and the action runs on its next fire after
 * the disclosure is released.
 */
import { resolve } from 'node:path';
import { restrictedTreeHoldRefusal } from '../../agent-tools/testing/restricted-hold-fence';
import type { RestrictedEditHolding } from '../../personal-vault/git-sync-hold';
import { moduleRepoRoot } from '../../module-repo-root';
import type { SystemActionEntry } from './system-actions';

/**
 * Every tree a declared action may execute from: the integration root the actions resolve
 * (`PAPERCUSP_INTEGRATION_ROOT`, else `<cwd>/../..`) and this module's own repo root (the root
 * `moduleRepoRoot(import.meta.url)` actions use). On bg-host both are the canonical shared tree.
 */
export function integrationTreeRoots(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  const roots = [env.PAPERCUSP_INTEGRATION_ROOT ?? resolve(cwd, '..', '..')];
  try {
    roots.push(moduleRepoRoot(import.meta.url));
  } catch {
    // No enclosing checkout (a packaged sidecar): the integration root is the only candidate.
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

export interface RestrictedTreeSkipDeps {
  roots?: string[];
  holdings?: (realRoot: string) => Promise<RestrictedEditHolding[]>;
}

/** `null` = run the action. A string = skip it; the string is the recorded reason. */
export async function restrictedTreeSkipReason(
  action: string,
  entry: Pick<SystemActionEntry, 'executesIntegrationTreeCode'> | undefined,
  deps: RestrictedTreeSkipDeps = {},
): Promise<string | null> {
  if (!entry?.executesIntegrationTreeCode) return null;
  const refusal = await restrictedTreeHoldRefusal(deps.roots ?? integrationTreeRoots(), { holdings: deps.holdings });
  return refusal ? `system:${action} skipped — ${refusal.error}: ${refusal.hint}` : null;
}
