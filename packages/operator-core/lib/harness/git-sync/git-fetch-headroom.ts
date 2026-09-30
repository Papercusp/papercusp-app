import { isAbsolute } from 'node:path';
import {
  criticalWriteHeadroomBytes,
  diskPolicyFromEnv,
  sampleDiskSnapshots,
  type DiskSnapshot,
} from '../../storage/disk-space-alarm';

type GitResult = { code: number; stdout: string; stderr: string };

/** Fetches can exceed their initial free-space sample. Keep the existing critical
 * write reserve on the actual object-store filesystem, including linked worktrees.
 * Cancellation is only a request: the runner must confirm process exit before this
 * wrapper returns and its caller cleans partial packs or releases repository locks. */
export async function withGitFetchHeadroom(
  args: string[],
  run: (args: string[], signal?: AbortSignal) => Promise<GitResult>,
  signal?: AbortSignal,
  sample: (paths: string[]) => Promise<DiskSnapshot[]> = sampleDiskSnapshots,
): Promise<GitResult> {
  let command = 0;
  while (command < args.length && args[command]!.startsWith('-')) {
    const option = args[command++]!;
    if (option === '-c' || option === '-C' || option === '--git-dir' || option === '--work-tree') command++;
  }
  if (!['fetch', 'pull'].includes(args[command] ?? '')) return run(args, signal);
  const refused = (stderr: string): GitResult => ({ code: -1, stdout: '', stderr });
  if (signal?.aborted) return refused('git aborted before fetch');
  const objects = await run([
    ...args.slice(0, command), 'rev-parse', '--path-format=absolute', '--git-path', 'objects',
  ], signal);
  const path = objects.stdout.trim();
  if (objects.code !== 0 || !isAbsolute(path) || path.includes('\n')) {
    return refused(`git fetch disk headroom unmeasured: cannot resolve object store; ${objects.stderr}`);
  }
  const policy = diskPolicyFromEnv();
  async function refusal(): Promise<string | null> {
    try {
      const snapshot = (await sample([path]))[0];
      if (!snapshot || !Number.isFinite(snapshot.totalBytes) || snapshot.totalBytes <= 0 ||
          !Number.isFinite(snapshot.freeBytes) || snapshot.freeBytes < 0) {
        return `git fetch disk headroom unmeasured at ${path}`;
      }
      const reserve = criticalWriteHeadroomBytes(snapshot.totalBytes, policy);
      return snapshot.freeBytes <= reserve
        ? `git fetch stopped for disk headroom at ${path}: ${snapshot.freeBytes} bytes available; critical reserve ${reserve} bytes`
        : null;
    } catch (error) {
      return `git fetch disk headroom unmeasured at ${path}: ${String(error)}`;
    }
  }
  const initial = await refusal();
  if (initial) return refused(initial);
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let stopped = false;
  let diskFailure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    const problem = await refusal();
    if (stopped) return;
    if (problem) {
      diskFailure = problem;
      controller.abort(new Error(problem));
    } else {
      timer = setTimeout(() => void poll(), 500);
      timer.unref?.();
    }
  };
  timer = setTimeout(() => void poll(), 500);
  timer.unref?.();
  try {
    const result = await run(args, controller.signal);
    return diskFailure ? { ...result, code: -1, stderr: `${result.stderr}\n${diskFailure}` } : result;
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
