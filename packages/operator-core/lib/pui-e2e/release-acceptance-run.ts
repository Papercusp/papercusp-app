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
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  checkReleaseAcceptance, detectPlatform, judgeEvidence, parseRequiredMatrix, REPO_ROOT,
  type AcceptanceMatrixFile, type Candidate, type EvidenceRow, type Verdict,
} from './release-acceptance';
import type { EvidenceFile } from './release-acceptance-reporter';

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
}

export interface StockMachineResult {
  image: string;
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

/** Exercise the shipped unit on stock Linux, without host libraries or network. */
export function runStockMachineSmoke(
  unit: string, images = STOCK_LINUX_IMAGES, probe = probeDockerCreateStart,
): StockMachineResult[] {
  const dockerProblem = probe();
  if (dockerProblem) {
    return images.map((image) => ({ image, status: null, output: dockerProblem }));
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
  const stockMachines = provenance.target.startsWith('linux-') ? runStockMachineSmoke(unit) : [];
  const cloudDeviceStart = await runCloudDeviceStartSmoke();

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
  // A binary that cannot start on stock Linux cannot earn PTY evidence. Keep
  // writing the acceptance verdict, but avoid launching expensive live legs.
  const legsToRun = !cloudDeviceStart.ok || stockMachines.some((machine) => machine.status !== 0)
    ? [] : [null, ...(options.real ?? [])];
  for (const leg of legsToRun) {
    const engine = leg ? leg.backend : 'scripted';
    const evidence = path.join(work, `evidence-${engine}.json`);
    const run = spawnSync(VITEST, [
      'run', '--config', 'vitest.integration.config.ts',
      ...suites.map((file) => path.join(REPO_ROOT, file)),
      ...(options.testFilter ? ['-t', options.testFilter] : []),
      '--reporter=default', `--reporter=${REPORTER}`,
    ], {
      cwd: OPERATOR_CORE, encoding: 'utf8', timeout: 90 * 60_000, maxBuffer: 512 * 1024 * 1024,
      env: {
        ...inherited,
        PUI_BIN: installed,
        // The store install.sh wrote. Suites run PUI under their own HOME, so a
        // journey that reads the release store must be pointed at this one.
        PUI_RELEASE_STORE: installRoot,
        PUI_RELEASE_PLATFORM: platform ?? '',
        PUI_RELEASE_EVIDENCE: evidence,
        ...(leg ? { PUI_REAL_ENGINE: '1', PUI_REAL_BACKEND: leg.backend, ...(leg.model ? { PUI_REAL_MODEL: leg.model } : {}), ...leg.env }
          : { PUI_REAL_ENGINE: '' }),
      },
    });
    writeFileSync(path.join(work, `vitest-${engine}.log`), `${run.stdout ?? ''}\n--- stderr\n${run.stderr ?? ''}`);
    const harvested = existsSync(evidence) ? (JSON.parse(readFileSync(evidence, 'utf8')) as EvidenceFile).rows : [];
    rows.push(...harvested);
    legs.push({ engine, status: run.status, evidence, rows: harvested.length });
  }

  const candidate: Candidate = {
    sourceSha, artifact: provenance.target, archive, archiveSha256, installRoot, installedBinarySha256,
    advertise: options.advertise,
  };
  const contract = committed(sourceSha, 'apps/tui/PUBLIC_RELEASE_UX.md');
  const matrixText = committed(sourceSha, 'apps/tui/release/acceptance-matrix.json');
  const extra: string[] = [];
  if (!cloudDeviceStart.ok) extra.push(`public cloud device-start smoke failed: ${cloudDeviceStart.problem}`);
  if (!contract) extra.push(`candidate ${sourceSha} carries no apps/tui/PUBLIC_RELEASE_UX.md`);
  if (!matrixText) extra.push(`candidate ${sourceSha} carries no apps/tui/release/acceptance-matrix.json`);
  if (!platform) extra.push(`this host (${process.platform}/${process.arch}) is not a platform in the release matrix`);
  for (const machine of stockMachines) {
    if (machine.status !== 0) {
      extra.push(`stock-machine smoke on ${machine.image} failed (status ${machine.status}): ${machine.output.slice(-1_000)}`);
    }
  }
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
    runner: { head: git('rev-parse', 'HEAD'), platform, legs, stockMachines, cloudDeviceStart, suiteProvenance, work },
    ...verdict,
  }, null, 2)}\n`);
  return { verdict, out, legs, stockMachines, cloudDeviceStart, suiteProvenance };
}
