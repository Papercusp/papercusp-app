/** CLI payload for the detached system:gym-cycle service (EI-240). */
import { runWithWorkspace } from '../workspace-als';
import { isCliEntry } from '../util/cli-entry';
import { runGymCycleInline } from '../harness/routines/gym-actions';

export function parseGymCycleRunArgs(argv: readonly string[]): { workspaceId: string } {
  const equalsArg = argv.find((arg) => arg.startsWith('--workspace-id='));
  const flagIndex = argv.indexOf('--workspace-id');
  const raw = equalsArg?.slice('--workspace-id='.length) ?? (flagIndex >= 0 ? argv[flagIndex + 1] : undefined);
  const workspaceId = raw?.trim();
  if (!workspaceId) {
    throw new Error('gym-cycle-run requires --workspace-id <workspace>');
  }
  return { workspaceId };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const { workspaceId } = parseGymCycleRunArgs(argv);
  console.log(`[gym-cycle] detached service starting for workspace ${workspaceId}`);
  await runWithWorkspace(workspaceId, () => runGymCycleInline(workspaceId));
}

if (isCliEntry(import.meta.url)) {
  void main().catch((error) => {
    console.error(`[gym-cycle] detached service failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
