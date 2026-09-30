import { join } from 'node:path';

export const RESTORE_CLONE_DEADLINE_MS = 45_000;

export interface RestoreCloneArgs {
  kopiaSnapshotId: string;
  source?: string;
  target?: string;
  mode?: 'clone';
}

export interface RestoreCloneResult {
  targetPath: string;
  stillRunning?: boolean;
  note?: string;
}

interface RestoreCloneBackend {
  readonly workspaceRoot: string;
  restoreToClone(args: Omit<RestoreCloneArgs, 'mode'> & { mode?: 'clone' }): Promise<{ targetPath: string }>;
}

function cloneSlug(source: string): string {
  return source.replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
}

export function restoreCloneTarget(backend: Pick<RestoreCloneBackend, 'workspaceRoot'>, args: RestoreCloneArgs): string {
  const source = args.source ?? backend.workspaceRoot;
  return args.target ?? join(backend.workspaceRoot, '.restored', args.kopiaSnapshotId, cloneSlug(source));
}

/**
 * Run a clone restore without letting a long Kopia operation consume the
 * handler's transport budget. The restore is intentionally not cancelled
 * when the deadline wins; the returned target path is the durable polling
 * handle for the operation that continues in the background.
 */
export async function restoreCloneWithDeadline(
  backend: RestoreCloneBackend,
  args: RestoreCloneArgs,
  deadlineMs = RESTORE_CLONE_DEADLINE_MS,
): Promise<RestoreCloneResult> {
  const targetPath = restoreCloneTarget(backend, args);
  const restorePromise = Promise.resolve().then(() => backend.restoreToClone({ ...args, target: targetPath }));
  const observedRestore = restorePromise.then(
    (result) => ({ kind: 'completed' as const, result }),
    (error) => ({ kind: 'failed' as const, error }),
  );

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: 'timed_out' }>((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ kind: 'timed_out' }), deadlineMs);
    deadlineTimer.unref?.();
  });

  const winner = await Promise.race([observedRestore, deadline]);
  if (winner.kind === 'completed') {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    return winner.result;
  }
  if (winner.kind === 'failed') {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    throw winner.error;
  }

  // `observedRestore` consumes the rejection for process safety. This second
  // observer makes a late failure visible to live operator logs after the
  // structured continuation has already been returned to the caller.
  restorePromise.catch((error) => {
    // eslint-disable-next-line no-console
    console.warn(`[backup:restore] background clone restore for ${targetPath} failed after the handler deadline:`, error);
  });
  return {
    stillRunning: true,
    targetPath,
    note: 'Clone restore is still running in the background — poll backup:restore events or inspect the target path before deciding whether it failed. Do not retry while this restore is in flight.',
  };
}
