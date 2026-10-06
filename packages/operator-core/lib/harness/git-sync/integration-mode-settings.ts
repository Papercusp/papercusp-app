/**
 * P-017 (pot-review-integration-mode-2026-10-05, D-007): the pot-settings READ of the
 * one question "Where should the agents' work go?" — the question (owner-approved
 * wording, repo name substituted, option availability) plus the pot's current answer.
 *
 * ONE implementation, two callers, so they cannot answer differently:
 *   - GET /harness/:slug/integration-mode (endpoint-route/routes/harness/integration-mode.ts);
 *   - the `potIntegration.settings` sync query the settings section reads live
 *     (EI-25188362216785598 — it used to be a one-shot fetch that never refreshed
 *     after a save made elsewhere).
 *
 * Deps are injected so tests supply the registry, the setting read and the suite resolver.
 */
import { repoHasSubmodules, type PotIntegrationMode, type PotIntegrationModeRead } from './pot-integration-mode';
import { integrationModeQuestion, type IntegrationModeQuestion } from './integration-mode-question';

/** The registry fields this read uses (a subset of the harness registry entry). */
export interface IntegrationModeRegistryEntry {
  slug: string;
  hive_slug?: string;
  self_repo?: boolean;
  github_remote?: string;
  fork_remote?: string;
  /** The pot's checkout; read for `.gitmodules` (WI-10006107). */
  path?: string;
}

export interface IntegrationModeSettingsDeps {
  loadProjects: () => Promise<IntegrationModeRegistryEntry[]>;
  workspaceId: () => Promise<string>;
  readMode: (workspaceId: string, potHomeSlug: string) => Promise<PotIntegrationModeRead>;
  resolveSuite: (slug: string, workspaceId: string) => Promise<string | null>;
}

/** "owner/repo" for a GitHub remote; the raw remote otherwise; '' when absent. */
export function repoLabelFromRemote(remote: string | undefined | null): string {
  if (!remote) return '';
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : remote.trim();
}

export type IntegrationModePotResolution =
  | { kind: 'unknown-harness' }
  | { kind: 'not-a-pot' }
  | { kind: 'pot'; entry: IntegrationModeRegistryEntry; potHomeSlug: string };

/** Which pot (if any) a harness slug belongs to — the pot home slug holds the setting. */
export async function resolveIntegrationModePot(
  deps: Pick<IntegrationModeSettingsDeps, 'loadProjects'>,
  slug: string,
): Promise<IntegrationModePotResolution> {
  const entry = (await deps.loadProjects()).find((p) => p.slug === slug);
  if (!entry) return { kind: 'unknown-harness' };
  const potHomeSlug = entry.hive_slug ?? (entry.self_repo ? entry.slug : undefined);
  if (!potHomeSlug) return { kind: 'not-a-pot' };
  return { kind: 'pot', entry, potHomeSlug };
}

export interface IntegrationModeSettingsState {
  question: IntegrationModeQuestion;
  current: PotIntegrationMode;
  workingCopyUrl: string | null;
}

export type IntegrationModeSettingsRead =
  | { kind: 'unknown-harness' }
  | { kind: 'not-a-pot' }
  | ({ kind: 'pot' } & IntegrationModeSettingsState);

/** The settings question for a harness slug, plus the pot's current answer. */
export async function readIntegrationModeSettings(
  deps: IntegrationModeSettingsDeps,
  slug: string,
): Promise<IntegrationModeSettingsRead> {
  const r = await resolveIntegrationModePot(deps, slug);
  if (r.kind !== 'pot') return r;
  const ws = await deps.workspaceId();
  // Unknown (resolver failed) leaves the working copy selectable; the PUT re-checks.
  const greenCmd = await deps.resolveSuite(r.entry.slug, ws).catch(() => undefined);
  const hasTestSuite = greenCmd === undefined ? undefined : Boolean(greenCmd && greenCmd.trim());
  const current = await deps.readMode(ws, r.potHomeSlug);
  return {
    kind: 'pot',
    question: integrationModeQuestion({
      repoLabel: repoLabelFromRemote(r.entry.github_remote),
      hasTestSuite,
      hasSubmodules: repoHasSubmodules(r.entry.path),
    }),
    current: current.mode,
    workingCopyUrl: r.entry.fork_remote ?? null,
  };
}

/** Production wiring: the harness registry, the active workspace, pot_settings, the pot's suite. */
export const defaultIntegrationModeSettingsDeps: IntegrationModeSettingsDeps = {
  loadProjects: async () => (await import('../../harness-registry')).loadHarnessRegistry().then((r) => r.projects),
  workspaceId: async () => (await import('../../workspace-registry')).activeWorkspaceId(),
  readMode: async (ws, pot) => (await import('./pot-integration-mode')).readPotIntegrationMode(ws, pot),
  resolveSuite: async (slug, ws) => (await import('../routines/hive-release-env')).resolvePotSuiteCommand(slug, ws),
};
