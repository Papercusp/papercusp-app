/**
 * serving-runtimes.ts — WHICH runtimes execute a path, and does EACH of them run the
 * change as it stands? (acceptance-runtime-plane-not-main-2026-09-23 P-001)
 *
 * `dev:pipeline_position` grew up answering one question — "has this reached :3070?" —
 * because the release operator is the one process the git pipeline activates. Every
 * other long-lived runtime on this box loads code by a different route (bg-host, the
 * gateway and the embed sidecar bundle the canonical tree on start; the staging operator
 * runs its own `origin/staging` checkout; each psu session's pty host loads its script at
 * launch). Measured 2026-09-23 on psu-pty-turn-boundary-generalization: the ingest
 * routine had been running the fix in bg-host since 23:58Z while the tool said
 * `deployed:false, blockedOn:gate`, and both the implementer and the independent grader
 * read that as "wait for main". Nobody needed main.
 *
 * So this leg reports, per runtime, the runtime's OWN measured build identity and a
 * three-valued `containsChange`: true / false / null-with-a-reason. It never copies the
 * :3070 `deployed` flag into another runtime's row, and an unmeasurable runtime is null,
 * never false — "I could not tell" and "it does not run your change" are different
 * instructions to a reader who is deciding whether to wait.
 *
 * Runtime OWNERSHIP still comes from the hand-maintained map in git-pipeline-position.ts
 * (see the note there on why it is not derived from the import graph). This module only
 * translates owner hosts into runtimes and measures each one.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { cellUnknown, formatCellUnknown, type CellUnknown } from './cell-contract';
import type { RuntimeVintageRow } from './runtime-vintage';
import type { RuntimeHost, RuntimeOwnership } from './git-pipeline-position';
import { RESTART_TARGET_UNITS } from './agent-tools/dev/restart-target-units';

/** Every runtime a live/deployed acceptance BAR may name as its evidence runtime. */
export const SERVING_RUNTIME_IDS = [
  'release-operator',
  'staging-operator',
  'bg-host',
  'gateway',
  'embed-sidecar',
  'psu-pty-host',
  'desktop-shell',
] as const;
export type ServingRuntimeId = (typeof SERVING_RUNTIME_IDS)[number];

export type ServingRuntimeCodeSource =
  | 'release-checkout'
  | 'staging-checkout'
  | 'canonical-tree'
  | 'per-session-launch'
  | 'desktop-build';

export interface ServingRuntimeSpec {
  id: ServingRuntimeId;
  label: string;
  /** Does the staging→green-main→deploy pipeline carry code into this runtime? */
  releasePipelineApplies: boolean;
  codeSource: ServingRuntimeCodeSource;
  /** systemd --user unit, when the runtime is a single long-lived service. */
  unit: string | null;
  /** Loopback port whose `/api/health` reports the build sha, when there is one. */
  healthPort: number | null;
  /** Literal runtime-vintage unit label, when the runtime reports under a fixed one. */
  vintageUnit: string | null;
  /** Aliases a human or an agent writes for this runtime (used to recognise citations). */
  aliases: readonly string[];
  activation: string;
}

export const SERVING_RUNTIMES: Readonly<Record<ServingRuntimeId, ServingRuntimeSpec>> = {
  'release-operator': {
    id: 'release-operator',
    label: ':3070 release operator (green main)',
    releasePipelineApplies: true,
    codeSource: 'release-checkout',
    unit: RESTART_TARGET_UNITS.dev,
    healthPort: 3070,
    vintageUnit: 'hono-host:3070',
    aliases: ['release-operator', ':3070', '3070', 'release operator', 'green main', 'papercup-release'],
    activation: 'the green pipeline (git-sync → green main → deploy); a deploy restarts it on the new pin',
  },
  'staging-operator': {
    id: 'staging-operator',
    label: ':3170 staging operator (origin/staging checkout)',
    releasePipelineApplies: false,
    codeSource: 'staging-checkout',
    unit: RESTART_TARGET_UNITS.staging,
    healthPort: 3170,
    vintageUnit: 'hono-host:3170',
    aliases: ['staging-operator', ':3170', '3170', 'staging operator'],
    activation:
      'git-sync publishes to origin/staging, then dev:restart { target: "staging", confirm: true, authorize: true, reason: "<why>" } reloads it',
  },
  'bg-host': {
    id: 'bg-host',
    label: 'bg-host (routines, sweeps, watchdogs; canonical tree)',
    releasePipelineApplies: false,
    codeSource: 'canonical-tree',
    unit: RESTART_TARGET_UNITS['bg-host'],
    healthPort: null,
    vintageUnit: null,
    aliases: ['bg-host', 'bghost', 'background host', 'routines engine', ':3271', '3271'],
    activation:
      'bundles the canonical tree on start — dev:restart { target: "bg-host", confirm: true, authorize: true, reason: "<why>" }; a deploy never carries it',
  },
  gateway: {
    id: 'gateway',
    label: 'inference gateway :8788 (canonical tree)',
    releasePipelineApplies: false,
    codeSource: 'canonical-tree',
    unit: RESTART_TARGET_UNITS.gateway,
    healthPort: null,
    vintageUnit: 'gateway',
    aliases: ['gateway', 'inference gateway', ':8788', '8788'],
    activation:
      'runs the canonical tree — dev:restart { target: "gateway", confirm: true, authorize: true, reason: "<why>" }; a deploy never carries it',
  },
  'embed-sidecar': {
    id: 'embed-sidecar',
    label: 'embed sidecar :3384 (canonical tree, bundled on start)',
    releasePipelineApplies: false,
    codeSource: 'canonical-tree',
    unit: RESTART_TARGET_UNITS['embed-sidecar'],
    healthPort: null,
    vintageUnit: null,
    aliases: ['embed-sidecar', 'embed sidecar', ':3384', '3384'],
    activation:
      'bundles the canonical tree on ExecStartPre — dev:restart { target: "embed-sidecar", confirm: true, authorize: true, reason: "<why>" }',
  },
  'psu-pty-host': {
    id: 'psu-pty-host',
    label: 'psu pty hosts (one per psu session, loaded at launch)',
    releasePipelineApplies: false,
    codeSource: 'per-session-launch',
    unit: null,
    healthPort: null,
    vintageUnit: null,
    aliases: ['psu-pty-host', 'pty host', 'pty-host', 'psu-launcher', 'psu session'],
    activation:
      'each psu session loads apps/operator/scripts/psu-pty-host.mjs when it launches — every NEW session runs the current file; running sessions keep the version they started with',
  },
  'desktop-shell': {
    id: 'desktop-shell',
    label: 'Tauri desktop shell (compiled binary)',
    releasePipelineApplies: false,
    codeSource: 'desktop-build',
    unit: null,
    healthPort: null,
    vintageUnit: null,
    aliases: ['desktop-shell', 'desktop', 'tauri', 'desktop sidecar'],
    activation: 'compiled into the desktop binary — rebuild the shell (cd papercusp-desktop && npm run dev)',
  },
};

/**
 * A test class is not the same thing as a serving process. These routes name
 * the current-build source and the isolation boundary an agent must verify
 * before executing a test. A gap stays a gap until its runner exists; :3170
 * cannot stand in for bg-host, a desktop binary, or a second machine.
 */
export const CURRENT_BUILD_TEST_CLASSES = [
  {
    id: 'unit-integration',
    source: 'canonical staging tree',
    runtime: null,
    route: 'npm run test:file -- <exact test path>',
    routeFile: 'scripts/test-files.mjs',
    isolation: 'Test process only; database and external effects depend on the named suite.',
    prerequisites: ['Exact test path', 'suite-specific fixture and database ownership'],
    verification: 'Stamped test run with the exact source revision and fixture identity.',
    readiness: 'ready',
  },
  {
    id: 'operator-api',
    source: 'origin/staging mirror, not the uncommitted edit tree',
    runtime: 'staging-operator',
    route: 'http://127.0.0.1:3170 after dev:pipeline_position containment check',
    routeFile: 'apps/operator/scripts/systemd/papercup-staging-api.service.d/50-staging-checkout.conf',
    isolation: 'Separate port, process and checkout; database and workspace are not isolated.',
    prerequisites: ['Containing staging commit loaded', 'private test identity/data for writes'],
    verification: 'Measured :3170 build identity plus request/response on that build.',
    readiness: 'ready',
  },
  {
    id: 'background-federation',
    source: 'canonical tree loaded by bg-host, not the :3170 API bundle',
    runtime: 'bg-host',
    route: 'node scripts/with-test-pg.mjs --isolated-runtime -- <current-build background assertion>',
    routeFile: 'scripts/with-test-pg.mjs',
    isolation: 'Disposable migrated DB, HOME/device keychain, workspace and ports; runtime credentials stripped.',
    prerequisites: ['Current-build background command', 'local embedded PG and migration assets', 'explicit teardown assertion'],
    verification: 'Actual child environment and build identity, background behavior, private-state write and cleanup receipt.',
    readiness: 'requires-prerequisites',
  },
  {
    id: 'migration',
    source: 'current Tauri verifier source snapshot',
    runtime: 'desktop-shell',
    route: 'VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh -- <assertion>',
    routeFile: 'scripts/verify-tauri-headless.sh',
    isolation: 'Disposable embedded PG, workspace, home and WebView profile; not a full bg-host.',
    prerequisites: ['Embedded PG prerequisites', 'explicit migration/restore assertion'],
    verification: 'Applied migration identity, isolated database and teardown receipt.',
    readiness: 'requires-prerequisites',
  },
  {
    id: 'desktop-native',
    source: 'frozen current-build SPA and locally compiled Tauri shell',
    runtime: 'desktop-shell',
    route: 'scripts/verify-tauri-headless.sh -- <native assertion>',
    routeFile: 'scripts/verify-tauri-headless.sh',
    isolation: 'Display, ports and process only by default; opt into isolated DB for writes.',
    prerequisites: ['Matching OS/native dependencies', 'VERIFY_TAURI_ISOLATED_DB=1 for write paths'],
    verification: 'Bridge process provenance, compiled binary and native assertion.',
    readiness: 'requires-prerequisites',
  },
  {
    id: 'multi-machine-p2p-git',
    source: 'current staging rig payload with a sealed file manifest',
    runtime: null,
    route: 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh --no-push, then protected rig launch',
    routeFile: 'papercusp-desktop/bin/vm-rig/compose-rig-sidecar-current.sh',
    isolation: 'Code payload only; rig database and identity remain shared with its running rig.',
    prerequisites: ['Two distinct reachable machines', 'rig custody and data backup', 'test identities'],
    verification: 'Manifest and source stamp on each peer, real coordination/Git convergence and restoration.',
    readiness: 'requires-prerequisites',
  },
  {
    id: 'candidate-install-upgrade',
    source: 'packaged current-build candidate, not the :3170 service',
    runtime: 'desktop-shell',
    route: 'packaged-candidate lifecycle route (P-004)',
    routeFile: null,
    isolation: 'Candidate install target and previous version must be explicitly owned.',
    prerequisites: ['Target platform', 'signing/install credentials', 'rollback target'],
    verification: 'Exact package hash, install/upgrade result and rollback receipt.',
    readiness: 'gap',
  },
  {
    id: 'final-release',
    source: 'green main release artifact',
    runtime: 'release-operator',
    route: 'release verification on the deployed :3070 artifact',
    routeFile: null,
    isolation: 'Real release; not a substitute for a pre-release functional test route.',
    prerequisites: ['Green candidate', 'release authorization'],
    verification: 'Exact shipped artifact and production deploy/rollback result.',
    readiness: 'release-only',
  },
] as const satisfies ReadonlyArray<{
  id: string;
  source: string;
  runtime: ServingRuntimeId | null;
  route: string;
  routeFile: string | null;
  isolation: string;
  prerequisites: readonly string[];
  verification: string;
  readiness: 'ready' | 'requires-prerequisites' | 'gap' | 'release-only';
}>;

export type CurrentBuildTestClassId = (typeof CURRENT_BUILD_TEST_CLASSES)[number]['id'];
export type CurrentBuildTestRoute = (typeof CURRENT_BUILD_TEST_CLASSES)[number];

/** One maintained route, or null for a caller spelling we have not audited. */
export function currentBuildTestRoute(id: string): CurrentBuildTestRoute | null {
  return CURRENT_BUILD_TEST_CLASSES.find((route) => route.id === id) ?? null;
}

/** An owning runtime may serve more than one test class; never infer universal readiness. */
export function currentBuildRoutesForRuntime(runtime: ServingRuntimeId): CurrentBuildTestRoute[] {
  return CURRENT_BUILD_TEST_CLASSES.filter((route) => route.runtime === runtime && route.readiness !== 'release-only');
}

/** The runtimes that EXECUTE code classified to an ownership host. */
export function runtimesForHost(host: RuntimeHost): ServingRuntimeId[] {
  switch (host) {
    // The operator's code is served by TWO processes on two routes: the release
    // checkout (:3070, green main) and the staging checkout (:3170, origin/staging).
    case 'operator-release':
      return ['release-operator', 'staging-operator'];
    case 'bg-host':
      return ['bg-host'];
    case 'gateway':
      return ['gateway'];
    case 'embed-sidecar':
      return ['embed-sidecar'];
    case 'psu-pty-host':
      return ['psu-pty-host'];
    case 'tauri-desktop':
      return ['desktop-shell'];
  }
}

/** Shared library code is also LOADED by every canonical-tree host. */
export function isSharedLibraryPath(relPath: string): boolean {
  return /^(packages\/operator-core\/lib|libs)\//.test(relPath.replace(/^\.?\//, ''));
}

export interface ServingRuntimeSelection {
  runtime: ServingRuntimeId;
  role: 'owner' | 'shared';
}

/**
 * Owner runtimes first (declared order), then — for shared library code only — the
 * canonical-tree hosts that may also load it. Bounded: at most the seven catalog rows.
 */
export function selectServingRuntimes(
  relPath: string | null,
  owners: ReadonlyArray<Pick<RuntimeOwnership, 'host'>> | null,
): ServingRuntimeSelection[] {
  if (!relPath || !owners) return [];
  const out: ServingRuntimeSelection[] = [];
  const seen = new Set<ServingRuntimeId>();
  for (const owner of owners) {
    for (const runtime of runtimesForHost(owner.host)) {
      if (seen.has(runtime)) continue;
      seen.add(runtime);
      out.push({ runtime, role: 'owner' });
    }
  }
  if (isSharedLibraryPath(relPath)) {
    for (const runtime of ['release-operator', 'staging-operator', 'bg-host', 'gateway'] as const) {
      if (seen.has(runtime)) continue;
      seen.add(runtime);
      out.push({ runtime, role: 'shared' });
    }
  }
  return out;
}

export interface ServingRuntimeInstances {
  total: number;
  /** Instances that started after the file last changed on disk. */
  current: number;
}

/** Everything measured about one runtime. Every field is independently nullable. */
export interface ServingRuntimeProbe {
  runtime: ServingRuntimeId;
  role: 'owner' | 'shared';
  pid: number | null;
  startedAtMs: number | null;
  buildSha: string | null;
  buildShaSource: 'health' | 'runtime-vintage' | null;
  /** Blob containment at `buildSha`: does that commit carry this path's current content? */
  blobContains: boolean | null;
  blobUnknown: CellUnknown | null;
  /** mtime of the path in the canonical tree (what a canonical-tree host bundles). */
  fileMtimeMs: number | null;
  instances: ServingRuntimeInstances | null;
}

export interface ServingRuntimeEntry {
  runtime: ServingRuntimeId;
  label: string;
  role: 'owner' | 'shared';
  releasePipelineApplies: boolean;
  codeSource: ServingRuntimeCodeSource;
  pid: number | null;
  startedAtMs: number | null;
  buildSha: string | null;
  buildShaSource: 'health' | 'runtime-vintage' | null;
  /** TRUE — this runtime executes the change as it stands. FALSE — measured, it does not.
   *  NULL — could not be measured; `unknownReason` says why. Never copied from :3070. */
  containsChange: boolean | null;
  method: 'blob' | 'start-after-mtime' | 'instances' | null;
  instances: ServingRuntimeInstances | null;
  unknownReason: CellUnknown | null;
  activation: string;
}

function entryBase(probe: ServingRuntimeProbe): Omit<ServingRuntimeEntry, 'containsChange' | 'method' | 'unknownReason'> {
  const spec = SERVING_RUNTIMES[probe.runtime];
  return {
    runtime: probe.runtime,
    label: spec.label,
    role: probe.role,
    releasePipelineApplies: spec.releasePipelineApplies,
    codeSource: spec.codeSource,
    pid: probe.pid,
    startedAtMs: probe.startedAtMs,
    buildSha: probe.buildSha,
    buildShaSource: probe.buildShaSource,
    instances: probe.instances,
    activation: spec.activation,
  };
}

/**
 * PURE verdict per runtime. The rules differ by how the runtime RECEIVES code, and
 * getting that wrong inverts the answer:
 *  - a checkout host (release/staging operator) runs exactly the commit it reports, so
 *    blob containment at that sha is the whole answer;
 *  - a canonical-tree host bundles the WORKING TREE on start, so a matching blob at its
 *    boot HEAD is sufficient, and "started after the file last changed" is equally
 *    sufficient (it loaded an edit that was uncommitted at boot);
 *  - a per-session runtime is many processes of different ages, so it answers with
 *    instance counts;
 *  - a compiled binary has no probe at all.
 */
export function evaluateServingRuntime(probe: ServingRuntimeProbe): ServingRuntimeEntry {
  const spec = SERVING_RUNTIMES[probe.runtime];
  const base = entryBase(probe);
  const unknown = (code: CellUnknown['code'], detail: string): ServingRuntimeEntry => ({
    ...base,
    containsChange: null,
    method: null,
    unknownReason: cellUnknown(code, detail),
  });

  if (spec.codeSource === 'desktop-build') {
    return unknown(
      'not-applicable',
      'The desktop shell is compiled into the installed binary; no runtime probe can read which source it was built from.',
    );
  }

  if (spec.codeSource === 'per-session-launch') {
    if (probe.fileMtimeMs === null) {
      return unknown('insufficient-data', 'Could not read when this file last changed, so no session can be compared against it.');
    }
    if (!probe.instances) {
      return unknown('resolver-failed', 'Could not enumerate the live psu sessions (no /proc on this host, or the scan failed).');
    }
    if (probe.instances.total === 0) {
      return unknown('insufficient-data', 'No psu session is running, so no pty host has loaded any version of this file.');
    }
    return {
      ...base,
      containsChange: probe.instances.current > 0,
      method: 'instances',
      unknownReason: null,
    };
  }

  if (spec.codeSource === 'release-checkout' || spec.codeSource === 'staging-checkout') {
    if (!probe.buildSha) {
      return unknown(
        'insufficient-data',
        `${spec.label} reported no build sha (health endpoint unreachable and no runtime-vintage row for its current process).`,
      );
    }
    if (probe.blobContains === null) {
      return {
        ...base,
        containsChange: null,
        method: null,
        unknownReason:
          probe.blobUnknown ??
          cellUnknown('resolver-failed', `Could not compare this path at build ${probe.buildSha.slice(0, 10)} with the tree.`),
      };
    }
    return { ...base, containsChange: probe.blobContains, method: 'blob', unknownReason: null };
  }

  // canonical-tree host
  if (probe.pid === null && probe.startedAtMs === null && probe.buildSha === null) {
    return unknown('insufficient-data', `${spec.label} is not running (no process for ${spec.unit ?? 'its unit'}).`);
  }
  if (probe.blobContains === true) {
    return { ...base, containsChange: true, method: 'blob', unknownReason: null };
  }
  if (probe.startedAtMs !== null && probe.fileMtimeMs !== null) {
    return {
      ...base,
      containsChange: probe.startedAtMs > probe.fileMtimeMs,
      method: 'start-after-mtime',
      unknownReason: null,
    };
  }
  return unknown(
    'insufficient-data',
    `${spec.label}: no matching blob at its reported build and no start-time/mtime pair to decide whether it loaded the working-tree file.`,
  );
}

export function evaluateServingRuntimes(probes: ReadonlyArray<ServingRuntimeProbe>): ServingRuntimeEntry[] {
  return probes.map(evaluateServingRuntime);
}

function runtimeRef(entry: ServingRuntimeEntry): string {
  const build = entry.buildSha
    ? ` build ${entry.buildSha.slice(0, 10)}`
    : entry.instances
      ? ` ${entry.instances.current}/${entry.instances.total} sessions`
      : '';
  return `${entry.runtime}${build}`;
}

/**
 * The one line a reader stops at. Emitted ONLY when the answer changes what they should
 * do — i.e. the change is already executing on a runtime that is not the release
 * operator. Null otherwise, so every existing summary is byte-identical when this leg
 * has nothing to add.
 */
export function servingRuntimesLead(entries: ReadonlyArray<ServingRuntimeEntry> | null | undefined): string | null {
  if (!entries?.length) return null;
  const owners = entries.filter((e) => e.role === 'owner');
  if (owners.length === 0) return null;
  const liveNonRelease = owners.filter((e) => !e.releasePipelineApplies && e.containsChange === true);
  if (liveNonRelease.length === 0) return null;
  const releaseOwners = owners.filter((e) => e.releasePipelineApplies);
  const where = liveNonRelease.map(runtimeRef).join(' + ');
  if (releaseOwners.length === 0 && owners.every((e) => e.containsChange === true)) {
    return (
      `LIVE NOW on ${where} — every runtime that executes this path already runs the change, and none of them ` +
      `receives code from green main, so acceptance measured there does NOT wait on main or a :3070 deploy. `
    );
  }
  const releaseLacks = releaseOwners.filter((e) => e.containsChange !== true);
  if (releaseLacks.length > 0) {
    return (
      `LIVE NOW on ${where}; ${releaseLacks.map((e) => e.runtime).join(' + ')} does not run it yet. ` +
      `Only acceptance that must be measured on the release operator waits on main — measure everything else on ${liveNonRelease
        .map((e) => e.runtime)
        .join(' / ')} now. `
    );
  }
  return null;
}

/** Compact prose for notes/advisories: one clause per runtime. */
export function describeServingRuntimes(entries: ReadonlyArray<ServingRuntimeEntry>): string {
  return entries
    .map((e) => {
      const verdict =
        e.containsChange === true
          ? 'runs it'
          : e.containsChange === false
            ? 'does NOT run it'
            : `unknown (${e.unknownReason ? formatCellUnknown(e.unknownReason) : 'not measured'})`;
      return `${runtimeRef(e)} [${e.role}]: ${verdict}`;
    })
    .join('; ');
}

/** Resolve a free-form runtime mention ("bg-host", ":3170", "green main") to its id. */
export function resolveServingRuntimeAlias(text: string): ServingRuntimeId | null {
  const needle = text.trim().toLowerCase();
  if (!needle) return null;
  for (const id of SERVING_RUNTIME_IDS) {
    if (needle === id) return id;
  }
  for (const id of SERVING_RUNTIME_IDS) {
    if (SERVING_RUNTIMES[id].aliases.some((alias) => alias.toLowerCase() === needle)) return id;
  }
  return null;
}

/** Every runtime id or alias mentioned anywhere in `text` (word-bounded). */
export function servingRuntimesMentioned(text: string): ServingRuntimeId[] {
  const hay = ` ${text.toLowerCase()} `;
  const found: ServingRuntimeId[] = [];
  for (const id of SERVING_RUNTIME_IDS) {
    const tokens = [id, ...SERVING_RUNTIMES[id].aliases].map((t) => t.toLowerCase());
    const hit = tokens.some((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Bare port numbers are only recognised with their colon, so "3070 rows" in a count
      // does not read as a runtime citation.
      if (/^\d+$/.test(token)) return false;
      return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, 'i').test(hay);
    });
    if (hit) found.push(id);
  }
  return found;
}

/* ------------------------------------------------------------------------- *
 * Real probes. Each fails SOFT to null — a failed probe is an unknown row,
 * never a false one, and never a thrown resolver.
 * ------------------------------------------------------------------------- */

export interface ServingRuntimeProbeDeps {
  probeUnitStart: (unit: string) => Promise<{ pid: number | null; startedAtMs: number | null } | null>;
  probeHealthSha?: (port: number) => Promise<string | null>;
  vintageRows: ReadonlyArray<RuntimeVintageRow>;
  localHost: string;
  /** Read `/proc/<pid>/cgroup`; null when unreadable. */
  readCgroup?: (pid: number) => Promise<string | null>;
  /** Blob containment of the path at a commit (true/false/null + reason). */
  blobContainsAt: (sha: string) => Promise<{ contains: boolean | null; unknown: CellUnknown | null }>;
  fileMtimeMs: number | null;
  listPtyHostInstances?: () => Promise<Array<{ pid: number; startedAtMs: number }> | null>;
}

const HEALTH_TIMEOUT_MS = 1_000;

export async function realProbeHealthSha(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { sha?: unknown } | null;
    return typeof body?.sha === 'string' && body.sha.trim() ? body.sha.trim() : null;
  } catch {
    return null;
  }
}

export async function realReadCgroup(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/cgroup`, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The runtime-vintage row for a unit's CURRENT process. A service's MainPID is often a
 * wrapper shell while the reporting Node process is its child, so an exact-pid join
 * misses the row; cgroup membership is the kernel's own answer to "is this pid part of
 * that unit". A row reported before the unit's current start belongs to a previous
 * generation and is never used.
 */
export async function pickVintageForUnit(args: {
  unit: string;
  mainPid: number | null;
  startedAtMs: number | null;
  rows: ReadonlyArray<RuntimeVintageRow>;
  localHost: string;
  vintageUnit: string | null;
  readCgroup: (pid: number) => Promise<string | null>;
}): Promise<RuntimeVintageRow | null> {
  const fresh = args.rows.filter((row) => {
    if (row.host !== args.localHost || !row.treeSha) return false;
    if (args.startedAtMs === null) return true;
    const reportedAtMs = Date.parse(row.reportedAt);
    return Number.isFinite(reportedAtMs) && reportedAtMs >= args.startedAtMs - 5_000;
  });
  const byPid = args.mainPid !== null ? fresh.find((row) => row.pid === args.mainPid) : undefined;
  if (byPid) return byPid;
  for (const row of fresh) {
    if (row.pid === null) continue;
    if (args.vintageUnit && row.unit !== args.vintageUnit) continue;
    const cgroup = await args.readCgroup(row.pid);
    if (cgroup && cgroup.includes(args.unit)) return row;
  }
  return null;
}

export async function probeServingRuntime(
  selection: ServingRuntimeSelection,
  deps: ServingRuntimeProbeDeps,
): Promise<ServingRuntimeProbe> {
  const spec = SERVING_RUNTIMES[selection.runtime];
  const probe: ServingRuntimeProbe = {
    runtime: selection.runtime,
    role: selection.role,
    pid: null,
    startedAtMs: null,
    buildSha: null,
    buildShaSource: null,
    blobContains: null,
    blobUnknown: null,
    fileMtimeMs: deps.fileMtimeMs,
    instances: null,
  };
  if (spec.codeSource === 'desktop-build') return probe;
  if (spec.codeSource === 'per-session-launch') {
    const list = await (deps.listPtyHostInstances ?? realListPtyHostInstances)().catch(() => null);
    if (list) {
      const mtime = deps.fileMtimeMs;
      probe.instances = {
        total: list.length,
        current: mtime === null ? 0 : list.filter((i) => i.startedAtMs > mtime).length,
      };
    }
    return probe;
  }
  if (spec.unit) {
    const started = await deps.probeUnitStart(spec.unit).catch(() => null);
    probe.pid = started?.pid ?? null;
    probe.startedAtMs = started?.startedAtMs ?? null;
  }
  if (spec.healthPort !== null) {
    const sha = await (deps.probeHealthSha ?? realProbeHealthSha)(spec.healthPort).catch(() => null);
    if (sha) {
      probe.buildSha = sha;
      probe.buildShaSource = 'health';
    }
  }
  if (!probe.buildSha && spec.unit && (probe.pid !== null || probe.startedAtMs !== null)) {
    const row = await pickVintageForUnit({
      unit: spec.unit,
      mainPid: probe.pid,
      startedAtMs: probe.startedAtMs,
      rows: deps.vintageRows,
      localHost: deps.localHost,
      vintageUnit: spec.vintageUnit,
      readCgroup: deps.readCgroup ?? realReadCgroup,
    }).catch(() => null);
    if (row?.treeSha) {
      probe.buildSha = row.treeSha;
      probe.buildShaSource = 'runtime-vintage';
    }
  }
  if (probe.buildSha) {
    const blob = await deps.blobContainsAt(probe.buildSha).catch(() => ({
      contains: null,
      unknown: cellUnknown('resolver-failed', 'blob containment read threw'),
    }));
    probe.blobContains = blob.contains;
    probe.blobUnknown = blob.unknown;
  }
  return probe;
}

export async function resolveServingRuntimes(
  selections: ReadonlyArray<ServingRuntimeSelection>,
  deps: ServingRuntimeProbeDeps,
): Promise<ServingRuntimeEntry[]> {
  const probes = await Promise.all(selections.map((s) => probeServingRuntime(s, deps)));
  return evaluateServingRuntimes(probes);
}

/** Boot time in ms since epoch, from /proc/stat. */
async function bootTimeMs(): Promise<number | null> {
  try {
    const statText = await readFile('/proc/stat', 'utf8');
    const m = /^btime\s+(\d+)/m.exec(statText);
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

/** Linux USER_HZ is 100 on every kernel this runs on (same assumption as release-checkpoint-launch). */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Live psu sessions: every process whose argv runs psu-launcher.mjs (which imports
 * psu-pty-host.mjs in-process at launch). Returns null when /proc is unavailable.
 */
export async function realListPtyHostInstances(): Promise<Array<{ pid: number; startedAtMs: number }> | null> {
  const btime = await bootTimeMs();
  if (btime === null) return null;
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return null;
  }
  const out: Array<{ pid: number; startedAtMs: number }> = [];
  await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const cmdline = await readFile(`/proc/${name}/cmdline`, 'utf8');
          if (!cmdline.split('\0').some((arg) => path.basename(arg) === 'psu-launcher.mjs')) return;
          const statLine = await readFile(`/proc/${name}/stat`, 'utf8');
          // Field 22 (starttime) counted after the ")" that closes the comm field.
          const rest = statLine.slice(statLine.lastIndexOf(')') + 2).split(' ');
          const startTicks = Number(rest[19]);
          if (!Number.isFinite(startTicks)) return;
          out.push({ pid: Number(name), startedAtMs: btime + (startTicks / CLOCK_TICKS_PER_SECOND) * 1000 });
        } catch {
          // process exited mid-scan or is not ours — skip
        }
      }),
  );
  return out;
}

export async function realFileMtimeMs(absPath: string): Promise<number | null> {
  try {
    return (await stat(absPath)).mtimeMs;
  } catch {
    return null;
  }
}
