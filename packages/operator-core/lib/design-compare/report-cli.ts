/**
 * The report-only CLI: the entrypoint CI runs, and the instrument that measures
 * the calibration the threshold policy is derived from.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * Two modes, one cohort:
 *
 *   --mode=calibrate   measure raw diff ratios and runtimes; write the
 *                      calibration artifact `policy.ts` derives thresholds from.
 *                      Consults NO policy, by construction: a calibration that
 *                      read the threshold it is being used to set would be
 *                      circular.
 *
 *   --mode=report      run the same cohort under the RESOLVED policy and write a
 *                      report. Report-only: a `fail` verdict is data, not an
 *                      exit code. See `report.ts` for why that is structural
 *                      rather than a flag.
 *
 * WHAT THE COHORT IS, precisely — this is the part a reader must not have to
 * guess, because every number downstream inherits its scope:
 *
 *   fixture-corpus   the synthetic P-002 corpus. Deterministic, no browser.
 *                    Establishes that the ENGINE path is sound and gives a
 *                    per-class comparison runtime.
 *
 *   real-surface     real Chromium renders of this repo's own Storybook, served
 *                    over HTTP (D-015: a relative path becomes file://, under
 *                    which Storybook's preview never boots). Two measurements:
 *
 *                      noise      the same story captured TWICE in independent
 *                                 browser contexts, at `stabilityRetries: 0` so
 *                                 the raw capture-to-capture variance is
 *                                 measured rather than retried away. This is
 *                                 the number that sets the floor of a threshold.
 *
 *                      regression the same COMPONENT captured at two different
 *                                 ratified environments — its own sibling story
 *                                 variants. A real difference between two real
 *                                 renders, not an injected perturbation.
 *
 * The regression figure is deliberately reported as a MINIMUM across pairs, and
 * carries a caveat in the artifact: sibling variants differ by content, which is
 * a larger difference than a typical CSS regression. It therefore establishes
 * that separation EXISTS; it does not establish a minimum detectable change.
 * Saying so in the artifact is cheaper than having someone quote the number as
 * if it did.
 */
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CaptureEnvironment, ReferenceClass } from './contract';
import { createStorybookCaptureAdapter } from './capture';
import { launchPlaywrightCaptureBrowser } from './capture-playwright';
import {
  CORPUS_PAIRS,
  type CorpusPair,
} from './corpus/cases';
import {
  compareWithEngine,
  engineVersions,
  materialiseCorpus,
  type EngineId,
} from './corpus/harness';
import {
  CALIBRATION_SCHEMA_VERSION,
  type CalibrationArtifact,
  type ClassCalibration,
  type RuntimeStats,
} from './policy-shape';

/**
 * The engine every number here is measured on.
 *
 * pixelmatch, not lost-pixel's odiff default: D-008 records that the installed
 * pixelmatch path's own `isWithinThreshold` fails open, which is exactly why
 * this system reads raw COUNTS and computes the verdict itself. Measuring on the
 * engine whose convenience boolean is untrustworthy — while ignoring that
 * boolean — is the honest pairing.
 */
const MEASUREMENT_ENGINE: EngineId = 'pixelmatch';

/** The contracted environment the real-surface cohort is captured at. */
const COHORT_ENVIRONMENT: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'system',
  state: 'default',
};

/** How many real stories to capture. Small on purpose — P-008 asks for a cohort, not a suite. */
const REAL_SURFACE_STORY_CAP = 12;

// ─── a static server for storybook-static (D-015) ────────────────────────────

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

interface StaticSite {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Serve a directory over HTTP on an ephemeral port.
 *
 * Deliberately not a dependency: this serves static bytes from one directory to
 * one localhost browser for the length of one process. Reaching for a server
 * framework here would be the same borrowing the plan already refused for the
 * browser driver.
 */
async function serveDirectory(root: string): Promise<StaticSite> {
  const server: Server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
    // Contain the read inside `root`: a static server that can be talked out of
    // its own directory is a directory traversal, even a short-lived one.
    const resolved = path.resolve(root, relative);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(resolved)] ?? 'application/octet-stream' });
    createReadStream(resolved).pipe(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('static server did not bind to a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

// ─── the real-surface cohort, discovered rather than listed ──────────────────

export interface StoryEntry {
  readonly id: string;
  readonly componentKey: string;
}

/**
 * Read the story ids out of a built Storybook's own index.
 *
 * Discovered, never hand-listed: a hard-coded story list is a second copy of a
 * truth the build owns, and it rots the first time a story is renamed. The
 * component key is the story id minus its variant, which is what makes a
 * sibling pair findable without a naming convention of our own.
 */
export function readStoryIndex(storybookStaticDir: string, cap: number): StoryEntry[] {
  const indexPath = path.join(storybookStaticDir, 'index.json');
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as {
    entries?: Record<string, { id?: string; type?: string }>;
  };
  const entries = Object.values(parsed.entries ?? {})
    .filter((entry) => entry.type === 'story' && typeof entry.id === 'string')
    .map((entry) => entry.id as string)
    .sort();
  return entries.slice(0, cap).map((id) => ({
    id,
    componentKey: id.includes('--') ? (id.split('--')[0] as string) : id,
  }));
}

/** Sibling variants of the same component: the real-surface regression pairs. */
export function siblingPairs(stories: readonly StoryEntry[]): Array<[StoryEntry, StoryEntry]> {
  const byComponent = new Map<string, StoryEntry[]>();
  for (const story of stories) {
    const bucket = byComponent.get(story.componentKey);
    if (bucket) bucket.push(story);
    else byComponent.set(story.componentKey, [story]);
  }
  const pairs: Array<[StoryEntry, StoryEntry]> = [];
  for (const bucket of byComponent.values()) {
    for (let i = 0; i + 1 < bucket.length; i += 1) {
      pairs.push([bucket[i] as StoryEntry, bucket[i + 1] as StoryEntry]);
    }
  }
  return pairs;
}

// ─── statistics ──────────────────────────────────────────────────────────────

export function runtimeStats(samples: readonly number[]): RuntimeStats {
  if (samples.length === 0) return { n: 0, p50Ms: null, maxMs: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const p50 =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return {
    n: sorted.length,
    p50Ms: round6(p50),
    maxMs: round6(sorted[sorted.length - 1] as number),
  };
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

// ─── measurement ─────────────────────────────────────────────────────────────

interface Sample {
  readonly caseId: string;
  readonly diffRatio: number;
  readonly pixelsTotal: number;
  readonly comparisonMs: number;
}

interface ClassAccumulator {
  readonly cohorts: Set<string>;
  /** Real capture-to-capture variance. Never fed by the synthetic corpus (D-021). */
  readonly noise: Sample[];
  /** Real differences between different surfaces, strictly greater than zero. */
  readonly regression: Sample[];
  /** Different surfaces that captured byte-identically (D-020). */
  readonly indistinguishable: string[];
  /** The synthetic leg: engine soundness + comparison runtime, never a threshold input. */
  readonly fidelity: Sample[];
  readonly captureMs: number[];
  readonly comparisonMs: number[];
}

function accumulator(): ClassAccumulator {
  return {
    cohorts: new Set<string>(),
    noise: [],
    regression: [],
    indistinguishable: [],
    fidelity: [],
    captureMs: [],
    comparisonMs: [],
  };
}

/**
 * The synthetic corpus leg.
 *
 * Contributes ENGINE SOUNDNESS and comparison runtime — never a threshold
 * input (D-021). The corpus captures nothing, so its `faithful` pair is a
 * modelled fidelity difference and not capture-to-capture variance. An earlier
 * revision of this file fed it into the noise leg; the measured consequence was
 * a noise floor of 0.0025 against a real measured 0.0, which failed the
 * separation test and made the only genuinely gateable class advisory-only.
 */
async function measureFixtureCorpus(
  classes: Map<ReferenceClass, ClassAccumulator>,
  workDir: string,
): Promise<void> {
  const corpus = materialiseCorpus(path.join(workDir, 'corpus'));
  for (const pair of CORPUS_PAIRS as readonly CorpusPair[]) {
    const referenceClass = pair.referenceClass as ReferenceClass;
    const bucket = classes.get(referenceClass) ?? accumulator();
    classes.set(referenceClass, bucket);
    bucket.cohorts.add('fixture-corpus');

    const referencePath = corpus.paths.get(pair.reference);
    const candidatePath = corpus.paths.get(pair.candidate);
    if (referencePath === undefined || candidatePath === undefined) {
      throw new Error(`corpus pair '${pair.id}' names an image the corpus does not materialise`);
    }
    const measured = await compareWithEngine(
      MEASUREMENT_ENGINE,
      referencePath,
      candidatePath,
      path.join(workDir, 'diffs', `${pair.id.replace(/\//g, '_')}.png`),
    );
    bucket.comparisonMs.push(measured.elapsedMs);
    bucket.fidelity.push({
      caseId: `fixture-corpus:${pair.id}`,
      diffRatio: round6(measured.diffRatio),
      pixelsTotal: measured.pixelsTotal,
      comparisonMs: round6(measured.elapsedMs),
    });
  }
}

/**
 * The real-surface leg. Everything captured here is class `artifact-capture`:
 * a real HTML render at a contracted environment is exactly what that class
 * means, and calling a Storybook render anything else would be a lie the policy
 * would then inherit.
 */
async function measureRealSurface(
  classes: Map<ReferenceClass, ClassAccumulator>,
  workDir: string,
  storybookStaticDir: string,
): Promise<{ storiesCaptured: number; refusals: string[]; renderHosts: string[] }> {
  const bucket = classes.get('artifact-capture') ?? accumulator();
  classes.set('artifact-capture', bucket);
  bucket.cohorts.add('real-surface');

  const stories = readStoryIndex(storybookStaticDir, REAL_SURFACE_STORY_CAP);
  const site = await serveDirectory(path.resolve(storybookStaticDir));
  const browser = await launchPlaywrightCaptureBrowser();
  const adapter = createStorybookCaptureAdapter({ browser });
  const shotDir = path.join(workDir, 'real-surface');
  mkdirSync(shotDir, { recursive: true });
  const refusals: string[] = [];
  const capturedPaths = new Map<string, string>();
  // P-011/D-023: the machine every noise sample below was measured on, read
  // back from the captures themselves rather than assumed from the process.
  // A SET, not a single value, because "all the captures agreed about the host"
  // is a fact this measurement can establish and should not take on faith.
  const renderHosts = new Set<string>();

  /** One raw capture: no stability retries, so variance is measured not hidden. */
  async function captureOnce(storyId: string, attempt: number): Promise<string | null> {
    const outputPath = path.join(shotDir, `${storyId}__${attempt}.png`);
    const startedAt = process.hrtime.bigint();
    const outcome = await adapter.capture({
      target: {
        targetId: storyId,
        targetKind: 'storybook-story',
        implementationRevision: 'report-cli-cohort',
      },
      environment: COHORT_ENVIRONMENT,
      mode: 'viewport',
      outputPath,
      baseUrl: site.baseUrl,
      stabilityRetries: 0,
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (!outcome.ok) {
      refusals.push(`${storyId} attempt ${attempt}: ${outcome.invalidReason} — ${outcome.detail}`);
      return null;
    }
    bucket.captureMs.push(elapsedMs);
    if (outcome.observed.renderHost) renderHosts.add(outcome.observed.renderHost);
    return outcome.imagePath;
  }

  try {
    // Repeatability: the same story, twice, independently.
    for (const story of stories) {
      const first = await captureOnce(story.id, 1);
      const second = await captureOnce(story.id, 2);
      if (first === null || second === null) continue;
      capturedPaths.set(story.id, first);
      const measured = await compareWithEngine(
        MEASUREMENT_ENGINE,
        first,
        second,
        path.join(workDir, 'diffs', `noise_${story.id}.png`),
      );
      bucket.noise.push({
        caseId: `real-surface:noise:${story.id}`,
        diffRatio: round6(measured.diffRatio),
        pixelsTotal: measured.pixelsTotal,
        comparisonMs: round6(measured.elapsedMs),
      });
      bucket.comparisonMs.push(measured.elapsedMs);
    }

    // Separation: sibling variants of the same component.
    for (const [left, right] of siblingPairs(stories)) {
      const leftPath = capturedPaths.get(left.id);
      const rightPath = capturedPaths.get(right.id);
      if (leftPath === undefined || rightPath === undefined) continue;
      const measured = await compareWithEngine(
        MEASUREMENT_ENGINE,
        leftPath,
        rightPath,
        path.join(workDir, 'diffs', `regression_${left.id}__${right.id}.png`),
      );
      bucket.comparisonMs.push(measured.elapsedMs);
      if (measured.pixelDifference === 0) {
        // Two DIFFERENT surfaces that captured identically. Recorded as a
        // finding, never as a regression sample of ratio zero (D-020).
        bucket.indistinguishable.push(`${left.id}|${right.id}`);
        continue;
      }
      bucket.regression.push({
        caseId: `real-surface:regression:${left.id}|${right.id}`,
        diffRatio: round6(measured.diffRatio),
        pixelsTotal: measured.pixelsTotal,
        comparisonMs: round6(measured.elapsedMs),
      });
    }
  } finally {
    await browser.close();
    await site.close();
  }

  return { storiesCaptured: capturedPaths.size, refusals, renderHosts: [...renderHosts].sort() };
}

// ─── artifact assembly ───────────────────────────────────────────────────────

export interface MeasureOptions {
  readonly storybookStaticDir: string;
  readonly policyVersion: string;
  readonly workDir: string;
}

export async function measureCalibration(options: MeasureOptions): Promise<CalibrationArtifact> {
  const classes = new Map<ReferenceClass, ClassAccumulator>();
  await measureFixtureCorpus(classes, options.workDir);
  const real = await measureRealSurface(classes, options.workDir, options.storybookStaticDir);

  const versions = engineVersions();
  const calibrations: ClassCalibration[] = [];
  for (const [referenceClass, bucket] of [...classes.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const faithful = bucket.fidelity.filter((s) => s.caseId.endsWith('/faithful'));
    const drifted = bucket.fidelity.filter((s) => s.caseId.endsWith('/drifted'));
    calibrations.push({
      referenceClass,
      cohorts: [...bucket.cohorts].sort(),
      noise: {
        n: bucket.noise.length,
        maxDiffRatio:
          bucket.noise.length === 0
            ? null
            : round6(Math.max(...bucket.noise.map((s) => s.diffRatio))),
        samples: bucket.noise,
      },
      regression: {
        n: bucket.regression.length,
        minDiffRatio:
          bucket.regression.length === 0
            ? null
            : round6(Math.min(...bucket.regression.map((s) => s.diffRatio))),
        samples: bucket.regression,
      },
      indistinguishablePairs: bucket.indistinguishable,
      fidelityCorpus: {
        faithfulMaxDiffRatio:
          faithful.length === 0 ? null : round6(Math.max(...faithful.map((s) => s.diffRatio))),
        driftedMinDiffRatio:
          drifted.length === 0 ? null : round6(Math.min(...drifted.map((s) => s.diffRatio))),
        samples: bucket.fidelity,
      },
      captureRuntime: runtimeStats(bucket.captureMs),
      comparisonRuntime: runtimeStats(bucket.comparisonMs),
      // Scoped to the NOISE leg: this bounds the precision of the noise
      // measurement, so an image no noise sample was taken on must not set it.
      smallestPixelsTotal:
        bucket.noise.length === 0
          ? null
          : Math.min(...bucket.noise.map((s) => s.pixelsTotal)),
    });
  }

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    policyVersion: options.policyVersion,
    generatedAt: new Date().toISOString(),
    engine: {
      engine: `lost-pixel/${MEASUREMENT_ENGINE}`,
      engineVersion: versions[MEASUREMENT_ENGINE] ?? 'unknown',
    },
    environment: COHORT_ENVIRONMENT,
    realSurface: {
      source: 'apps/operator/storybook-static',
      storiesCaptured: real.storiesCaptured,
      refusals: real.refusals,
    },
    classes: calibrations,
    // P-011/D-023. Stamped ONLY when every capture in the noise leg agreed
    // about which machine it ran on. Zero hosts (nothing captured) or more than
    // one (samples pooled across machines) both mean this artifact cannot name
    // the domain its numbers describe — and `enforceability.ts` reads the
    // absence as "enforce nowhere", which is the correct reading of a
    // calibration that cannot say where it was taken.
    ...(real.renderHosts.length === 1 ? { measuredOnRenderHost: real.renderHosts[0] } : {}),
    caveats: [
      ...(real.renderHosts.length === 1
        ? []
        : [
            `RENDER HOST NOT ESTABLISHED: the noise leg reported ${real.renderHosts.length} ` +
              'distinct rendering hosts, so this calibration cannot name the machine its ' +
              'threshold describes and nothing derived from it may be enforced anywhere ' +
              '(P-011/D-023).',
          ]),
      'SAME-HOST ONLY. Every noise sample was captured on one machine, so this measures ' +
        'capture-to-capture variance and NOT host-to-host variance. Font rasterisation and GPU ' +
        'differences across machines are entirely unmeasured here, and are plausibly far larger ' +
        'than the same-host figure. This is the single most important reason the gate stays ' +
        'report-only (D-006): the CI report run is the instrument that will measure cross-host ' +
        'noise, and P-011 must not enable enforcement before it has.',
      'Real-surface regression samples are SIBLING STORY VARIANTS of the same component: two ' +
        'real renders that differ by content. They establish that separation exists at this ' +
        'scale; they do NOT establish a minimum detectable change, so no one may quote the ' +
        'regression figure as the smallest difference the gate can catch.',
      'Noise samples are two independent captures at stabilityRetries: 0. The production ' +
        'capture path defaults to retrying until byte-identical, so this figure is an UPPER ' +
        'bound on the variance a real comparison sees, not the variance it will see.',
      'The synthetic fixture corpus contributes engine soundness and comparison runtime only ' +
        '(fidelityCorpus). It is NOT a threshold input: it captures nothing, so it cannot ' +
        'measure capture noise (D-021). A class with only corpus evidence therefore has no ' +
        'measured noise floor and `policy.ts` refuses to make it gateable rather than ' +
        'borrowing another class’s.',
      'indistinguishablePairs, when non-empty, means two DIFFERENT surfaces produced identical ' +
        'captures — a live bypass (D-020), not a cohort defect to tidy away.',
    ],
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');

function argValue(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  const mode = argValue('mode', 'report');
  const storybookStaticDir = argValue(
    'storybook-static',
    path.join(REPO_ROOT, 'apps/operator/storybook-static'),
  );
  const outDir = argValue('out', path.join(REPO_ROOT, 'design-evidence-report'));
  // `--work` keeps the captures and diff PNGs. CI passes it so the images can be
  // uploaded as artifacts; a human passes it to look at what was actually
  // compared, which is the only way to tell a real render from a blank page that
  // reproduces perfectly.
  const keptWorkDir = argValue('work', '');
  const workDir = keptWorkDir === '' ? mkdtempSync(path.join(tmpdir(), 'design-evidence-')) : keptWorkDir;
  if (keptWorkDir !== '') mkdirSync(workDir, { recursive: true });

  if (!existsSync(path.join(storybookStaticDir, 'index.json'))) {
    // A missing Storybook build is a real condition in CI, not a crash: report
    // it and let the fixture-corpus leg still run.
    console.error(
      `[design-evidence] no Storybook index at ${storybookStaticDir}; ` +
        'the real-surface leg will be empty.',
    );
  }

  try {
    if (mode === 'calibrate') {
      const policyVersion = argValue('policy-version', 'dcp-unversioned');
      const artifact = await measureCalibration({ storybookStaticDir, policyVersion, workDir });
      const target = argValue('artifact', path.join(HERE, 'policy-calibration.json'));
      writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
      console.log(`[design-evidence] wrote calibration artifact -> ${target}`);
      for (const cls of artifact.classes) {
        console.log(
          `  ${cls.referenceClass}: noise n=${cls.noise.n} max=${cls.noise.maxDiffRatio} · ` +
            `regression n=${cls.regression.n} min=${cls.regression.minDiffRatio} · ` +
            `capture p50=${cls.captureRuntime.p50Ms}ms · compare p50=${cls.comparisonRuntime.p50Ms}ms`,
        );
        if (cls.indistinguishablePairs.length > 0) {
          console.log(
            `      ⚠ ${cls.indistinguishablePairs.length} INDISTINGUISHABLE pair(s) — different ` +
              'surfaces, identical captures (D-020):',
          );
          for (const pair of cls.indistinguishablePairs) console.log(`        ${pair}`);
        }
      }
      return;
    }

    // Imported lazily so `--mode=calibrate` never loads the policy it is
    // measuring the inputs for.
    const { buildReport, formatReportSummary } = await import('./report');
    const artifact = await measureCalibration({
      storybookStaticDir,
      policyVersion: 'measured-in-place',
      workDir,
    });
    const report = buildReport(artifact);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    console.log(formatReportSummary(report));
    console.log(`[design-evidence] wrote report -> ${path.join(outDir, 'report.json')}`);
  } finally {
    if (keptWorkDir === '') rmSync(workDir, { recursive: true, force: true });
    else console.log(`[design-evidence] kept captures + diffs in ${workDir}`);
  }
}

// Only run when invoked directly, so the measurement functions above stay
// importable by tests without launching a browser on import.
if (process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((error: unknown) => {
    console.error('[design-evidence] harness failure:', error);
    // A harness failure is NOT a comparison verdict. Report-only applies to
    // verdicts; an instrument that could not run must be loud, and CI keeps the
    // job green through `continue-on-error` rather than by us hiding it here.
    process.exitCode = 1;
  });
}
