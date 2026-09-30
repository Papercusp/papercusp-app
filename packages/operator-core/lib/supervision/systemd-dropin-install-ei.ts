/**
 * Durable condition for tracked user-systemd drop-ins missing from their units' DropInPaths.
 * Reuses the episodic escalation machinery already used by the supervision reconciler.
 */

import { createEpisodicEscalator, type EpisodicEiDeps } from '../escalation/episodic-ei';

export const SYSTEMD_DROP_IN_INSTALL_TOPIC = 'supervision-dropin-install';
export const SYSTEMD_DROP_IN_INSTALL_RECOVERY_OWNER = 'system:supervision-reconciler';

export interface SystemdDropInInstallEpisode {
  missingCount: number;
  entries: Array<{ unit: string; confName: string }>;
}

export interface SystemdDropInInstallRecovery {
  recovered: true;
}

export type SystemdDropInInstallEiDeps = EpisodicEiDeps<'major'>;

export function systemdDropInInstallEiTitle(): string {
  return '[supervision] tracked user systemd drop-ins are not loaded';
}

function buildBody(episode: SystemdDropInInstallEpisode): string {
  const rows = episode.entries.map((entry) => '- ' + entry.unit + ' <- ' + entry.confName).join('\n');
  return (
    'The periodic supervision-reconcile check found ' +
    episode.missingCount +
    ' tracked user-service drop-in(s) missing from their unit DropInPaths. Those units are running ' +
    'without configuration this repository expects.\n\n' +
    rows +
    '\n\nInstall the tracked files under ~/.config/systemd/user/<unit>.d, run systemctl --user ' +
    'daemon-reload, and restart a unit only when its drop-in header says that is safe. The check ' +
    'auto-resolves this condition after a later measured sample reports no missing drop-ins.'
  );
}

const escalator = createEpisodicEscalator<
  SystemdDropInInstallEpisode,
  SystemdDropInInstallRecovery,
  'major'
>({
  topic: SYSTEMD_DROP_IN_INSTALL_TOPIC,
  stableTitle: systemdDropInInstallEiTitle,
  buildBody,
  resolveNote: () => 'auto-resolved: all tracked user-systemd drop-ins are loaded by their units',
  severity: 'major',
  createdBy: SYSTEMD_DROP_IN_INSTALL_RECOVERY_OWNER,
  foundDuring: 'supervision-reconcile',
  recoveryOwner: SYSTEMD_DROP_IN_INSTALL_RECOVERY_OWNER,
  extraTopics: ['supervision'],
});

export function _resetSystemdDropInInstallEiForTests(): void {
  escalator._resetForTests();
}

export function fileSystemdDropInInstallEi(
  episode: SystemdDropInInstallEpisode,
  deps?: SystemdDropInInstallEiDeps,
): Promise<string | null> {
  return escalator.file(episode, deps);
}

export function resolveSystemdDropInInstallEi(
  recovery: SystemdDropInInstallRecovery = { recovered: true },
  deps?: SystemdDropInInstallEiDeps,
): Promise<string[]> {
  return escalator.resolve(recovery, deps);
}
