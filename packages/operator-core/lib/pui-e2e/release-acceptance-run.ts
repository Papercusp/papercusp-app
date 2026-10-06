/**
 * The installed-TUI release stage (pui-first-party-public-release P-012 / D-018).
 *
 *   candidate archive -> verified digest -> install.sh into a clean HOME
 *   -> production-operator PTY suites with PUI_BIN=<installed bin/pui>, one leg
 *      per engine, through release-acceptance-reporter
 *   -> checkReleaseAcceptance against the CANDIDATE's own UX contract and matrix
 *   -> <archive>.acceptance.json
 *
 * The verdict is what P-014/P-015 may publish on: an archive is releasable
 * only with a passing acceptance file for that same archive digest. The
 * committed compatibility.json never advertises anything (D-017).
 */
import { execFileSync, spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  checkReleaseAcceptance, detectPlatform, judgeEvidence, parseRequiredMatrix, REPO_ROOT,
  type AcceptanceMatrixFile, type Candidate, type EvidenceRow, type Verdict,
} from './release-acceptance';
import type { EvidenceFile } from './release-acceptance-reporter';
import { startDedicatedNativePg } from '@papercusp/test-config/pg';

/**
 * One dedicated native Postgres shared by every leg (WI-10004247 H4). Without
 * it each leg resolves the fleet's shared, reused Docker test-PG container,
 * which can be recreated between legs: rehearsal 0f06f9d5d6 lost every omp test
 * to `ECONNREFUSED 127.0.0.1:32785` after the claude leg had passed on the same
 * container. Docker container creation also stalls on this host
 * (WI-10003403). Host PG binaries need neither. A caller that already set
 * PAPERCUSP_TEST_PG_ADMIN_URL keeps its own server.
 */
async function startAcceptancePg(work: string): Promise<{ env: Record<string, string>; stop(): Promise<void> }> {
  if (process.env.PAPERCUSP_TEST_PG_ADMIN_URL) return { env: {}, stop: async () => {} };
  const pg = await startDedicatedNativePg({
    baseDir: work,
    settings: {
      max_connections: '500',
      fsync: 'off',
      synchronous_commit: 'off',
      full_page_writes: 'off',
      // Keep PostgreSQL logs in the collector so they do not interleave with
      // the acceptance leg's live stdout/stderr log.
      logging_collector: 'on',
    },
  });
  return { env: { PAPERCUSP_TEST_PG_ADMIN_URL: pg.getConnectionUri() }, stop: () => pg.stop() };
}

export const RELEASE_SUITES = [
  'packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts',
  'packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts',
];
/** The code that decides what counts; it must be the candidate's own copy. */
const ACCEPTANCE_SOURCES = [
  ...RELEASE_SUITES,
  'packages/operator-core/lib/pui-e2e/release-acceptance.ts',
  'packages/operator-core/lib/pui-e2e/release-acceptance-reporter.ts',
  'packages/operator-core/lib/pui-e2e/release-acceptance-run.ts',
];
const REPORTER = path.join(REPO_ROOT, 'packages/operator-core/lib/pui-e2e/release-acceptance-reporter.ts');
const VITEST = path.join(REPO_ROOT, 'node_modules/.bin/vitest');
const OPERATOR_CORE = path.join(REPO_ROOT, 'packages/operator-core');

export interface LoggedChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

/**
 * Run a child with stdout and stderr sent directly to a live log file. The file
 * is created before spawn and the child inherits its descriptor, so long test
 * legs remain observable while they run instead of only after exit.
 */
export function runChildWithLiveLog(
  command: string,
  args: string[],
  options: SpawnOptions,
  logPath: string,
): Promise<LoggedChildResult> {
  writeFileSync(logPath, `--- live child output started ${new Date().toISOString()} ---\n`);
  const logFd = openSync(logPath, 'a');
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, { ...options, stdio: ['ignore', logFd, logFd] });
  } catch (caught) {
    closeSync(logFd);
    const error = caught instanceof Error ? caught : new Error(String(caught));
    appendFileSync(logPath, `\n--- child spawn error: ${error.message} ---\n`);
    return Promise.resolve({ status: null, signal: null, error });
  }
  closeSync(logFd);

  return new Promise((resolve, reject) => {
    let processError: Error | null = null;
    child.once('error', (error) => { processError = error; });
    child.once('close', (status, signal) => {
      try {
        appendFileSync(logPath,
          `\n--- child exit: code=${status ?? 'null'} signal=${signal ?? 'none'}${processError ? ` error=${processError.message}` : ''} ---\n`);
        resolve({ status, signal, error: processError });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export interface RealLeg {
  /** PUI_REAL_BACKEND: claude | codex | omp. */
  backend: string;
  /** Pinned per D-012; omitted only where D-013 refuses a pin (OMP under account=auto). */
  model?: string;
  env?: Record<string, string>;
}

export interface RunOptions {
  archive: string;
  advertise: Array<{ platform: string; backend: string }>;
  real?: RealLeg[];
  /** Vitest -t pattern; the full release run leaves it unset. */
  testFilter?: string;
  suites?: string[];
  out?: string;
  work?: string;
  /** Test seam: the platform this run's evidence is recorded against. */
  platform?: string;
}

export interface RunResult {
  verdict: Verdict;
  out: string;
  legs: Array<{ engine: string; status: number | null; evidence: string; rows: number }>;
  stockMachines: StockMachineResult[];
  cloudDeviceStart: CloudDeviceStartResult;
  suiteProvenance: Array<{ file: string; candidateBlob: string | null; runBlob: string | null }>;
  runnerTree: { before: RunnerTree; after: RunnerTree };
}

export interface StockMachineResult {
  image: string;
  /**
   * True when the host could not start a container at all (the create/start
   * preflight refused), so the image never ran the candidate. That says
   * nothing about the binary: it must not stop the PTY legs, which need no
   * Docker, and the smoke is measured again after them (WI-10004247 run 7).
   */
  unmeasured?: boolean;
  status: number | null;
  output: string;
}

export interface CloudDeviceStartResult {
  endpoint: string;
  checkedAt: string;
  status: number | null;
  ok: boolean;
  problem: string | null;
}

/** F10: exercise the public ingress, which local portal tests cannot cover.
 * Persist only the verdict: device codes and verification links are credentials.
 */
export async function runCloudDeviceStartSmoke(origin = 'https://app.papercusp.com'): Promise<CloudDeviceStartResult> {
  const endpoint = new URL('/api/hosted/cli/device/code', origin).href;
  const result: CloudDeviceStartResult = {
    endpoint, checkedAt: new Date().toISOString(), status: null, ok: false, problem: null,
  };
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    result.status = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      result.problem = `HTTP ${response.status}; device authorization did not start`;
      return result;
    }
    const grant: unknown = await response.json();
    const row = grant as Record<string, unknown> | null;
    const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    const verificationUrl = (value: unknown) => {
      if (!nonempty(value)) return false;
      try { return new URL(value).origin === new URL(origin).origin; } catch { return false; }
    };
    result.ok = Boolean(row && row.ok === true && nonempty(row.deviceCode) && nonempty(row.userCode)
      && verificationUrl(row.verificationUri) && verificationUrl(row.verificationUriComplete)
      && typeof row.expiresIn === 'number' && row.expiresIn > 0
      && typeof row.interval === 'number' && row.interval > 0);
    if (!result.ok) result.problem = 'response did not contain a usable device authorization grant';
  } catch {
    // Never persist a response body or exception text that could include a code.
    result.problem = 'device authorization request failed, timed out, redirected, or returned invalid JSON';
  }
  return result;
}

/**
 * A 5xx, or no usable answer at all, says the public ingress was not serving at
 * that moment. It says nothing about whether the cloud refuses device starts:
 * WI-10004247 run 13 lost every leg to a single HTTP 502 at 01:12Z, and the same
 * endpoint answered 200 three times at 01:24Z. A 4xx or a malformed grant is a
 * measured refusal and stays one.
 */
export function cloudDeviceStartTransient(result: CloudDeviceStartResult): boolean {
  return !result.ok && (result.status === null || result.status >= 500);
}

/** Only a measured refusal skips the legs; the verdict refuses either way. */
export function cloudDeviceStartBlocksLegs(result: CloudDeviceStartResult): boolean {
  return !result.ok && !cloudDeviceStartTransient(result);
}

export const CLOUD_DEVICE_START_ATTEMPTS = 3;
const CLOUD_DEVICE_START_PAUSE_MS = 20_000;

/** Run the smoke, asking again after a pause while the failure is transient. */
export async function measureCloudDeviceStart(
  smoke: () => Promise<CloudDeviceStartResult> = () => runCloudDeviceStartSmoke(),
  attempts = CLOUD_DEVICE_START_ATTEMPTS,
  pauseMs = CLOUD_DEVICE_START_PAUSE_MS,
): Promise<CloudDeviceStartResult[]> {
  const history: CloudDeviceStartResult[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await smoke();
    history.push(result);
    if (!cloudDeviceStartTransient(result) || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  return history;
}

/**
 * Measure a transient failure once more, after the legs, as the stock smoke is.
 * The verdict judges the latest measurement; every attempt stays in the record.
 */
export async function remeasureCloudDeviceStart(
  history: CloudDeviceStartResult[], measure: () => Promise<CloudDeviceStartResult[]> = () => measureCloudDeviceStart(),
): Promise<CloudDeviceStartResult[]> {
  const latest = history[history.length - 1];
  return latest && cloudDeviceStartTransient(latest) ? [...history, ...await measure()] : history;
}

/** Whether a precheck taken before the legs should stop them. */
export function legsBlocked(stockMachines: StockMachineResult[], cloudDeviceStart: CloudDeviceStartResult): boolean {
  return stockMachinesBlockLegs(stockMachines) || cloudDeviceStartBlocksLegs(cloudDeviceStart);
}

const STOCK_LINUX_IMAGES = ['ubuntu:24.04', 'debian:stable-slim'];
/**
 * Per-attempt budget. It must separate a SLOW launch from a WEDGED one. On the
 * release host (2026-09-30, ~100 running containers) an ordinary first launch
 * took 24.6s and the next 1.4s, while the WI-10003403 wedge lasts 2-30 minutes.
 * A 20s budget refused every attempt of a healthy host (WI-10004239).
 */
export const DOCKER_START_PROBE_TIMEOUT_MS = 90_000;
const DOCKER_START_PROBE_ATTEMPTS = 3;
const PROBE_NAME_PREFIX = 'pui-release-preflight-';
type DockerRun = (args: string[], timeout: number) => { status: number | null; stdout?: string; error?: { message: string } };
const defaultDockerRun: DockerRun = (args, timeout) => spawnSync('docker', args, { encoding: 'utf8', timeout });
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Remove probe containers left behind by acceptance runs that have exited.
 *
 * A client killed on timeout does not cancel the daemon's create, so the
 * per-attempt `rm --force` can run before the container exists and the create
 * then completes into a Created container nothing removes (seen 2026-09-30:
 * eight of them from three runs). The name carries the creating pid, so a
 * container whose pid is gone is an orphan; a live pid may be a concurrent run
 * still probing, and its containers are left alone.
 */
export function sweepOrphanedProbeContainers(run: DockerRun = defaultDockerRun,
  pidAlive: (pid: number) => boolean = defaultPidAlive): string[] {
  const listed = run(['ps', '--all', '--filter', `name=${PROBE_NAME_PREFIX}`, '--format', '{{.Names}}'], 20_000);
  if (listed.status !== 0 || listed.error || !listed.stdout) return [];
  const orphans = listed.stdout.split('\n').map((line) => line.trim()).filter((name) => {
    const pid = Number(new RegExp(`^${PROBE_NAME_PREFIX}(\\d+)-`).exec(name)?.[1]);
    return Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid);
  });
  if (orphans.length) run(['rm', '--force', ...orphans], 60_000);
  return orphans;
}

/**
 * Detect a responsive daemon whose overlay create/start path is stalled.
 *
 * A wedged create path (WI-10003403) fails every attempt, so only an
 * all-attempts failure refuses. One slow launch on a loaded host is not a
 * wedge: the next attempt usually returns in seconds, and refusing on it threw
 * away whole acceptance runs (EI-24453068584648808). Each attempt is named so a
 * launch the client abandoned on timeout is removed rather than left behind in
 * the Created state, where `--rm` never reaches it; a removal that loses the
 * race with the daemon is caught by the next run's orphan sweep.
 */
export function probeDockerCreateStart(run: DockerRun = defaultDockerRun,
  pidAlive: (pid: number) => boolean = defaultPidAlive): string | null {
  // A fresh release host may not have the image yet. The stock smoke below
  // pulls it; the offline create/start probe applies only to an existing image.
  const image = STOCK_LINUX_IMAGES[0];
  const cached = run(['image', 'inspect', image], 5_000);
  if (cached.status !== 0 || cached.error) return null;
  sweepOrphanedProbeContainers(run, pidAlive);
  const failures: string[] = [];
  for (let attempt = 1; attempt <= DOCKER_START_PROBE_ATTEMPTS; attempt++) {
    const name = `${PROBE_NAME_PREFIX}${process.pid}-${Date.now()}-${attempt}`;
    const result = run(['run', '--rm', '--name', name, '--pull=never', '--network=none',
      '--entrypoint', '/bin/sh', image, '-c', 'true'], DOCKER_START_PROBE_TIMEOUT_MS);
    if (result.status === 0 && !result.error) return null;
    failures.push(`attempt ${attempt}/${DOCKER_START_PROBE_ATTEMPTS}: status ${result.status ?? 'none'}`
      + `${result.error ? `; ${result.error.message}` : ''}`);
    run(['rm', '--force', name], DOCKER_START_PROBE_TIMEOUT_MS);
  }
  return `Docker create/start preflight failed on all ${DOCKER_START_PROBE_ATTEMPTS} attempts `
    + `(${failures.join('; ')}). The daemon may answer docker info while container creation is stalled.`;
}
const STOCK_MACHINE_SCRIPT = `set -eu
mkdir -p "$HOME"
cd /candidate
./install.sh --yes
pui_version=$("$HOME/.local/bin/pui" --version)
printf '%s\\n' "$pui_version"
case "$pui_version" in
  *[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo 'pui --version did not print a version' >&2; exit 1 ;;
esac
doctor=$("$HOME/.local/bin/pui" doctor 2>&1) || :
printf '%s\\n' "$doctor"
case "$doctor" in
  *"PUI local install: OK"*) ;;
  *) echo 'pui doctor did not confirm the installed release' >&2; exit 1 ;;
esac
psu_version=$("$HOME/.local/bin/psu" --version)
printf '%s\\n' "$psu_version"
case "$psu_version" in
  "psu "[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo 'psu --version did not print a version' >&2; exit 1 ;;
esac`;

/**
 * Only a smoke that RAN and failed says the binary cannot start on stock
 * Linux. One the host never started is unmeasured, and skipping every PTY leg
 * for it threw away whole acceptance runs to a Docker stall on the host
 * (WI-10003403) that had nothing to do with the candidate.
 */
export function stockMachinesBlockLegs(machines: StockMachineResult[]): boolean {
  return machines.some((machine) => !machine.unmeasured && machine.status !== 0);
}

/**
 * Measure an unmeasured smoke once more, after the legs. The stalls seen on
 * the release host cleared within about half an hour, and the legs take
 * longer than that, so this usually turns a stall into a delay. A smoke that
 * ran is kept as it was.
 */
export function remeasureStockMachines(
  machines: StockMachineResult[], smoke: () => StockMachineResult[],
): StockMachineResult[] {
  return machines.some((machine) => machine.unmeasured) ? smoke() : machines;
}

/** The refusal a stock smoke contributes to the verdict, or null when it passed. */
export function stockMachineRefusal(machine: StockMachineResult): string | null {
  if (machine.unmeasured) {
    return `stock-machine smoke on ${machine.image} was not measured: the host could not start a container `
      + `before or after the legs: ${machine.output.slice(-1_000)}`;
  }
  return machine.status === 0
    ? null
    : `stock-machine smoke on ${machine.image} failed (status ${machine.status}): ${machine.output.slice(-1_000)}`;
}

/** Exercise the shipped unit on stock Linux, without host libraries or network. */
export function runStockMachineSmoke(
  unit: string, images = STOCK_LINUX_IMAGES, probe = probeDockerCreateStart,
): StockMachineResult[] {
  const dockerProblem = probe();
  if (dockerProblem) {
    return images.map((image) => ({ image, unmeasured: true, status: null, output: dockerProblem }));
  }
  return images.map((image) => {
    const run = spawnSync('docker', [
      'run', '--rm', '--pull=missing', '--network=none', '--read-only',
      '--tmpfs', '/tmp:rw,exec,mode=1777',
      '--mount', `type=bind,source=${realpathSync(unit)},target=/candidate,readonly`,
      '--env', 'HOME=/tmp/pui-home', '--env', 'TERM=dumb', '--env', 'PAPERCUSP_HONO_PORT=1',
      '--entrypoint', '/bin/sh', image, '-ec', STOCK_MACHINE_SCRIPT,
    ], { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 });
    return {
      image,
      status: run.status,
      output: `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`.slice(-8_000),
    };
  });
}

/** The checkout the stage ran from: its HEAD and every tracked path that differs from it. */
export interface RunnerTree {
  root: string;
  head: string | null;
  /** `git status --porcelain` lines for tracked changes, submodule pins and content included. */
  changed: string[];
  /** Set when git could not answer; the tree is then unmeasured, never assumed clean. */
  problem: string | null;
}

export function measureRunnerTree(root = REPO_ROOT): RunnerTree {
  const gitIn = (...args: string[]) => spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
  });
  const head = gitIn('rev-parse', 'HEAD');
  const status = gitIn('status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=untracked');
  const failed = [head, status].find((run) => run.status !== 0 || run.error);
  return {
    root,
    head: head.status === 0 ? head.stdout.trim() : null,
    changed: status.status === 0 ? status.stdout.split('\n').filter((line) => line.trim()) : [],
    problem: failed ? `git exited ${failed.status ?? 'none'}${failed.error ? `: ${failed.error.message}` : ''}: ${(failed.stderr ?? '').trim().slice(-500)}` : null,
  };
}

/**
 * Whether the run's own code was the candidate's (EI-24692155752067316). The
 * suites, the operator fixture they start, and every module those load come
 * from the runner's checkout, not the archive. ACCEPTANCE_SOURCES pins only the
 * suites and the runner, so a peer's mid-edit to operator-core or scripts/ in a
 * shared tree changed rehearsal 37bc2d4c32's legs without tripping it. Measured
 * before and after the legs, since an edit can land at any point in between.
 * apps/tui/scripts/release-acceptance.sh runs the stage from an isolated
 * checkout at the source commit, which passes both measurements.
 */
export function runnerTreeRefusals(tree: RunnerTree, sourceSha: string, when: string): string[] {
  if (tree.problem) return [`the runner checkout ${tree.root} could not be measured ${when} (${tree.problem}), so the evidence may describe other code`];
  const refusals: string[] = [];
  if (tree.head !== sourceSha) {
    refusals.push(`the runner checkout ${tree.root} was at ${tree.head ?? 'no commit'} ${when}, not the candidate source ${sourceSha}, `
      + 'so the suites and operator fixture ran other code (run apps/tui/scripts/release-acceptance.sh, which checks the candidate out in isolation)');
  }
  if (tree.changed.length) {
    const shown = tree.changed.slice(0, 5).map((line) => line.trim()).join('; ');
    refusals.push(`the runner checkout ${tree.root} had ${tree.changed.length} uncommitted tracked change(s) ${when} (${shown}`
      + `${tree.changed.length > 5 ? '; ...' : ''}), so the suites and operator fixture ran other code`);
  }
  return refusals;
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const git = (...args: string[]) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' }).trim();

function committed(sha: string, file: string): string | null {
  const run = spawnSync('git', ['-C', REPO_ROOT, 'show', `${sha}:${file}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

function blob(ref: string | null, file: string): string | null {
  const run = ref
    ? spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', '--verify', '--quiet', `${ref}:${file}`], { encoding: 'utf8' })
    : spawnSync('git', ['-C', REPO_ROOT, 'hash-object', file], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('could not reserve a port');
  return address.port;
}

function unpack(archive: string, work: string): string {
  const dest = path.join(work, 'unit');
  mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', dest]);
  const [top] = readdirSync(dest);
  const unit = path.join(dest, top ?? '');
  if (!top || !existsSync(path.join(unit, 'install.sh'))) throw new Error(`${archive} does not unpack to a release unit`);
  return unit;
}

/** The archive's own digest line for a unit file (CONTENTS.sha256, written by package-release.sh). */
function listedDigest(unit: string, file: string): string | null {
  const line = readFileSync(path.join(unit, 'CONTENTS.sha256'), 'utf8').split('\n')
    .find((entry) => entry.endsWith(`  ${file}`));
  return line ? line.split(/\s+/)[0] : null;
}

/** Reject a missing routed-account fixture before the long scripted leg starts. */
function preflightRoutedAccountCatalog(real: RealLeg[] | undefined): void {
  for (const leg of real ?? []) {
    const account = leg.env?.PUI_REAL_ACCOUNT ?? process.env.PUI_REAL_ACCOUNT;
    if (account !== 'auto') continue;
    const catalogPath = leg.env?.PUI_NATIVE_ACCOUNT_CATALOG ?? process.env.PUI_NATIVE_ACCOUNT_CATALOG;
    if (!catalogPath?.trim()) {
      throw new Error(`PUI_REAL_ACCOUNT=auto for ${leg.backend} requires PUI_NATIVE_ACCOUNT_CATALOG: a current accounts:list JSON snapshot with id/provider metadata, before installed suites run`);
    }
    if (!path.isAbsolute(catalogPath)) {
      throw new Error(`PUI_NATIVE_ACCOUNT_CATALOG must be an absolute path so the installed suites read the same file: ${catalogPath}`);
    }
    let accounts: unknown;
    try {
      const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as { accounts?: unknown };
      accounts = parsed.accounts;
    } catch {
      throw new Error(`PUI_NATIVE_ACCOUNT_CATALOG must point to readable accounts:list JSON with id/provider metadata: ${catalogPath}`);
    }
    if (!Array.isArray(accounts) || accounts.length === 0 || accounts.some((entry: unknown) => {
      const row = entry as Record<string, unknown> | null;
      return !row || typeof row.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(row.id)
        || !['claude', 'codex'].includes(String(row.provider));
    })) {
      throw new Error(`PUI_NATIVE_ACCOUNT_CATALOG must contain nonempty accounts:list accounts with valid id/provider metadata: ${catalogPath}`);
    }
  }
}

export async function runReleaseAcceptance(options: RunOptions): Promise<RunResult> {
  preflightRoutedAccountCatalog(options.real);
  const archive = path.resolve(options.archive);
  const work = options.work ?? mkdtempSync(path.join(tmpdir(), 'pui-release-acceptance-'));
  const archiveSha256 = sha256(archive);
  const sums = path.join(path.dirname(archive), 'SHA256SUMS');
  if (existsSync(sums)) {
    const listed = readFileSync(sums, 'utf8').split('\n').find((line) => line.endsWith(`  ${path.basename(archive)}`));
    if (listed && listed.split(/\s+/)[0] !== archiveSha256) throw new Error(`${archive} does not match its SHA256SUMS entry`);
  }

  const unit = unpack(archive, work);
  const provenance = JSON.parse(readFileSync(path.join(unit, 'PROVENANCE.json'), 'utf8')) as {
    target: string; source: { commit: string };
  };
  const sourceSha = provenance.source.commit;
  const runnerTreeBefore = measureRunnerTree();
  let stockMachines = provenance.target.startsWith('linux-') ? runStockMachineSmoke(unit) : [];
  let cloudDeviceStartHistory = await measureCloudDeviceStart();

  const home = path.join(work, 'home');
  mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const install = spawnSync(path.join(unit, 'install.sh'), ['--yes'], {
    cwd: home, encoding: 'utf8', timeout: 300_000,
    env: {
      HOME: home, PATH: process.env.PATH, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: path.join(home, 'tmp'),
      // install.sh finishes with `pui doctor`; keep it off the developer's live operator.
      PAPERCUSP_HONO_PORT: String(await closedPort()),
    },
  });
  if (install.status !== 0) {
    throw new Error(`install.sh failed (status ${install.status}):\n${install.stdout}\n${install.stderr}`.slice(-8_000));
  }
  const installRoot = realpathSync(path.join(home, '.local', 'share', 'pui'));
  const installed = realpathSync(path.join(installRoot, 'current', 'bin', 'pui'));
  const installedBinarySha256 = sha256(installed);
  if (listedDigest(unit, 'bin/pui') !== installedBinarySha256) {
    throw new Error(`installed ${installed} does not match the archive's CONTENTS.sha256 entry for bin/pui`);
  }

  const platform = options.platform ?? detectPlatform();
  const legs: RunResult['legs'] = [];
  const rows: EvidenceRow[] = [];
  const suites = options.suites ?? RELEASE_SUITES;
  // When the stage itself runs under vitest (its R-12 test), the outer worker's
  // VITEST_* markers must not leak into the suites' own run.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  // A binary that cannot start on stock Linux, or a cloud that measurably refuses
  // device starts, cannot earn a passing verdict. Keep writing the verdict, but
  // avoid launching expensive live legs. A precheck the host or the ingress
  // could not answer (Docker stall, 5xx) does not stop them: it is measured again
  // after the legs instead.
  const legsToRun = legsBlocked(stockMachines, cloudDeviceStartHistory[cloudDeviceStartHistory.length - 1])
    ? [] : [null, ...(options.real ?? [])];
  const acceptancePg = legsToRun.length ? await startAcceptancePg(work) : { env: {}, stop: async () => {} };
  try {
  for (const leg of legsToRun) {
    const engine = leg ? leg.backend : 'scripted';
    const evidence = path.join(work, `evidence-${engine}.json`);
    const run = await runChildWithLiveLog(VITEST, [
      'run', '--config', 'vitest.integration.config.ts',
      ...suites.map((file) => path.join(REPO_ROOT, file)),
      ...(options.testFilter ? ['-t', options.testFilter] : []),
      '--reporter=default', `--reporter=${REPORTER}`,
    ], {
      cwd: OPERATOR_CORE, timeout: 90 * 60_000,
      env: {
        ...inherited,
        ...acceptancePg.env,
        PUI_BIN: installed,
        // The store install.sh wrote. Suites run PUI under their own HOME, so a
        // journey that reads the release store must be pointed at this one.
        PUI_RELEASE_STORE: installRoot,
        PUI_RELEASE_PLATFORM: platform ?? '',
        PUI_RELEASE_EVIDENCE: evidence,
        ...(leg ? { PUI_REAL_ENGINE: '1', PUI_REAL_BACKEND: leg.backend, ...(leg.model ? { PUI_REAL_MODEL: leg.model } : {}), ...leg.env }
          : { PUI_REAL_ENGINE: '' }),
      },
    }, path.join(work, `vitest-${engine}.log`));
    const harvested = existsSync(evidence) ? (JSON.parse(readFileSync(evidence, 'utf8')) as EvidenceFile).rows : [];
    rows.push(...harvested);
    legs.push({ engine, status: run.status, evidence, rows: harvested.length });
  }
  } finally {
    await acceptancePg.stop();
  }

  const candidate: Candidate = {
    sourceSha, artifact: provenance.target, archive, archiveSha256, installRoot, installedBinarySha256,
    advertise: options.advertise,
  };
  const contract = committed(sourceSha, 'apps/tui/PUBLIC_RELEASE_UX.md');
  const matrixText = committed(sourceSha, 'apps/tui/release/acceptance-matrix.json');
  const extra: string[] = [];
  cloudDeviceStartHistory = await remeasureCloudDeviceStart(cloudDeviceStartHistory);
  const cloudDeviceStart = cloudDeviceStartHistory[cloudDeviceStartHistory.length - 1];
  if (!cloudDeviceStart.ok) extra.push(`public cloud device-start smoke failed: ${cloudDeviceStart.problem}`);
  if (!contract) extra.push(`candidate ${sourceSha} carries no apps/tui/PUBLIC_RELEASE_UX.md`);
  if (!matrixText) extra.push(`candidate ${sourceSha} carries no apps/tui/release/acceptance-matrix.json`);
  if (!platform) extra.push(`this host (${process.platform}/${process.arch}) is not a platform in the release matrix`);
  stockMachines = remeasureStockMachines(stockMachines, () => runStockMachineSmoke(unit));
  for (const machine of stockMachines) {
    const refusal = stockMachineRefusal(machine);
    if (refusal) extra.push(refusal);
  }
  const runnerTree = { before: runnerTreeBefore, after: measureRunnerTree() };
  extra.push(...new Set([
    ...runnerTreeRefusals(runnerTree.before, sourceSha, 'before the legs'),
    ...runnerTreeRefusals(runnerTree.after, sourceSha, 'after the legs'),
  ]));
  const suiteProvenance = ACCEPTANCE_SOURCES.map((file) => ({ file, candidateBlob: blob(sourceSha, file), runBlob: blob(null, file) }));
  for (const entry of suiteProvenance) {
    if (!entry.candidateBlob || entry.candidateBlob !== entry.runBlob) {
      extra.push(`${entry.file} as run is not the candidate's committed copy, so its evidence describes other code`);
    }
  }

  const verdict: Verdict = contract && matrixText
    ? checkReleaseAcceptance(parseRequiredMatrix(contract), JSON.parse(matrixText) as AcceptanceMatrixFile, candidate, rows, legs)
    : { ok: false, candidate, refusals: [], cells: [], capabilities: [], evidence: judgeEvidence(rows, candidate) };
  verdict.refusals.unshift(...extra);
  verdict.ok = verdict.refusals.length === 0;

  const out = options.out ?? `${archive}.acceptance.json`;
  writeFileSync(out, `${JSON.stringify({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    runner: {
      head: git('rev-parse', 'HEAD'), platform, legs, stockMachines, cloudDeviceStart, cloudDeviceStartHistory,
      suiteProvenance, runnerTree, work,
    },
    ...verdict,
  }, null, 2)}\n`);
  return { verdict, out, legs, stockMachines, cloudDeviceStart, suiteProvenance, runnerTree };
}
