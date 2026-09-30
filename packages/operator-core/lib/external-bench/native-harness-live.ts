/**
 * Live port bindings for Baseline B — the native-harness arm (P-007 / BRIEF 5). The runner
 * (./native-harness-runner.ts) is pure orchestration over injected ports; THIS file binds the real
 * I/O for production, mirroring `./clone.ts`'s `cloneTaskRepo`/`extractDiff` live exports. The pilot
 * (P-009) calls `liveNativeHarnessPorts()` and hands the ports to `runNativeHarnessAttempt`.
 *
 * The native harness is literally the `claude` CLI's own agent loop: `spawnAgent` = the shared
 * `runAgentChat` with `backend:'claude-code'`, and `harnessVersion` shells `claude --version` (the
 * exact harness build is pinned on the row for pre-registration). Trajectory persistence is the
 * reproducibility layer's job (P-010) — passed in by the pilot, omitted here.
 */
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgentChat } from '../agent-chat-stream';
import type { NativeHarnessPorts, PersistTrajectory } from './native-harness-runner';
import { cloneTaskRepo, extractDiff } from './clone';

const execFileP = promisify(execFileCb);

/** Run `<bin> --version` and return its trimmed output (e.g. '2.1.3 (Claude Code)'). */
export type VersionProbe = (bin: string) => Promise<string>;

const defaultVersionProbe: VersionProbe = async (bin) => {
  const { stdout } = await execFileP(bin, ['--version'], { timeout: 10_000 });
  return stdout.trim();
};

export interface LiveNativePortsOpts {
  /** The Claude Code binary (default: 'claude' on PATH). */
  claudeBin?: string;
  /** Persist a captured trajectory → rollout ref (P-010's reproducibility export). Omit → no ref. */
  persistTrajectory?: PersistTrajectory;
  /** Injected version probe (default: real `execFile`); lets a test avoid spawning `claude`. */
  versionProbe?: VersionProbe;
}

/**
 * Build the production {@link NativeHarnessPorts}: real git clone/diff (./clone), the real
 * `runAgentChat` claude-code spawn, and a real `claude --version` probe. `harnessVersion` is
 * best-effort — a probe failure yields 'claude-code/unknown' rather than aborting the run.
 */
export function liveNativeHarnessPorts(opts: LiveNativePortsOpts = {}): NativeHarnessPorts {
  const claudeBin = opts.claudeBin ?? 'claude';
  const probe = opts.versionProbe ?? defaultVersionProbe;
  return {
    clone: cloneTaskRepo,
    extractDiff,
    spawnAgent: (o) => runAgentChat(o),
    harnessVersion: async () => {
      try {
        const v = await probe(claudeBin);
        return v ? `claude-code/${v}` : 'claude-code/unknown';
      } catch {
        return 'claude-code/unknown';
      }
    },
    ...(opts.persistTrajectory ? { persistTrajectory: opts.persistTrajectory } : {}),
  };
}
