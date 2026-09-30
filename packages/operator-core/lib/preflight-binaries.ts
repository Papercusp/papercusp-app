/**
 * Shared probes for the agent CLIs, used by both `/api/desktop/preflight`
 * and `/api/desktop/setup-status`. The wizard sidebar status (from
 * setup-status) must agree with the StepAgents card (from preflight).
 *
 * ⚠ THE CANDIDATE LIST DOES NOT LIVE HERE — it is `agentBinaryCandidates`
 * in `agent-bin-detect.ts` (WI-39538). These probes and the settings page's
 * `detectBinaries()` answer the SAME question ("is this CLI installed?")
 * and used to keep two hand-maintained lists to do it; on 2026-08-16 both
 * lists were missing the location an installed, working codex was actually
 * in, and the two surfaces agreed only by both being wrong.
 *
 * What differs here is the PROBE, deliberately: these run `--version` and
 * require it to exit cleanly, which is stricter than the executable-bit
 * check `detectBinaries()` uses. The wizard is gating a user through an
 * install, so "the file is executable" is not good enough — it must RUN.
 * One list, two strengths of probe; add a location to the list, never here.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentBinaryCandidates } from './agent-bin-detect';

const exec = promisify(execFile);

async function tryProbe(path: string, timeoutMs = 3000): Promise<boolean> {
  try {
    await exec(path, ['--version'], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * PATH first, then every shared candidate location, each required to answer
 * `--version`. A dangling symlink fails the probe rather than counting as a
 * hit, which is what a bare existence check got wrong.
 */
async function detectViaProbe(bin: string): Promise<boolean> {
  if (await tryProbe(bin)) return true;
  for (const path of agentBinaryCandidates(bin)) {
    if (await tryProbe(path)) return true;
  }
  return false;
}

export async function detectClaude(): Promise<boolean> {
  return detectViaProbe('claude');
}

export async function detectOmp(): Promise<boolean> {
  return detectViaProbe('omp');
}

export async function detectCodex(): Promise<boolean> {
  return detectViaProbe('codex');
}
