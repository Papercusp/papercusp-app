/**
 * Modality-1 (offline diff-batch) {@link OfficialGrader} backend for SWE-Lancer IC-SWE tasks (feasibility
 * doc §6, D-011). IC-SWE: the model produces a patch; grading applies it + runs the task's Playwright
 * end-to-end suite in the SWE-Lancer unified Docker image; **RESOLVED iff the E2E suite passes.** This
 * reuses the P-005 M1 path (predictions JSON → official Docker grader → report) exactly. Each task carries a
 * `$payout` (BenchTask.valueUsd / graderMeta.payoutUsd) read by the L3 value-capture layer — a resolved task
 * captures its $. (SWE-Manager tasks are multiple-choice, NOT diff — excluded from this coding arm.)
 *
 * The exact SWE-Lancer eval CLI is README-authoritative (`openai/preparedness` → `project/swelancer`, MIT;
 * §6 says confirm at build time) → the invocation is a REQUIRED `buildEvalCommand` cfg, NOT a guessed
 * hardcode that would look authoritative. The grader STRUCTURE is built; the command is a wiring parameter.
 * Subprocess + fs are injected (testable with a fake eval — no Docker / Playwright images / GB pulls).
 */
import type { ArmSubmission, BenchTask, GradeResult, OfficialGrader } from '../types';
import type { GraderFs, ProcExec } from './swe-bench-pro';

const GRADER_FAMILY = 'swe-lancer';

interface RawInstanceResult {
  resolved?: boolean;
  error?: string;
  [k: string]: unknown;
}

export interface SweLancerGraderConfig {
  /** The `project/swelancer` dir (openai/preparedness checkout, MIT). */
  swelancerDir: string;
  /** Public split (default 'diamond' — the SWE-Lancer Diamond public split). */
  split?: string;
  /** Exact grader version pin (unified-image tag / preparedness commit) — required for pre-registration. */
  version: string;
  /** Scratch root for the predictions JSON + output dir (default OS temp). */
  workRoot?: string;
  /**
   * Build the eval subprocess invocation from the scratch paths. SWE-Lancer's CLI is README-authoritative
   * (§6: confirm at build time) → REQUIRED, not guessed. cwd defaults to `swelancerDir`.
   * e.g. ({ predsPath, outDir, split }) => ({ cmd: 'uv', args: ['run', 'python', '-m', 'swelancer.eval',
   *   `--predictions=${predsPath}`, `--output_dir=${outDir}`, `--split=${split}`] }).
   */
  buildEvalCommand: (ctx: { predsPath: string; outDir: string; split: string }) => {
    cmd: string;
    args: string[];
    cwd?: string;
  };
}

export interface SweLancerGraderDeps {
  exec: ProcExec;
  fs: GraderFs;
}

/**
 * Map the eval report (keyed by instance_id, or `${instance_id}__${prefix}` for multi-seed) onto the
 * submissions. A submission with no matching entry → `graderError` (ran but no verdict = infra failure,
 * NOT a silent fail). RESOLVED = the IC-SWE task's E2E suite passed.
 */
export function parseSweLancerReport(
  report: Record<string, RawInstanceResult> | { resolved?: string[]; [k: string]: unknown },
  submissions: ArmSubmission[],
  version: string,
): GradeResult[] {
  const resolvedList: Set<string> | null = Array.isArray((report as { resolved?: unknown }).resolved)
    ? new Set((report as { resolved: string[] }).resolved)
    : null;

  return submissions.map((sub): GradeResult => {
    const keyed = `${sub.instanceId}__${sub.prefix}`;
    const entry = ((report as Record<string, RawInstanceResult>)[keyed] ??
      (report as Record<string, RawInstanceResult>)[sub.instanceId]) as RawInstanceResult | undefined;

    if (entry && typeof entry === 'object' && entry.error) {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: false,
        rawGraderOutput: entry,
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
        graderError: String(entry.error),
      };
    }

    if (!entry && resolvedList === null) {
      return {
        instanceId: sub.instanceId,
        prefix: sub.prefix,
        resolved: false,
        rawGraderOutput: { missing: true },
        graderFamily: GRADER_FAMILY,
        graderVersion: version,
        graderError: 'no grader report entry for instance (E2E image / eval failure?)',
      };
    }

    const resolved =
      typeof entry?.resolved === 'boolean'
        ? entry.resolved
        : resolvedList !== null
          ? resolvedList.has(sub.instanceId)
          : false;

    return {
      instanceId: sub.instanceId,
      prefix: sub.prefix,
      resolved,
      rawGraderOutput: entry ?? { resolved },
      graderFamily: GRADER_FAMILY,
      graderVersion: version,
    };
  });
}

export function makeSweLancerGrader(cfg: SweLancerGraderConfig, deps: SweLancerGraderDeps): OfficialGrader {
  const { exec, fs } = deps;
  const split = cfg.split ?? 'diamond';
  const workRoot = cfg.workRoot ?? '/tmp';

  return {
    family: GRADER_FAMILY,
    modality: 'diff',
    async grade(submissions: ArmSubmission[], _tasks: BenchTask[]): Promise<GradeResult[]> {
      const diffSubs = submissions.filter((s): s is Extract<ArmSubmission, { modality: 'diff' }> => s.modality === 'diff');
      if (diffSubs.length === 0) return [];

      const scratch = await fs.mkdtemp(`${workRoot}/swelancer-grade-`);
      const predsPath = `${scratch}/predictions.json`;
      const outDir = `${scratch}/out`;
      try {
        await fs.writeFile(
          predsPath,
          JSON.stringify(diffSubs.map((s) => ({ instance_id: s.instanceId, patch: s.patch, prefix: s.prefix }))),
        );

        const { cmd, args, cwd } = cfg.buildEvalCommand({ predsPath, outDir, split });
        const { code, stderr } = await exec(cmd, args, { cwd: cwd ?? cfg.swelancerDir });

        let report: Record<string, RawInstanceResult> = {};
        let readErr: string | undefined;
        try {
          report = JSON.parse(await fs.readFile(`${outDir}/report.json`)) as Record<string, RawInstanceResult>;
        } catch (e) {
          readErr = `could not read SWE-Lancer report.json: ${e instanceof Error ? e.message : String(e)}`;
        }

        if (readErr) {
          const detail = code !== 0 ? `${readErr} (eval exit ${code}: ${stderr.slice(0, 500)})` : readErr;
          return diffSubs.map((s) => ({
            instanceId: s.instanceId,
            prefix: s.prefix,
            resolved: false,
            rawGraderOutput: { batchError: detail },
            graderFamily: GRADER_FAMILY,
            graderVersion: cfg.version,
            graderError: detail,
          }));
        }

        return parseSweLancerReport(report, diffSubs, cfg.version);
      } finally {
        await fs.rm(scratch).catch(() => {});
      }
    },
  };
}
