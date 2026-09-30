/**
 * WI-10004151 part 2 — admit-time dependency-generation prediction for the frozen repair queue.
 *
 * A repair admission that changes a dependency input (a lockfile or a patch-package patch) moves
 * repairHead onto an input fingerprint the gate must MATERIALISE before it can judge anything:
 * `dependency-generation.sh --ensure-ref <repairHead>`. When no installed tree can produce that
 * fingerprint, verification parks with an inconclusive hold an hour later (repairHead 5955f82b,
 * 2026-09-30). `release:repair-queue admit` therefore asks the SAME script, before publishing,
 * whether that ensure would succeed right now (`--predict-ref`), so an unbuildable lock is refused
 * at the door with the reason instead of discovered by the gate.
 *
 * The verdict is computed by the shell, never re-derived here: `--predict-ref` shares its staging
 * and equivalence step with the exact-ref builder, so the prediction and the build cannot drift.
 * This module only decides WHETHER to ask (the path filter) and parses the answer.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

/** What `--ensure-ref <ref>` would do right now; `unknown` = the prediction itself failed. */
export type DependencyPredictionVerdict = 'prewarmed' | 'live-match' | 'buildable' | 'refused' | 'unknown';

export interface DependencyGenerationPrediction {
  verdict: DependencyPredictionVerdict;
  /** The commit whose inputs were judged (the built admission commit). */
  ref: string;
  /** The admitted paths that made the prediction necessary. */
  paths: string[];
  inputFingerprint: string | null;
  liveFingerprint: string | null;
  /** Live-only workspace links the exact-ref builder will drop (buildable only). */
  droppedLinks: number | null;
  /** Why the ref cannot be built from the live trees (refused only). */
  reasons: string[];
  /** Why no verdict could be produced (unknown only). */
  detail?: string;
  durationMs: number;
}

/**
 * Mirrors `dependency_generation_input_manifest_ref`'s path filter: lockfiles, plus patch-package
 * patches under any `patches/` directory (WI-10002299), outside `.papercusp` and `node_modules`.
 */
export function isDependencyInputPath(rel: string): boolean {
  const normalized = rel.replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.slice(0, -1).some((segment) => segment === '.papercusp' || segment === 'node_modules')) {
    return false;
  }
  const base = segments[segments.length - 1] ?? '';
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') return true;
  return base.endsWith('.patch') && (normalized.startsWith('patches/') || normalized.includes('/patches/'));
}

const PREDICTION_LINE =
  /^DEPENDENCY_GENERATION_PREDICTION\s+schema=1\s+ref=([0-9a-f]{40,64})\s+input=([0-9a-f]{64})\s+live=([0-9a-f]{64})\s+verdict=(prewarmed|live-match|buildable|refused)\s+links=(\d+)\s*$/;
const REASON_PREFIX = 'DEPENDENCY_GENERATION_PREDICTION_REASON ';

/** Parse `--predict-ref` stdout. `null` when no well-formed line names `expectedRef`. */
export function parseDependencyGenerationPrediction(
  stdout: string,
  expectedRef: string,
): Pick<DependencyGenerationPrediction, 'verdict' | 'inputFingerprint' | 'liveFingerprint' | 'droppedLinks' | 'reasons'> | null {
  let parsed: ReturnType<typeof parseDependencyGenerationPrediction> = null;
  const reasons: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith(REASON_PREFIX)) {
      reasons.push(line.slice(REASON_PREFIX.length));
      continue;
    }
    const match = PREDICTION_LINE.exec(line);
    if (!match || match[1]!.toLowerCase() !== expectedRef.toLowerCase()) continue;
    parsed = {
      verdict: match[4] as DependencyPredictionVerdict,
      inputFingerprint: match[2]!,
      liveFingerprint: match[3]!,
      droppedLinks: Number(match[5]),
      reasons: [],
    };
  }
  if (!parsed) return null;
  return { ...parsed, reasons: parsed.verdict === 'refused' ? reasons : [] };
}

export type PredictionCommand = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;

const execPrediction: PredictionCommand = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          ...(error && code === null ? { error: error.killed ? `timed out after ${options.timeoutMs}ms` : error.message } : {}),
        });
      },
    );
  });

/**
 * Bound on one prediction: a ref walk plus a lockfile comparison, never an install (measured
 * 12.6 s for a live-match on the shared tree at load ~90, 2026-09-30). It runs INSIDE an admit
 * tool call, which must answer well under the MCP transport ceiling, so a slow prediction is
 * cut to `unknown` (the gate still discovers the truth) rather than timing the whole admit out.
 */
export const DEPENDENCY_PREDICTION_TIMEOUT_MS = 30_000;

/**
 * Ask `dependency-generation.sh --predict-ref <ref>` in the canonical integration root. Never
 * throws; a failed prediction is `verdict:'unknown'` with the reason, which callers must not
 * read as buildable OR as refused.
 */
export async function predictDependencyGeneration(input: {
  integrationRoot: string;
  ref: string;
  paths: readonly string[];
  run?: PredictionCommand;
  timeoutMs?: number;
  nowMs?: () => number;
}): Promise<DependencyGenerationPrediction> {
  const now = input.nowMs ?? Date.now;
  const started = now();
  const script = path.join(input.integrationRoot, 'apps/operator/bin/release/dependency-generation.sh');
  const base = {
    ref: input.ref,
    paths: [...input.paths],
    inputFingerprint: null,
    liveFingerprint: null,
    droppedLinks: null,
    reasons: [] as string[],
  };
  let result: Awaited<ReturnType<PredictionCommand>>;
  try {
    result = await (input.run ?? execPrediction)(
      'bash',
      [script, '--integration', input.integrationRoot, '--predict-ref', input.ref],
      { cwd: input.integrationRoot, timeoutMs: input.timeoutMs ?? DEPENDENCY_PREDICTION_TIMEOUT_MS },
    );
  } catch (err) {
    return { ...base, verdict: 'unknown', detail: (err as Error).message, durationMs: now() - started };
  }
  const parsed = result.code === 0 ? parseDependencyGenerationPrediction(result.stdout, input.ref) : null;
  if (!parsed) {
    const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-6).join(' | ').slice(0, 800);
    return {
      ...base,
      verdict: 'unknown',
      detail:
        result.code === 0
          ? `dependency-generation.sh --predict-ref printed no prediction for ${input.ref}: ${tail}`
          : `dependency-generation.sh --predict-ref exited ${result.code ?? 'abnormally'}${result.error ? ` (${result.error})` : ''}: ${tail}`,
      durationMs: now() - started,
    };
  }
  return { ...base, ...parsed, durationMs: now() - started };
}

/** One sentence for a response `note`/`nextAction`; `null` when nothing needs saying. */
export function describeDependencyPrediction(prediction: DependencyGenerationPrediction): string | null {
  const fp = prediction.inputFingerprint?.slice(0, 16) ?? '?';
  switch (prediction.verdict) {
    case 'prewarmed':
    case 'live-match':
      return null;
    case 'buildable':
      return (
        ` Dependency inputs changed (${prediction.paths.join(', ')}): no generation exists yet for fingerprint ${fp}; ` +
        `the gate's --ensure-ref builds it from the live trees (${prediction.droppedLinks ?? 0} live-only link(s) dropped) before verifying — expect that tick to take longer.`
      );
    case 'refused':
      return (
        ` Dependency inputs changed (${prediction.paths.join(', ')}) to fingerprint ${fp}, which NO installed tree can produce: ` +
        prediction.reasons.slice(0, 5).join('; ') +
        (prediction.reasons.length > 5 ? `; (+${prediction.reasons.length - 5} more)` : '') +
        '.'
      );
    case 'unknown':
      return ` ⚠ Dependency inputs changed (${prediction.paths.join(', ')}) but buildability could not be predicted: ${prediction.detail ?? 'no detail'}.`;
  }
}
