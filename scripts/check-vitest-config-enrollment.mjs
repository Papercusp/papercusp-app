#!/usr/bin/env node
/**
 * Ensure every declared workspace Vitest config takes part in the green-checkpoint gate.
 *
 * Gate participation means the admin test-runs reporter (the /admin/testing ledger), the
 * per-file pass-proof recorder + executed-inputs capture when the runner arms them, and the
 * per-file pass-reuse skip list. `defineVitestConfig` wires all of it, and a hand-rolled
 * `defineConfig` gets it by spreading `gateParticipationConfig()`; both read one shared
 * fragment in libs/test-config/src/vitest-config.ts.
 *
 * WI-10003716: this guard used to accept a bare `ADMIN_TEST_RUNS_REPORTER_PATH` mention. Twelve
 * configs passed that way while recording zero pass proofs and never reusing one, because the
 * reporter alone is not participation. It now accepts only the two helpers. The allowlist is
 * deliberately exact: these packages use a different runner/config contract and are the only
 * accepted plain configurations.
 *
 * WI-10003808 adds two checks:
 *  - a STALE exemption (an exempt path that is now enrolled, or no longer exists) is a finding,
 *    so the exemption set can only shrink as configs enroll;
 *  - a hand-rolled enrolled config under a NESTED Vite workspace root must also set
 *    `server: gateParticipationServerConfig()`, or its jsdom files cannot load the gate's setup
 *    file from libs/test-config. The nested root is DERIVED from Vite's own
 *    `searchForWorkspaceRoot`, never a hand list.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsAndStrings } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VITEST_CONFIG_NAME = /^vitest\.config\.[^/]+$/;
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.papercusp',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

/**
 * These configs intentionally do not use the shared Vitest base. Keep this set
 * path-specific so adding a new plain config cannot silently become an exemption.
 * An entry that enrolls or disappears is reported as stale (findStaleExemptions).
 */
export const PLAIN_CONFIG_EXEMPTIONS = new Set([
  // Standalone public packages (WI-4973): each is its own GitHub repo that must install and test
  // with only its own declared deps. @papercusp/test-config is private and unpublished, so a
  // standalone clone cannot resolve it, and enrolling would break that clone. These stay
  // gate-silent by design: the arming-time classifier (resolveTaskReportExpectation) counts them
  // as noReportExpected (`unenrolled-config`), never noReportUnexpected. Decided on WI-10003808:
  // pass-proof reuse over their ~29 small test files is not worth reversing WI-4973.
  // libs/generic/desktop-ipc (github.com/Papercusp/desktop-ipc) is the same class but has NO
  // config file, so it never appears in this set: the classifier counts it `no-config`, expected.
  'libs/generic/card-stack/vitest.config.ts',
  'libs/generic/ipc-endpoint-server/vitest.config.ts',
  'libs/generic/search/vitest.config.ts',
  'libs/agent-chat/vitest.config.ts',
  'libs/generic/git-graph/vitest.config.ts',
  'libs/generic/ui-primitives/vitest.config.ts',
  // node:test package (`node --test src/**/*.node-test.ts`); its vitest config is `include: []`
  // and runs nothing, so it has no pass proofs to record.
  'libs/papercusp/packages/cli/vitest.config.ts',
]);

function normalizePath(filePath) {
  return filePath.split(sep).join('/');
}

/** True when `code` both imports `name` in a named import and calls it. */
function importsAndCalls(code, name) {
  const imported = new RegExp(String.raw`import\s*\{[\s\S]*?\b${name}\b[\s\S]*?\}\s*from\s*['"][^'"]*['"]`).test(code);
  return imported && new RegExp(String.raw`\b${name}\s*\(`).test(code);
}

/**
 * Return true when a config takes part in the gate: it calls the shared base
 * (`defineVitestConfig`) or spreads the gate fragment (`gateParticipationConfig`).
 * Wiring the admin reporter path by hand is NOT enough (WI-10003716).
 */
export function isGateEnrolled(source, fileName) {
  const code = stripCommentsAndStrings(source, fileName);
  return importsAndCalls(code, 'defineVitestConfig') || importsAndCalls(code, 'gateParticipationConfig');
}

/**
 * Find unenrolled configs from an explicit, already-read file list. This pure
 * seam keeps the recurrence rule hermetic and makes the exact exemption logic
 * independently testable.
 */
export function findUnenrolledConfigs(configs) {
  return configs
    .filter(({ path, content }) => !PLAIN_CONFIG_EXEMPTIONS.has(normalizePath(path)) && !isGateEnrolled(content, path))
    .map(({ path }) => normalizePath(path))
    .sort();
}

/**
 * Exempt paths that no longer earn their exemption: the config now takes part in the gate, or it
 * is not among the collected configs at all. Each is reported with the reason.
 */
export function findStaleExemptions(configs, exemptions = PLAIN_CONFIG_EXEMPTIONS) {
  const byPath = new Map(configs.map(({ path, content }) => [normalizePath(path), content]));
  const stale = [];
  for (const exempt of exemptions) {
    if (!byPath.has(exempt)) stale.push(`${exempt} (missing: no such declared workspace config)`);
    else if (isGateEnrolled(byPath.get(exempt), exempt)) stale.push(`${exempt} (enrolled: remove the exemption)`);
  }
  return stale.sort();
}

/**
 * Hand-rolled enrolled configs (gateParticipationConfig without defineVitestConfig) whose Vite
 * workspace root is not the repository root and which do not call gateParticipationServerConfig().
 * `workspaceRootOf(absoluteConfigDir)` must answer what Vite answers (searchForWorkspaceRoot);
 * it is injected so this rule stays hermetic and the module never loads Vite at import time
 * (scripts/lib/executed-source-map.mjs imports this module on the gate's hot path).
 */
export function findNestedRootConfigsWithoutServerFragment(configs, workspaceRootOf, root = ROOT) {
  const repoRoot = resolve(root);
  return configs
    .filter(({ path, content }) => {
      const code = stripCommentsAndStrings(content, path);
      if (!importsAndCalls(code, 'gateParticipationConfig') || importsAndCalls(code, 'defineVitestConfig')) return false;
      if (importsAndCalls(code, 'gateParticipationServerConfig')) return false;
      return resolve(workspaceRootOf(join(repoRoot, dirname(path)))) !== repoRoot;
    })
    .map(({ path }) => normalizePath(path))
    .sort();
}

function workspacePatterns(rootPackage) {
  const workspaces = rootPackage.workspaces;
  return Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [];
}

function declaredWorkspaceDirs(root = ROOT) {
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dirs = new Set();
  for (const pattern of workspacePatterns(rootPackage)) {
    if (pattern.endsWith('/*')) {
      const base = pattern.slice(0, -2);
      const absoluteBase = join(root, base);
      if (!existsSync(absoluteBase)) continue;
      for (const entry of readdirSync(absoluteBase, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(join(absoluteBase, entry.name, 'package.json'))) {
          dirs.add(join(base, entry.name));
        }
      }
      continue;
    }
    if (existsSync(join(root, pattern, 'package.json'))) dirs.add(pattern);
  }
  return [...dirs].sort();
}

function collectWorkspaceConfigs(workspaceDir, root, out) {
  const absoluteDir = join(root, workspaceDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        collectWorkspaceConfigs(join(workspaceDir, entry.name), root, out);
      }
      continue;
    }
    if (!entry.isFile() || !VITEST_CONFIG_NAME.test(entry.name)) continue;
    const absolutePath = join(absoluteDir, entry.name);
    out.push({
      path: normalizePath(relative(root, absolutePath)),
      content: readFileSync(absolutePath, 'utf8'),
    });
  }
}

export function collectVitestConfigs(root = ROOT) {
  const configs = [];
  for (const workspaceDir of declaredWorkspaceDirs(root)) {
    collectWorkspaceConfigs(workspaceDir, root, configs);
  }
  return configs.sort((a, b) => a.path.localeCompare(b.path));
}

export async function main(root = ROOT) {
  const configs = collectVitestConfigs(root);
  const { searchForWorkspaceRoot } = await import('vite');
  const sections = [
    [
      'Vitest configs that do not take part in the green-checkpoint gate:',
      findUnenrolledConfigs(configs),
      [
        'Use defineVitestConfig from @papercusp/test-config/vitest-config, or spread',
        'gateParticipationConfig() into a hand-rolled config\'s `test` block. Wiring',
        'ADMIN_TEST_RUNS_REPORTER_PATH by hand records no pass proofs and reuses none.',
      ],
    ],
    [
      'Stale PLAIN_CONFIG_EXEMPTIONS entries (scripts/check-vitest-config-enrollment.mjs):',
      findStaleExemptions(configs),
      ['Remove each from the set: an enrolled or missing config no longer needs an exemption.'],
    ],
    [
      'Enrolled configs under a nested Vite workspace root without the server fragment:',
      findNestedRootConfigsWithoutServerFragment(configs, (dir) => searchForWorkspaceRoot(dir), root),
      [
        'Set `server: gateParticipationServerConfig()` (from @papercusp/test-config/vitest-config).',
        'Vite\'s default fs.allow stops at the nested root, so jsdom files cannot load the gate\'s',
        'setup file from libs/test-config.',
      ],
    ],
  ];
  const failing = sections.filter(([, findings]) => findings.length > 0);
  if (failing.length > 0) {
    console.error(
      failing
        .flatMap(([heading, findings, advice]) => [heading, ...findings.map((f) => `  ${f}`), '', ...advice, ''])
        .join('\n'),
    );
    return 1;
  }
  console.log('Vitest config enrollment: all declared workspace configs take part in the gate or are explicitly exempt.');
  return 0;
}

// No top-level await here: this module is IMPORTED on the gate's hot path (executed-source-map.mjs,
// test-config/vitest-config.ts), and a loader that transforms it to CJS rejects top-level await at
// transform time — that took the green-checkpoint down before any suite ran (WI-10003808).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
