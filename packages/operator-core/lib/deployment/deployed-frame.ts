/**
 * Registry-backed deployed-frame lookup — shared by the live-view poller
 * (`frame-view.ts`) and the VNC session service (`frame-vnc.ts`), which would
 * otherwise import-cycle through each other
 * (`hive-frame-desktops-live-view-2026-06-06` P-005/P-008).
 */
import type { DeploymentConfig, Frame } from '@papercusp/deployment-driver';

export async function loadDeployedFrame(
  slug: string,
  workspaceId: string,
): Promise<{ frame: Frame; config: DeploymentConfig } | undefined> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const p = reg.projects.find((x) => x.slug === slug);
  if (!p?.deploymentFrame) return undefined;
  return { frame: p.deploymentFrame, config: p.deployment ?? { target: p.deploymentFrame.target } };
}
