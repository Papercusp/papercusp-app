/**
 * P-014 — the capless gateway's cross-lane conformance, saturation, chaos,
 * restart, and failure battery.
 *
 * WHY THIS MODULE EXISTS RATHER THAN A LONGER TEST FILE
 * -----------------------------------------------------
 * P-014's acceptance is a *coverage* claim over a matrix: "cover Claude, Codex,
 * local backends, pinned/unpinned, streaming/non-streaming, maintenance/control,
 * single/multi-account, development/systemd/packaged/container ... at 1/10/24/28/
 * 30/64/100/256/300 and beyond." A coverage claim written as prose in a plan, a
 * work-item, or a test-file comment is a second copy of a truth the tests own,
 * and it drifts the moment a case is renamed, skipped, or quietly deleted — the
 * exact failure mode the repo's derive/pin/attest ladder exists to stop.
 *
 * So the matrix is DECLARED here as data, and the battery ATTESTS against it at
 * runtime: every declared cell must be dispositioned by a case that actually ran
 * (`ConformanceLedger.record`), or explicitly vacated against a plan Decision
 * (`ConformanceLedger.vacate`). A case that is deleted or skipped leaves its cell
 * missing and the battery's final assertion fails; a case that records a cell the
 * matrix never declared also fails, so the ledger cannot be inflated to look
 * complete. Neither direction is expressible in a comment.
 *
 * THE DEPLOYMENT DIMENSION IS MEASURED, NOT CITED
 * -----------------------------------------------
 * D-014 settled that the packaged desktop app and the container images spawn no
 * gateway at all, which makes those two matrix cells vacuous rather than untested.
 * A frozen citation would rot silently the first time someone adds a gateway to
 * the Tauri sidecar set. `measureGatewayDeploymentSurfaces` therefore RE-RUNS
 * D-014's probes on every battery run, each with the positive control D-014 itself
 * used, so an empty result can never be read as a false absence. If a packaged or
 * container gateway spawn ever appears, the vacuity claim stops being true and the
 * battery fails instead of continuing to cite a decision that no longer holds.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFORMANCE_BATTERY_SCHEMA_VERSION = 'capless-gateway-conformance-battery-v1' as const;

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// ── Matrix dimensions ────────────────────────────────────────────────────────

/** Provider lanes named by P-014: Claude, Codex, local backends. */
export const CONFORMANCE_LANES = ['claude', 'codex', 'local'] as const;
export type ConformanceLane = (typeof CONFORMANCE_LANES)[number];

/** Deployment paths named by P-014. Two of them are vacuous under D-014. */
export const CONFORMANCE_DEPLOYMENTS = ['development', 'systemd', 'packaged', 'container'] as const;
export type ConformanceDeployment = (typeof CONFORMANCE_DEPLOYMENTS)[number];

/**
 * The saturation ladder P-014 names, plus one rung past its "and beyond".
 * 24 is kept deliberately: it is the deleted legacy default, so a regression that
 * reinstates it as a ceiling shows up as a failure at 28 rather than as a silently
 * narrower ladder.
 */
export const CONFORMANCE_SATURATION_LEVELS = [1, 10, 24, 28, 30, 64, 100, 256, 300, 512] as const;
export type ConformanceSaturationLevel = (typeof CONFORMANCE_SATURATION_LEVELS)[number];

/** The former ceiling this plan deleted. Nothing may clamp to it again. */
export const RETIRED_LEGACY_CEILING = 24 as const;

/** Account-shape dimension: a single credential vs a rotation pool. */
export const CONFORMANCE_ACCOUNT_SHAPES = ['single-account', 'multi-account'] as const;
export type ConformanceAccountShape = (typeof CONFORMANCE_ACCOUNT_SHAPES)[number];

/** Request-shape dimensions P-014 names. */
export const CONFORMANCE_BODY_SHAPES = ['streaming', 'non-streaming'] as const;
export type ConformanceBodyShape = (typeof CONFORMANCE_BODY_SHAPES)[number];

export const CONFORMANCE_PIN_MODES = ['pinned', 'unpinned'] as const;
export type ConformancePinMode = (typeof CONFORMANCE_PIN_MODES)[number];

/** Governor classes the gateway admits under. */
export const CONFORMANCE_ADMISSION_CLASSES = ['inference', 'control'] as const;
export type ConformanceAdmissionClass = (typeof CONFORMANCE_ADMISSION_CLASSES)[number];

/**
 * The non-inference request kinds P-014 names explicitly ("maintenance/control").
 * They are separate KINDS that both resolve to the control CLASS, which is exactly
 * why they are worth naming: a regression that starved one while sparing the other
 * would be invisible at class granularity.
 */
export const CONFORMANCE_ADMISSION_KINDS = ['maintenance', 'control'] as const;
export type ConformanceAdmissionKind = (typeof CONFORMANCE_ADMISSION_KINDS)[number];

/** Platforms the gateway is supported on, named by P-014's matrix. */
export const CONFORMANCE_PLATFORMS = ['linux', 'macos', 'windows'] as const;
export type ConformancePlatform = (typeof CONFORMANCE_PLATFORMS)[number];

// ── The six acceptance properties ────────────────────────────────────────────

/**
 * P-014's acceptance sentence, split into the six independently falsifiable
 * properties it actually asserts. The ids are the battery's stable vocabulary:
 * a ledger cell names one of these, never a free-text description.
 */
export const CONFORMANCE_PROPERTIES = Object.freeze({
  ceilingExpansion: 'stable-health-expands-past-every-former-ceiling',
  causalContraction: 'causal-faults-contract-only-responsible-classes-and-expire',
  boundedMemory: 'capacity-queues-with-bounded-resident-memory',
  restartIntegrity: 'restart-or-failover-loses-or-duplicates-no-accepted-work',
  workConserving: 'priority-is-work-conserving',
  writerConsistency: 'state-and-alerts-match-canonical-writers',
} as const);

export type ConformanceProperty = (typeof CONFORMANCE_PROPERTIES)[keyof typeof CONFORMANCE_PROPERTIES];

export const CONFORMANCE_PROPERTY_IDS: readonly ConformanceProperty[] = Object.freeze(
  Object.values(CONFORMANCE_PROPERTIES),
) as readonly ConformanceProperty[];

// ── The declared matrix ──────────────────────────────────────────────────────

/**
 * One requirement = "this property must be demonstrated at every value of this
 * dimension." Properties are deliberately NOT crossed with every dimension: a
 * full cross-product would be ~1,700 cells, and filling it would mean recording
 * cells no case genuinely exercises — coverage theatre that reads exactly like
 * real coverage. Each property below is crossed only with the dimensions its
 * failure mode is actually sensitive to.
 */
export interface ConformanceRequirement {
  readonly property: ConformanceProperty;
  readonly dimension: string;
  readonly values: readonly string[];
  /** Why this property is sensitive to this dimension (and not to the others). */
  readonly rationale: string;
}

const saturationValues: readonly string[] = CONFORMANCE_SATURATION_LEVELS.map((level) => String(level));

export const CONFORMANCE_REQUIREMENTS: readonly ConformanceRequirement[] = Object.freeze([
  {
    property: CONFORMANCE_PROPERTIES.ceilingExpansion,
    dimension: 'saturation',
    values: saturationValues,
    rationale:
      'The deleted 24-wide default was a single number on the admission path, so a reinstated clamp is only visible as a level the ladder cannot reach.',
  },
  {
    property: CONFORMANCE_PROPERTIES.ceilingExpansion,
    dimension: 'lane',
    values: CONFORMANCE_LANES,
    rationale:
      'Claude, Codex, and local backends reached admission through three different call paths before P-010/P-011 unified them; a surviving per-lane cap would only show on its own lane.',
  },
  {
    property: CONFORMANCE_PROPERTIES.causalContraction,
    dimension: 'lane',
    values: CONFORMANCE_LANES,
    rationale: 'Each lane carries its own physical-constraint adapter and its own attribution scope.',
  },
  {
    property: CONFORMANCE_PROPERTIES.causalContraction,
    dimension: 'account-shape',
    values: CONFORMANCE_ACCOUNT_SHAPES,
    rationale:
      'The owner-visible failure ("API errors despite headroom") is specifically a multi-account fault where one account 429s and the global gate contracts anyway.',
  },
  {
    property: CONFORMANCE_PROPERTIES.boundedMemory,
    dimension: 'body-shape',
    values: CONFORMANCE_BODY_SHAPES,
    rationale:
      'D-004 requires bodies spooled before acceptance; a streaming body and a buffered body reach the spool by different routes.',
  },
  {
    property: CONFORMANCE_PROPERTIES.restartIntegrity,
    dimension: 'lane',
    values: CONFORMANCE_LANES,
    rationale: 'Receipts are namespaced per lane, so an exactly-once defect can be lane-local.',
  },
  {
    property: CONFORMANCE_PROPERTIES.workConserving,
    dimension: 'admission-class',
    values: CONFORMANCE_ADMISSION_CLASSES,
    rationale:
      'D-007 forbids per-tier hard ceilings and permanently idle reserves; the violation is per class, not global.',
  },
  {
    property: CONFORMANCE_PROPERTIES.workConserving,
    dimension: 'admission-kind',
    values: CONFORMANCE_ADMISSION_KINDS,
    rationale:
      'P-014 names maintenance and control separately. They share the control class, so only a per-KIND check catches a map change that silently reroutes one of them.',
  },
  {
    property: CONFORMANCE_PROPERTIES.ceilingExpansion,
    dimension: 'platform',
    values: CONFORMANCE_PLATFORMS,
    rationale:
      'P-014 names supported platforms. Admission is platform-independent today, so these cells are vacated against a live scan rather than exercised on three machines this battery cannot reach.',
  },
  {
    property: CONFORMANCE_PROPERTIES.writerConsistency,
    dimension: 'lane',
    values: CONFORMANCE_LANES,
    rationale: 'Every projected surface renders one row per lane; two lanes can disagree independently.',
  },
  {
    property: CONFORMANCE_PROPERTIES.writerConsistency,
    dimension: 'pin-mode',
    values: CONFORMANCE_PIN_MODES,
    rationale:
      'A pinned request carries an accountId into the lane key and an unpinned one does not, so the two produce different lane identities from the same writer.',
  },
  {
    property: CONFORMANCE_PROPERTIES.writerConsistency,
    dimension: 'deployment',
    values: CONFORMANCE_DEPLOYMENTS,
    rationale:
      'P-014 names four deployment paths. Two are vacuous under D-014 and are vacated against a live re-measurement rather than exercised.',
  },
]);

/** `property|dimension=value` — the ledger's cell id. */
export function conformanceCellId(property: ConformanceProperty, dimension: string, value: string): string {
  return `${property}|${dimension}=${value}`;
}

/** Every cell the battery is required to disposition. */
export function enumerateConformanceCells(
  requirements: readonly ConformanceRequirement[] = CONFORMANCE_REQUIREMENTS,
): readonly string[] {
  const cells: string[] = [];
  for (const requirement of requirements) {
    for (const value of requirement.values) {
      cells.push(conformanceCellId(requirement.property, requirement.dimension, value));
    }
  }
  return Object.freeze(cells);
}

// ── The runtime ledger ───────────────────────────────────────────────────────

export type ConformanceDisposition =
  | { readonly kind: 'exercised'; readonly evidence: string }
  | { readonly kind: 'vacuous'; readonly decision: string; readonly evidence: string };

export interface ConformanceLedgerReport {
  readonly schemaVersion: typeof CONFORMANCE_BATTERY_SCHEMA_VERSION;
  readonly declared: number;
  readonly exercised: number;
  readonly vacuous: number;
  /**
   * The vacated cells by id, sorted. Callers pin this SET rather than the count:
   * a count lets one cell quietly become vacuous as long as another stops being.
   */
  readonly vacuousCells: readonly string[];
  /** Declared cells no case dispositioned — a deleted or skipped case shows up here. */
  readonly missing: readonly string[];
  /** Dispositioned cells the matrix never declared — the ledger cannot be inflated. */
  readonly undeclared: readonly string[];
}

/**
 * Runtime attestation of matrix coverage.
 *
 * Deliberately dumb: it records what ran and compares that to what was declared.
 * It holds no opinion about whether a case was a good test — only about whether
 * the cell it claims was declared, and whether every declared cell was claimed.
 */
export class ConformanceLedger {
  readonly #declared: ReadonlySet<string>;
  readonly #dispositions = new Map<string, ConformanceDisposition>();

  constructor(requirements: readonly ConformanceRequirement[] = CONFORMANCE_REQUIREMENTS) {
    this.#declared = new Set(enumerateConformanceCells(requirements));
  }

  /** Record that a case actually exercised this cell. `evidence` names what it proved. */
  record(property: ConformanceProperty, dimension: string, value: string, evidence: string): void {
    this.#put(conformanceCellId(property, dimension, value), { kind: 'exercised', evidence });
  }

  /**
   * Record that this cell cannot be exercised because the thing it names does not
   * exist, citing the plan Decision that established it. `evidence` must carry the
   * measurement, not a restatement of the decision's title.
   */
  vacate(
    property: ConformanceProperty,
    dimension: string,
    value: string,
    decision: string,
    evidence: string,
  ): void {
    this.#put(conformanceCellId(property, dimension, value), { kind: 'vacuous', decision, evidence });
  }

  #put(cell: string, disposition: ConformanceDisposition): void {
    const existing = this.#dispositions.get(cell);
    if (existing && existing.kind !== disposition.kind) {
      throw new Error(
        `conformance cell '${cell}' was already dispositioned as ${existing.kind}; refusing to overwrite it with ${disposition.kind}`,
      );
    }
    this.#dispositions.set(cell, disposition);
  }

  disposition(property: ConformanceProperty, dimension: string, value: string): ConformanceDisposition | null {
    return this.#dispositions.get(conformanceCellId(property, dimension, value)) ?? null;
  }

  report(): ConformanceLedgerReport {
    const missing: string[] = [];
    for (const cell of this.#declared) if (!this.#dispositions.has(cell)) missing.push(cell);
    const undeclared: string[] = [];
    const vacuousCells: string[] = [];
    let exercised = 0;
    for (const [cell, disposition] of this.#dispositions) {
      if (!this.#declared.has(cell)) undeclared.push(cell);
      if (disposition.kind === 'exercised') exercised += 1;
      else vacuousCells.push(cell);
    }
    return Object.freeze({
      schemaVersion: CONFORMANCE_BATTERY_SCHEMA_VERSION,
      declared: this.#declared.size,
      exercised,
      vacuous: vacuousCells.length,
      vacuousCells: Object.freeze([...vacuousCells].sort()),
      missing: Object.freeze(missing.sort()),
      undeclared: Object.freeze(undeclared.sort()),
    });
  }
}

// ── D-014's deployment probes, re-measured ───────────────────────────────────

export interface GatewayDeploymentSurface {
  readonly deployment: ConformanceDeployment;
  /** True when this deployment path actually starts a gateway process. */
  readonly spawnsGateway: boolean;
  /** Files scanned, so an empty hit set is attributable to a real corpus. */
  readonly scanned: readonly string[];
  /** Files that named a gateway entry point. */
  readonly hits: readonly string[];
  /**
   * The positive control: a token that MUST be present in the scanned corpus.
   * Without it, "no gateway here" is indistinguishable from "I scanned nothing".
   */
  readonly control: { readonly token: string; readonly hits: number };
}

/** Tokens that identify a gateway process entry point in a deployment artifact. */
const GATEWAY_ENTRY_TOKENS = [
  'inference-gateway/bin',
  'inference-gateway/bin.ts',
  'INFERENCE_GATEWAY',
  'inference-gateway.service',
  'runGatewaySidecarMain',
  'startGatewayService',
] as const;

function readIfFile(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function listDir(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function collectRustSources(root: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  for (const entry of listDir(root)) {
    if (entry === 'target' || entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(root, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) collectRustSources(full, out, depth + 1);
    else if (entry.endsWith('.rs')) out.push(full);
  }
  return out;
}

function probe(
  deployment: ConformanceDeployment,
  files: readonly string[],
  controlToken: string,
  repoRoot: string,
): GatewayDeploymentSurface {
  const scanned: string[] = [];
  const hits: string[] = [];
  let controlHits = 0;
  for (const file of files) {
    const body = readIfFile(file);
    if (body === null) continue;
    const relative = file.startsWith(repoRoot) ? file.slice(repoRoot.length) : file;
    scanned.push(relative);
    if (body.includes(controlToken)) controlHits += 1;
    if (GATEWAY_ENTRY_TOKENS.some((token) => body.includes(token))) hits.push(relative);
  }
  return Object.freeze({
    deployment,
    spawnsGateway: hits.length > 0,
    scanned: Object.freeze(scanned),
    hits: Object.freeze(hits),
    control: Object.freeze({ token: controlToken, hits: controlHits }),
  });
}

/**
 * Re-run D-014's four deployment probes against the current tree.
 *
 * Returns one surface per deployment path named by P-014. `spawnsGateway === false`
 * is only trustworthy alongside `control.hits > 0`; the battery asserts both, so a
 * probe that silently scans an empty or moved corpus fails loudly rather than
 * reporting a comfortable absence.
 */
export function measureGatewayDeploymentSurfaces(
  options: { readonly repoRoot?: string } = {},
): readonly GatewayDeploymentSurface[] {
  const root = options.repoRoot ?? REPO_ROOT;
  const at = (relative: string): string => join(root, relative);

  const systemdDir = at('apps/operator/scripts/systemd');
  const systemdUnits = listDir(systemdDir)
    .filter((entry) => entry.endsWith('.service'))
    .map((entry) => join(systemdDir, entry));

  const containerManifests = listDir(root)
    .filter((entry) => entry.startsWith('Dockerfile') || entry.startsWith('docker-compose'))
    .map((entry) => join(root, entry));

  const tauriRoot = at('papercusp-desktop/src-tauri');
  const packagedFiles = [
    ...collectRustSources(join(tauriRoot, 'src')),
    join(tauriRoot, 'tauri.conf.json'),
    join(tauriRoot, 'Cargo.toml'),
  ];

  const developmentFiles = [
    at('packages/operator-core/lib/inference-gateway/sidecar-main.ts'),
    at('packages/operator-core/lib/inference-gateway/bin.ts'),
    at('packages/operator-core/lib/inference-gateway/launch.ts'),
  ];

  return Object.freeze([
    // The dev path is the sidecar entry itself, so its control token is the one
    // thing every file in that corpus mentions regardless of gateway wiring.
    probe('development', developmentFiles, 'gateway', root),
    probe('systemd', systemdUnits, 'ExecStart', root),
    probe('packaged', packagedFiles, 'papercusp', root),
    probe('container', containerManifests, 'papercusp', root),
  ]);
}

// ── The platform dimension, also measured rather than assumed ────────────────

/**
 * The modules a request actually traverses to be admitted. Platform-independence
 * is only a meaningful claim about THESE files; the gateway as a whole certainly
 * touches the platform elsewhere (process spawning, path handling, credentials).
 */
export const ADMISSION_PATH_MODULES: readonly string[] = Object.freeze([
  'packages/operator-core/lib/inference-gateway/admission-context.ts',
  'packages/operator-core/lib/inference-gateway/capless-adapter.ts',
  'packages/operator-core/lib/inference-gateway/durable-admission.ts',
  'packages/operator-core/lib/inference-gateway/admission-state-model.ts',
  'packages/operator-core/lib/inference-gateway/payload-spool.ts',
  'packages/operator-core/lib/resource-governor/controller.ts',
  'packages/operator-core/lib/resource-governor/admission.ts',
  'packages/operator-core/lib/resource-governor/queue.ts',
]);

/**
 * A file KNOWN to branch on the platform. Without it, "no admission module
 * branches on platform" is indistinguishable from "the token I grep for is wrong".
 */
export const PLATFORM_BRANCH_POSITIVE_CONTROL =
  'packages/operator-core/lib/inference-gateway/account-resolver.ts';

const PLATFORM_BRANCH_TOKENS = ['process.platform', 'os.platform()', "'win32'", "'darwin'"] as const;

export interface AdmissionPlatformProbe {
  readonly scanned: readonly string[];
  /** Admission modules that branch on the host platform. Expected: none. */
  readonly branching: readonly string[];
  readonly control: { readonly file: string; readonly hits: number };
}

/**
 * Measure whether admission behaviour can differ by platform.
 *
 * P-014's matrix names supported platforms, but a battery running on one machine
 * cannot honestly claim to have exercised three. What it CAN do is establish that
 * there is nothing platform-specific to exercise: if no module on the admission
 * path branches on the host platform, per-platform admission cells are vacuous for
 * the same reason the packaged/container cells are. The instant someone adds a
 * branch, this returns it and the battery demands real per-platform coverage
 * instead of continuing to wave the dimension through.
 */
export function measureAdmissionPlatformBranching(
  options: { readonly repoRoot?: string } = {},
): AdmissionPlatformProbe {
  const root = options.repoRoot ?? REPO_ROOT;
  const scanned: string[] = [];
  const branching: string[] = [];
  for (const relative of ADMISSION_PATH_MODULES) {
    const body = readIfFile(join(root, relative));
    if (body === null) continue;
    scanned.push(relative);
    if (PLATFORM_BRANCH_TOKENS.some((token) => body.includes(token))) branching.push(relative);
  }
  const controlBody = readIfFile(join(root, PLATFORM_BRANCH_POSITIVE_CONTROL)) ?? '';
  const controlHits = PLATFORM_BRANCH_TOKENS.filter((token) => controlBody.includes(token)).length;
  return Object.freeze({
    scanned: Object.freeze(scanned),
    branching: Object.freeze(branching),
    control: Object.freeze({ file: PLATFORM_BRANCH_POSITIVE_CONTROL, hits: controlHits }),
  });
}

/** The deployment paths that genuinely run a gateway, per the live measurement. */
export function deploymentsThatSpawnGateway(
  surfaces: readonly GatewayDeploymentSurface[] = measureGatewayDeploymentSurfaces(),
): readonly ConformanceDeployment[] {
  return Object.freeze(surfaces.filter((surface) => surface.spawnsGateway).map((surface) => surface.deployment));
}
