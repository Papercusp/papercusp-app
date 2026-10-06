/**
 * WI-10005223: the frozen-repair ADMISSION git work, as serializable jobs.
 *
 * The admission builders (repair-head-admission, hunk-exact-admission, the two preflights,
 * judged-sha-containment) are synchronous on purpose: every step is a `spawnSync('git')`,
 * and a sync sequence cannot interleave with a second admission. Run on the operator's MAIN
 * thread, that same property blocked the event loop for the whole sequence — measured avg
 * 4.3-12.4s per admit, max 61.8s, past the sentinel's 20s wedge-kill threshold.
 *
 * This module does not change a single builder. It names each call the admit door makes as
 * a plain-data job and dispatches it to the UNCHANGED sync function, so the same code runs
 * either on a worker thread (admission-offthread.ts, the production path) or inline. Every
 * job input and result is structured-cloneable: the only non-data inputs the builders take —
 * the `git` runner and the `preflight` closure — are never sent. The worker always uses the
 * real git runner, and the preflight is rebuilt here from its plain spec.
 */
import {
  admitPathsOntoRepairHead,
  realAdmissionGit,
  retractAdmission,
  type AdmissionGitResult,
  type AdmissionOutcome,
  type AdmitPathsInput,
} from './repair-head-admission';
import {
  buildCommittedPatchSource,
  buildHunkExactSource,
  type BuildHunkExactSourceInput,
  type HunkExactSourceOutcome,
} from './hunk-exact-admission';
import { containmentForPaths } from './judged-sha-containment';
import { importCompletenessPreflight } from './admission-import-completeness';
import {
  chainAdmissionPreflights,
  lockfileManifestConsistencyPreflight,
} from './admission-lockfile-consistency';

/**
 * The admit door's preflight, as data. The door always chains the import-completeness check
 * and the lockfile/manifest consistency check against the same probe ref; only the ref and
 * the whole-blob cohort flag vary.
 */
export interface AdmissionPreflightSpec {
  probeRef: string;
  /** D-045: whole-blob admissions also close the same-source cohort. Omitted = forward check only. */
  enforceSourceCohort?: true;
}

type CommittedPatchInput = Omit<Parameters<typeof buildCommittedPatchSource>[0], 'git'>;
type RetractInput = Omit<Parameters<typeof retractAdmission>[0], 'git'>;

export type AdmissionJob =
  | { kind: 'git'; argv: string[]; cwd: string }
  | { kind: 'containment'; paths: string[]; judgedSha: string; root: string; branch: string }
  | { kind: 'committed-patch'; input: CommittedPatchInput }
  | { kind: 'hunk-exact'; input: Omit<BuildHunkExactSourceInput, 'git'> }
  | {
      kind: 'admit';
      input: Omit<AdmitPathsInput, 'git' | 'preflight'>;
      preflight: AdmissionPreflightSpec | null;
    }
  | { kind: 'retract'; input: RetractInput };

export interface AdmissionJobResults {
  git: AdmissionGitResult;
  containment: ReturnType<typeof containmentForPaths>;
  'committed-patch': ReturnType<typeof buildCommittedPatchSource>;
  'hunk-exact': HunkExactSourceOutcome;
  admit: AdmissionOutcome;
  retract: boolean;
}

export type AdmissionJobKind = AdmissionJob['kind'];
export type AdmissionJobOf<K extends AdmissionJobKind> = Extract<AdmissionJob, { kind: K }>;

/** Rebuild the admit door's preflight closure from its plain spec (on whichever thread runs the job). */
export function admissionPreflightFromSpec(
  root: string,
  spec: AdmissionPreflightSpec,
): NonNullable<AdmitPathsInput['preflight']> {
  return chainAdmissionPreflights(
    importCompletenessPreflight({
      root,
      probeRef: spec.probeRef,
      ...(spec.enforceSourceCohort ? { enforceSourceCohort: true } : {}),
    }),
    lockfileManifestConsistencyPreflight({ root, probeRef: spec.probeRef }),
  );
}

/** Run one job synchronously against the unchanged builders. Throws exactly what they throw. */
export function executeAdmissionJob<K extends AdmissionJobKind>(job: AdmissionJobOf<K>): AdmissionJobResults[K];
export function executeAdmissionJob(job: AdmissionJob): AdmissionJobResults[AdmissionJobKind] {
  switch (job.kind) {
    case 'git':
      return realAdmissionGit(job.argv, { cwd: job.cwd });
    case 'containment':
      return containmentForPaths(job.paths, job.judgedSha, job.root, undefined, job.branch);
    case 'committed-patch':
      return buildCommittedPatchSource(job.input);
    case 'hunk-exact':
      return buildHunkExactSource(job.input);
    case 'admit':
      return admitPathsOntoRepairHead({
        ...job.input,
        ...(job.preflight ? { preflight: admissionPreflightFromSpec(job.input.root, job.preflight) } : {}),
      });
    case 'retract':
      return retractAdmission(job.input);
    default: {
      const unknown: never = job;
      throw new Error(`unknown admission job kind: ${String((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

/** Wire messages between the host and the admission worker. */
export type AdmissionWorkerRequest = { id: number; job: AdmissionJob };
export type AdmissionWorkerResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: { name: string; message: string; stack?: string } };

/** Minimal port surface so the worker loop is testable without a real thread. */
export interface AdmissionJobPort {
  on(event: 'message', listener: (message: AdmissionWorkerRequest) => void): unknown;
  postMessage(message: AdmissionWorkerResponse): void;
}

/**
 * The worker-side loop: announce readiness (the host treats any failure BEFORE this as a load
 * failure, never as a job failure), then run each request to completion. A worker thread runs
 * one message handler at a time, so jobs never interleave — the builders' sync invariant holds.
 */
export function serveAdmissionJobs(port: AdmissionJobPort): void {
  port.on('message', (request) => {
    try {
      const value = executeAdmissionJob(request.job);
      port.postMessage({ type: 'result', id: request.id, ok: true, value });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      port.postMessage({
        type: 'result',
        id: request.id,
        ok: false,
        error: { name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}) },
      });
    }
  });
  port.postMessage({ type: 'ready' });
}
