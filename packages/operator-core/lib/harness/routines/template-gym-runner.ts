/**
 * Template gym for the official mobile template closure.
 *
 * The runner deliberately exercises the canonical template tree against the
 * two independent product repositories instead of copying product fixtures
 * into this repo.  The four consumer legs are static/portable: they validate
 * composition, source hygiene, command-plan completeness, and platform
 * chassis without repeating the expensive Android/iPhone builds owned by the
 * consumers' release lanes.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTextCollector } from '../../child-output';
import {
  PAPERCUSP_ANDROID_APP_TEMPLATE,
  PAPERCUSP_IPHONE_APP_TEMPLATE,
  REFERENCE_TEMPLATES,
  resolveRequiresClosure,
  type TemplateManifest,
} from '@papercusp/template-kit';

export const MOBILE_TEMPLATE_IDS = [
  'papercusp-mobile-base',
  'papercusp-android-shell',
  'papercusp-android-app',
  'papercusp-iphone-shell',
  'papercusp-iphone-app',
] as const;

export type MobilePlatform = 'android' | 'iphone';
export type MobileProduct = 'papercusp' | 'sidestage';

export interface MobileConsumer {
  id: `${MobileProduct}-${MobilePlatform}`;
  product: MobileProduct;
  platform: MobilePlatform;
  root: string;
  configPath: string;
}

export interface LegResult {
  leg: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface GymRunSummary {
  runId: string;
  startedAt: string;
  papercuspRoot: string;
  consumerRoots: Record<MobileProduct, string>;
  legs: LegResult[];
  green: boolean;
}

export interface ManifestDrift {
  missing: string[];
  changed: string[];
  extra: string[];
}

export function diffManifestSet(
  canonical: ReadonlyMap<string, string>,
  consumer: ReadonlyMap<string, string>,
): ManifestDrift {
  const missing: string[] = [];
  const changed: string[] = [];
  const extra: string[] = [];
  for (const [id, body] of canonical) {
    const copy = consumer.get(id);
    if (copy === undefined) missing.push(id);
    else if (copy !== body) changed.push(id);
  }
  for (const id of consumer.keys()) if (!canonical.has(id)) extra.push(id);
  return {
    missing: missing.sort(),
    changed: changed.sort(),
    extra: extra.sort(),
  };
}

const expectedClosureIds = (platform: MobilePlatform): string[] =>
  platform === 'android'
    ? ['papercusp-android-app', 'papercusp-android-shell', 'papercusp-mobile-base']
    : ['papercusp-iphone-app', 'papercusp-iphone-shell', 'papercusp-mobile-base'];

const requiredCheckIds = (platform: MobilePlatform): string[] =>
  platform === 'android'
    ? [
        'android-shell-assertions',
        'android-shell-contract',
        'composition-integrity',
        'mobile-base-commands',
        'mobile-base-contract',
      ]
    : [
        'composition-integrity',
        'iphone-shell-assertions',
        'iphone-shell-contract',
        'mobile-base-commands',
        'mobile-base-contract',
      ];

export function validateMobileCheckUnion(
  platform: MobilePlatform,
  registry: TemplateManifest[] = REFERENCE_TEMPLATES,
): string[] {
  const root = platform === 'android' ? PAPERCUSP_ANDROID_APP_TEMPLATE : PAPERCUSP_IPHONE_APP_TEMPLATE;
  const closure = resolveRequiresClosure([root], registry);
  if (!closure.ok) return closure.errors.map((error) => `closure: ${error}`);
  const errors: string[] = [];
  const ids = closure.templates.map((template) => template.id).sort();
  const expectedIds = expectedClosureIds(platform);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    errors.push(`closure ids: expected ${expectedIds.join(',')}; got ${ids.join(',')}`);
  }
  const checks = new Set(closure.templates.flatMap((template) => template.checks.map((check) => check.id)));
  for (const id of requiredCheckIds(platform)) {
    if (!checks.has(id)) errors.push(`check union: missing ${id}`);
  }
  return errors;
}

export function capabilitySetsDiffer(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return JSON.stringify(left) !== JSON.stringify(right);
}

function repoRootFromHere(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

function consumerDefinitions(
  papercuspRoot: string,
  papercuspMobileRoot: string,
  sidestageMobileRoot: string,
): MobileConsumer[] {
  const config = (root: string, name: string): string => path.join(root, name);
  const consumers: MobileConsumer[] = [
    {
      id: 'papercusp-android',
      product: 'papercusp',
      platform: 'android',
      root: papercuspMobileRoot,
      configPath: config(papercuspMobileRoot, 'checks-config.json'),
    },
    {
      id: 'sidestage-android',
      product: 'sidestage',
      platform: 'android',
      root: sidestageMobileRoot,
      configPath: config(sidestageMobileRoot, 'checks-config.json'),
    },
    {
      id: 'papercusp-iphone',
      product: 'papercusp',
      platform: 'iphone',
      root: papercuspMobileRoot,
      configPath: config(papercuspMobileRoot, 'checks-config.iphone.json'),
    },
    {
      id: 'sidestage-iphone',
      product: 'sidestage',
      platform: 'iphone',
      root: sidestageMobileRoot,
      configPath: config(sidestageMobileRoot, 'checks-config.iphone.json'),
    },
  ];
  return consumers.map((consumer) => ({
    ...consumer,
    root: path.resolve(papercuspRoot, consumer.root),
    configPath: path.resolve(papercuspRoot, consumer.configPath),
  }));
}

function canonicalManifests(root: string): Map<string, string> {
  return new Map(
    MOBILE_TEMPLATE_IDS.map((id) => [id, readFileSync(path.join(root, 'templates', id, 'template.yaml'), 'utf8')]),
  );
}

function consumerManifests(root: string): Map<string, string> {
  const dir = path.join(root, 'template-manifests');
  const out = new Map<string, string>();
  for (const id of MOBILE_TEMPLATE_IDS) {
    const file = path.join(dir, `${id}.yaml`);
    if (existsSync(file)) out.set(id, readFileSync(file, 'utf8'));
  }
  return out;
}

function vitestBin(root: string): string {
  return path.join(root, 'node_modules', '.bin', 'vitest');
}

export function consumerVitestArgs(files: readonly string[]): string[] {
  // Vitest treats positional file arguments as substring filters. Without an
  // explicit discovery root, a canonical path such as
  // `templates/papercusp-android-shell/...` also matches retained green-candidate
  // worktrees and packaged sidecar copies beneath this repository. Those copies
  // are evidence/artifacts, not another source of truth for the template gym.
  return ['run', '--dir', 'templates', ...files];
}

function runProcess(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number; timedOut: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env, detached: true });
    const output = createTextCollector(child.stdout);
    output.attach(child.stderr);
    let timedOut = false;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut, tail: `${output.text()}\n${String(error)}`.slice(-8000) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, timedOut, tail: output.text().slice(-8000) });
    });
  });
}

function compositionErrors(consumer: MobileConsumer, config: Record<string, any>): string[] {
  const errors = validateMobileCheckUnion(consumer.platform);
  const templateYamls = config.composition?.templateYamls;
  if (!Array.isArray(templateYamls)) return [...errors, 'composition.templateYamls is missing'];
  const actual = templateYamls.map((entry: unknown) => path.basename(String(entry), '.yaml')).sort();
  const expected = expectedClosureIds(consumer.platform);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`config closure: expected ${expected.join(',')}; got ${actual.join(',')}`);
  }
  return errors;
}

function effectiveConsumerConfig(consumer: MobileConsumer): Record<string, any> {
  const platform = readJson(consumer.configPath);
  const androidBase = readJson(path.join(consumer.root, 'checks-config.json'));
  return {
    ...androidBase,
    ...platform,
    app: { ...(platform.app ?? androidBase.app), root: consumer.root },
    mobileBase: androidBase.mobileBase,
    composition: platform.composition,
  };
}

const STATIC_TIMEOUT_MS = 15 * 60_000;

async function runConsumerLeg(papercuspRoot: string, consumer: MobileConsumer): Promise<LegResult> {
  const started = Date.now();
  try {
    if (!existsSync(consumer.configPath)) {
      return {
        leg: consumer.id,
        ok: false,
        detail: `missing ${consumer.configPath}`,
        durationMs: Date.now() - started,
      };
    }
    const config = effectiveConsumerConfig(consumer);
    const configErrors = compositionErrors(consumer, config);
    if (configErrors.length > 0) {
      return { leg: consumer.id, ok: false, detail: configErrors.join('; '), durationMs: Date.now() - started };
    }
    const temp = mkdtempSync(path.join(os.tmpdir(), `template-gym-${consumer.id}-`));
    const configPath = path.join(temp, 'checks-config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const platformDir = consumer.platform === 'android' ? 'papercusp-android-shell' : 'papercusp-iphone-shell';
    const appDir = consumer.platform === 'android' ? 'papercusp-android-app' : 'papercusp-iphone-app';
    const platformContract =
      consumer.platform === 'android' ? 'android-shell-contract.test.ts' : 'iphone-shell-contract.test.ts';
    const files = [
      'templates/papercusp-mobile-base/checks/mobile-base-contract.test.ts',
      `templates/${platformDir}/checks/${platformContract}`,
      `templates/${appDir}/checks/composition-integrity.test.ts`,
    ];
    const result = await runProcess(
      vitestBin(papercuspRoot),
      consumerVitestArgs(files),
      papercuspRoot,
      { ...process.env, TEMPLATE_CHECKS_CONFIG: configPath },
      STATIC_TIMEOUT_MS,
    );
    rmSync(temp, { recursive: true, force: true });
    const ok = result.code === 0 && !result.timedOut;
    return {
      leg: consumer.id,
      ok,
      detail: ok
        ? 'static source, secret, composition, and platform command-plan checks green'
        : `${result.timedOut ? 'TIMED OUT; ' : ''}exit ${result.code}\n${result.tail}`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { leg: consumer.id, ok: false, detail: String(error), durationMs: Date.now() - started };
  }
}

function manifestLeg(papercuspRoot: string, consumers: MobileConsumer[]): LegResult {
  const started = Date.now();
  try {
    const canonical = canonicalManifests(papercuspRoot);
    const details: string[] = [];
    let ok = true;
    for (const product of ['papercusp', 'sidestage'] as const) {
      const root = consumers.find((consumer) => consumer.product === product)!.root;
      const drift = diffManifestSet(canonical, consumerManifests(root));
      if (drift.missing.length || drift.changed.length || drift.extra.length) ok = false;
      details.push(`${product}: missing=[${drift.missing}], changed=[${drift.changed}], extra=[${drift.extra}]`);
    }
    return {
      leg: 'mobile-manifests',
      ok,
      detail: ok ? 'five canonical manifests are byte-identical in both consumers' : details.join('; '),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { leg: 'mobile-manifests', ok: false, detail: String(error), durationMs: Date.now() - started };
  }
}

function checkUnionLeg(consumers: MobileConsumer[]): LegResult {
  const started = Date.now();
  const errors: string[] = [];
  for (const platform of ['android', 'iphone'] as const)
    errors.push(...validateMobileCheckUnion(platform).map((error) => `${platform}: ${error}`));
  for (const consumer of consumers) {
    try {
      errors.push(
        ...compositionErrors(consumer, effectiveConsumerConfig(consumer)).map((error) => `${consumer.id}: ${error}`),
      );
    } catch (error) {
      errors.push(`${consumer.id}: ${String(error)}`);
    }
  }
  return {
    leg: 'mobile-check-union',
    ok: errors.length === 0,
    detail:
      errors.length === 0
        ? 'both root closures and all four answer records declare the full check union'
        : errors.join('; '),
    durationMs: Date.now() - started,
  };
}

function capabilityDiversityLeg(consumers: MobileConsumer[]): LegResult {
  const started = Date.now();
  const errors: string[] = [];
  for (const platform of ['android', 'iphone'] as const) {
    const configs: Record<string, any>[] = [];
    for (const consumer of consumers.filter((candidate) => candidate.platform === platform)) {
      try {
        configs.push(effectiveConsumerConfig(consumer));
      } catch (error) {
        // Packaged/standalone sidecars do not necessarily have the sibling mobile
        // consumer repositories.  Every other gym leg reports that as a failed leg;
        // letting this one throw escapes runGym and can abort sidecar startup.
        errors.push(`${consumer.id}: ${String(error)}`);
      }
    }
    if (configs.length !== 2) continue;
    const key = platform === 'android' ? 'androidShell' : 'iphoneShell';
    const left = configs[0]?.[key]?.selectedCapabilities ?? [];
    const right = configs[1]?.[key]?.selectedCapabilities ?? [];
    if (!capabilitySetsDiffer(left, right))
      errors.push(`${platform}: Papercusp and SideStage capability sets are identical`);
  }
  return {
    leg: 'mobile-capability-diversity',
    ok: errors.length === 0,
    detail: errors.length === 0 ? 'both platforms exercise distinct optional-capability sets' : errors.join('; '),
    durationMs: Date.now() - started,
  };
}

export async function runGym(
  opts: {
    papercuspMobileRoot?: string;
    sidestageMobileRoot?: string;
    legs?: string[];
    summaryJson?: string;
  } = {},
): Promise<GymRunSummary> {
  const startedAt = new Date().toISOString();
  const papercuspRoot = repoRootFromHere();
  const papercuspMobileRoot =
    opts.papercuspMobileRoot ??
    process.env.TEMPLATE_GYM_PAPERCUSP_MOBILE_ROOT ??
    path.resolve(papercuspRoot, '..', 'papercup-rust-mobile');
  const sidestageMobileRoot =
    opts.sidestageMobileRoot ??
    process.env.TEMPLATE_GYM_SIDESTAGE_MOBILE_ROOT ??
    path.resolve(papercuspRoot, '..', 'sidestage-mobile');
  const consumers = consumerDefinitions(papercuspRoot, papercuspMobileRoot, sidestageMobileRoot);
  const want = (leg: string): boolean => !opts.legs || opts.legs.includes(leg);
  const legs: LegResult[] = [];
  if (want('mobile-manifests')) legs.push(manifestLeg(papercuspRoot, consumers));
  if (want('mobile-check-union')) legs.push(checkUnionLeg(consumers));
  if (want('mobile-capability-diversity')) legs.push(capabilityDiversityLeg(consumers));
  for (const consumer of consumers) if (want(consumer.id)) legs.push(await runConsumerLeg(papercuspRoot, consumer));
  const summary: GymRunSummary = {
    runId: `template-gym-${startedAt.replace(/[:.]/g, '-')}`,
    startedAt,
    papercuspRoot,
    consumerRoots: { papercusp: papercuspMobileRoot, sidestage: sidestageMobileRoot },
    legs,
    green: legs.length > 0 && legs.every((leg) => leg.ok),
  };
  try {
    const recordDir = path.join(os.homedir(), '.papercusp', 'template-gym');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(path.join(recordDir, 'last-run.json'), JSON.stringify(summary, null, 2));
    appendFileSync(
      path.join(recordDir, 'runs.jsonl'),
      `${JSON.stringify({ runId: summary.runId, startedAt, green: summary.green, legs: legs.map(({ leg, ok, durationMs }) => ({ leg, ok, durationMs })) })}\n`,
    );
  } catch {
    // History is advisory; never turn a green verification red because HOME is read-only.
  }
  if (opts.summaryJson) writeFileSync(opts.summaryJson, JSON.stringify(summary));
  return summary;
}

/**
 * Whether this module is the process entrypoint, rather than merely bundled into one.
 *
 * Comparing argv[1] with import.meta.url alone is insufficient after esbuild bundles this
 * module into serve.mjs: both values then name the outer bundle, so an import falsely runs
 * this CLI and its process.exit() kills the packaged operator. Keep the equality check, but
 * also prove the entrypoint still has this runner's own basename.
 */
export function isTemplateGymCliEntry(
  entryPath: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url),
): boolean {
  if (!entryPath) return false;
  if (!/^template-gym-runner\.(?:[cm]?[jt]s)$/.test(path.basename(modulePath))) return false;
  return path.resolve(entryPath) === path.resolve(modulePath);
}

const isDirect = isTemplateGymCliEntry();
if (isDirect) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const requested = flag('--legs');
  runGym({
    papercuspMobileRoot: flag('--papercusp-mobile-root'),
    sidestageMobileRoot: flag('--sidestage-mobile-root'),
    summaryJson: flag('--summary-json'),
    legs: requested
      ?.split(',')
      .map((leg) => leg.trim())
      .filter(Boolean),
  })
    .then((summary) => {
      for (const leg of summary.legs)
        console.log(`[template-gym] ${leg.ok ? 'GREEN' : 'RED'} ${leg.leg} — ${leg.detail}`);
      process.exit(summary.green ? 0 : 1);
    })
    .catch((error) => {
      console.error('[template-gym] runner crashed', error);
      process.exit(1);
    });
}
