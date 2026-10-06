/**
 * Cloud Workspaces — pure view model.
 *
 * Every derivation the guided-rail UI needs, as plain functions with no React
 * and no DOM. The stage components render what these return; they do not
 * re-derive it in JSX. That split is the point: the interesting decisions on
 * this page (which step you land on, whether a host is drifting, whether
 * provisioning may proceed, which lifecycle actions are legal) are exactly the
 * ones worth testing directly, and they were previously spread across the
 * render tree where only a DOM assertion could reach them.
 *
 * Plan: cloud-workspaces-guided-rail-2026-08-28 P-001.
 */

export type ProviderTarget = "gcp" | "aws" | "azure";
export type ConnectionStatus = "connected" | "degraded" | "invalid";
export type LifecycleState =
  | "provisioning"
  | "running"
  | "stopped"
  | "degraded"
  | "repairing"
  | "destroying"
  | "absent";
export type LifecycleAction = "start" | "stop" | "repair" | "snapshot" | "restore" | "destroy";
export type DestroyDisposition = "snapshot" | "backup" | "discard";

/** The three guided-rail steps, in rail order. */
export type StepId = "connect" | "configure" | "operate";

export const STEP_IDS: readonly StepId[] = ["connect", "configure", "operate"];

export function isStepId(value: unknown): value is StepId {
  return (
    typeof value === "string" && STEP_IDS.includes(value as StepId)
  );
}

export interface CatalogOption {
  id: string;
  label: string;
}

export interface RegionOption extends CatalogOption {
  zones?: string[];
}

export interface SizeOption extends CatalogOption {
  vcpu: number;
  memoryGiB: number;
  hourlyUsd?: number;
}

export interface ImageOption extends CatalogOption {
  version?: string;
}

export interface WorkspaceHostConnectionRow {
  kind: "connection";
  id: string;
  target: string;
  label: string;
  status: ConnectionStatus;
  credentialRef: string;
  lastValidatedAt?: string;
  statusDetail?: string;
  provider?: {
    projectId?: string;
    serviceAccountEmail?: string;
    vpcId?: string;
    securityGroupIds?: string[];
    launchTemplateId?: string;
  };
  scopes: CatalogOption[];
  regions: RegionOption[];
  sizes: SizeOption[];
  images: ImageOption[];
  networks: CatalogOption[];
  diskPricePerGiBMonth?: number;
}

export interface OperationEvent {
  id: string;
  ts: string;
  phase: string;
  status: "queued" | "running" | "succeeded" | "failed";
  level?: "info" | "warn" | "error";
  source?: string;
  message: string;
  details?: unknown;
}

export interface OperationProgress {
  id: string;
  action: LifecycleAction | "provision";
  status: "queued" | "running" | "succeeded" | "failed";
  percent: number;
  message: string;
  request?: unknown;
  error?: unknown;
  events: OperationEvent[];
}

export interface WorkspaceHostResourceRow {
  logicalKey: string;
  kind?: string | null;
  state: string;
  providerId?: string | null;
  providerRequestId?: string | null;
  attempts: number;
  retryClass?: string | null;
  updatedAt?: string;
  error?: unknown;
}

export interface WorkspaceHostLogRow {
  id: string;
  operationId?: string;
  observedAt?: string;
  stream: "cloud-init" | "systemd" | "controller";
  unit?: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: unknown;
}

export interface WorkspaceHostControlRow {
  kind: "workspace";
  id: string;
  name: string;
  connectionId: string;
  target: string;
  scopeLabel: string;
  region: string;
  size: string;
  image: string;
  diskGiB: number;
  network: string;
  estimatedMonthlyUsd?: number;
  desiredState: LifecycleState;
  observedState: LifecycleState;
  /** When the provider was last observed — refreshed by every lifecycle action. */
  observedAt?: string;
  /**
   * When this host was provisioned. A separate field from `observedAt` for a
   * load-bearing reason: `observedAt` moves every time the provider is
   * observed, so it cannot answer "how old is this fleet". Projected from
   * `workspace_hosts.created_at`, which the host upsert never overwrites.
   */
  provisionedAt?: string;
  providerResourceId?: string;
  endpoint?: string;
  recoverability: {
    kind: "snapshot" | "backup" | "none";
    label: string;
    updatedAt?: string;
  };
  capabilities: Partial<Record<LifecycleAction, boolean>>;
  resources?: WorkspaceHostResourceRow[];
  health?: {
    status: string;
    attestedAt?: string;
    checks: unknown[];
    bootstrapVersion?: string;
  };
  versionDrift?: unknown[];
  tunnel?: Record<string, unknown>;
  costSignals?: unknown[];
  quotaSignals?: unknown[];
  logs?: WorkspaceHostLogRow[];
  operation?: OperationProgress;
}

export type CloudWorkspacesControlRow =
  | WorkspaceHostConnectionRow
  | WorkspaceHostControlRow;

const LIFECYCLE_STATES: readonly LifecycleState[] = [
  "provisioning",
  "running",
  "stopped",
  "degraded",
  "repairing",
  "destroying",
  "absent",
];

export function isLifecycleState(value: string): value is LifecycleState {
  return LIFECYCLE_STATES.includes(value as LifecycleState);
}

/* ── Formatters (behaviour preserved verbatim from the pre-redesign page) ──── */

export function formatTimestamp(value?: string): string {
  if (!value) return "not yet";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

export function formatMoney(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "Unavailable";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCapacity(
  size?: Partial<Pick<SizeOption, "vcpu" | "memoryGiB">> | null,
): string {
  if (
    !size ||
    !Number.isFinite(size.vcpu) ||
    !Number.isFinite(size.memoryGiB)
  ) {
    return "Capacity details unavailable";
  }
  return `${size.vcpu} vCPU · ${size.memoryGiB} GiB RAM`;
}

export function formatSignal(value: unknown): string {
  if (value == null) return "none";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Coarse "how long ago" for the rail and the drift banner. Deliberately coarse:
 * the operator cares that a host has been drifting for *minutes* rather than
 * seconds, not about the exact second.
 */
export function formatElapsed(from?: string, now: number = Date.now()): string {
  if (!from) return "unknown";
  const ms = Date.parse(from);
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function workspaceHostIdFromName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `host-${normalized || "workspace"}`;
}

/* ── Tone vocabulary ───────────────────────────────────────────────────────── */

export type Tone = "good" | "warn" | "bad" | "neutral";

export function signalTone(value: string): Tone {
  if (
    ["healthy", "connected", "ok", "applied", "unchanged", "succeeded"].includes(
      value,
    )
  ) {
    return "good";
  }
  if (["degraded", "unreachable", "failed", "error", "invalid"].includes(value)) {
    return "bad";
  }
  if (
    ["warn", "warning", "retry-wait", "reconciling", "applying"].includes(value)
  ) {
    return "warn";
  }
  return "neutral";
}

export function stateTone(state: string): Tone {
  if (state === "running" || state === "connected" || state === "succeeded")
    return "good";
  if (state === "degraded" || state === "invalid" || state === "failed")
    return "bad";
  if (
    state === "provisioning" ||
    state === "repairing" ||
    state === "destroying"
  ) {
    return "warn";
  }
  return "neutral";
}

/* ── Drift: the single state chip ──────────────────────────────────────────── */

export interface HostStateChip {
  /** True when desired and observed disagree — the whole reason this page exists. */
  drifting: boolean;
  /** `running`, or `stopped → running` when drifting. */
  label: string;
  tone: Tone;
  /** Present only while an operation is in flight. */
  percent?: number;
}

/**
 * One chip per host. The pre-redesign page rendered three separate pills
 * (health / desired / observed) and left the reader to compute the diff; drift
 * is the signal, so it is stated rather than implied. Both states appear ONLY
 * when they diverge.
 */
export function hostStateChip(workspace: WorkspaceHostControlRow): HostStateChip {
  const { desiredState, observedState, operation } = workspace;
  const inFlight =
    operation && (operation.status === "running" || operation.status === "queued")
      ? operation
      : undefined;

  if (desiredState !== observedState) {
    return {
      drifting: true,
      label: `${observedState} → ${desiredState}`,
      tone: observedState === "degraded" ? "bad" : "warn",
      ...(inFlight ? { percent: inFlight.percent } : {}),
    };
  }

  if (inFlight && observedState === "provisioning") {
    return {
      drifting: false,
      label: `provisioning · ${inFlight.percent}%`,
      tone: "warn",
      percent: inFlight.percent,
    };
  }

  return {
    drifting: false,
    label: observedState,
    tone: stateTone(observedState),
  };
}

/**
 * Hosts whose desired and observed states disagree, worst first.
 *
 * The order is triage advice, not cosmetics: OperateStage renders this list
 * directly as the drift banner, so whatever sits at the top is what the
 * operator reaches for first.
 *
 *  - `degraded` outranks every other divergence — it is the one observed state
 *    `stateTone` already calls "bad", where the rest are merely "warn";
 *  - within a rank the LONGEST-diverged host leads, which matches the
 *    "diverged for {elapsed}" the banner prints beside each row;
 *  - an unknown `observedAt` sorts last within its rank, because not knowing
 *    how long a host has been drifting is not evidence that it has been
 *    drifting a long time;
 *  - equal hosts keep their incoming query order, so the banner cannot
 *    reshuffle between renders and imply activity that did not happen.
 */
export function driftingWorkspaces(
  workspaces: readonly WorkspaceHostControlRow[],
): WorkspaceHostControlRow[] {
  const divergenceRank = (row: WorkspaceHostControlRow): number =>
    row.observedState === "degraded" ? 0 : 1;

  /** Epoch ms of the last observation, or +Infinity when it is unknown. */
  const divergedSinceMs = (row: WorkspaceHostControlRow): number => {
    const ms = row.observedAt ? Date.parse(row.observedAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };

  return workspaces
    .filter((row) => row.desiredState !== row.observedState)
    .map((row, queryOrder) => ({ row, queryOrder }))
    .sort((a, b) => {
      const byRank = divergenceRank(a.row) - divergenceRank(b.row);
      if (byRank !== 0) return byRank;
      /* Compared, never subtracted: two unknown ages are both +Infinity, and
         Infinity - Infinity is NaN, which would silently corrupt the sort. */
      const aSince = divergedSinceMs(a.row);
      const bSince = divergedSinceMs(b.row);
      if (aSince !== bSince) return aSince < bSince ? -1 : 1;
      return a.queryOrder - b.queryOrder;
    })
    .map((entry) => entry.row);
}

/* ── Contextual lifecycle actions ──────────────────────────────────────────── */

export interface LifecycleActionSpec {
  action: LifecycleAction;
  label: string;
  /** Provider capability says this action is legal for this host right now. */
  enabled: boolean;
}

export interface LifecycleActionPlan {
  /**
   * The one action that makes sense right now — Start XOR Stop, never both.
   * `null` when neither is currently legal (mid-provision, say).
   */
  primary: LifecycleActionSpec | null;
  /** Repair / Snapshot / Destroy, in menu order. */
  overflow: LifecycleActionSpec[];
}

// "machine", not a bare verb: this row sits beside the Desktop tab, and a bare "Stop" read as
// stopping the desktop (owner #454). Stopping powers off the VM, which also cuts psu access.
const ACTION_LABELS: Record<LifecycleAction, string> = {
  start: "Start machine",
  stop: "Stop machine",
  repair: "Repair",
  snapshot: "Snapshot",
  restore: "Restore snapshot",
  destroy: "Destroy",
};

function spec(
  action: LifecycleAction,
  capabilities: Partial<Record<LifecycleAction, boolean>>,
): LifecycleActionSpec {
  return {
    action,
    label: ACTION_LABELS[action],
    enabled: capabilities[action] === true,
  };
}

/**
 * The pre-redesign page rendered all five lifecycle buttons always, mostly
 * disabled — Start sat greyed out on every running host. Start and Stop are
 * mutually exclusive by construction, so exactly one can be the primary; the
 * rest move to an overflow menu where a disabled entry costs no visual weight.
 */
export function lifecycleActionPlan(
  workspace: WorkspaceHostControlRow,
): LifecycleActionPlan {
  const caps = workspace.capabilities ?? {};
  const startable = caps.start === true;
  const stoppable = caps.stop === true;

  let primary: LifecycleActionSpec | null = null;
  if (startable && !stoppable) primary = spec("start", caps);
  else if (stoppable && !startable) primary = spec("stop", caps);
  else if (startable && stoppable) {
    // Ambiguous capability payload: fall back to observed state so the button
    // still means something rather than picking arbitrarily.
    primary =
      workspace.observedState === "running" ? spec("stop", caps) : spec("start", caps);
  }

  return {
    primary,
    overflow: (["repair", "snapshot", "restore", "destroy"] as const).map((action) =>
      spec(action, caps),
    ),
  };
}

/* ── Readiness: the checklist that replaces the joined blocker sentence ────── */

export interface ReadinessCheck {
  id: string;
  /** What must be true, stated positively. */
  label: string;
  ok: boolean;
  /** Shown when `ok` is false — names the actual fix. */
  fix?: string;
}

export interface ProvisionSelection {
  catalogSelectionCanonical: boolean;
  diskGiBValid: boolean;
  connection: WorkspaceHostConnectionRow | null;
  name: string;
  scope: CatalogOption | null;
  region: RegionOption | null;
  zone: string | null;
  size: SizeOption | null;
  image: ImageOption | null;
  network: CatalogOption | null;
}

/**
 * One line per condition, each independently pass/fail, in the order the
 * operator would fix them. The pre-redesign page joined these into a single
 * semicolon-separated sentence ("Required: a; b; c."), which made a
 * four-condition failure read as one wall of text.
 *
 * The set of conditions is unchanged from the pre-redesign page — this is a
 * presentation change, not a relaxation.
 */
export function readinessChecks(
  selection: ProvisionSelection,
): ReadinessCheck[] {
  const {
    catalogSelectionCanonical,
    diskGiBValid,
    connection,
    name,
    scope,
    region,
    zone,
    size,
    image,
    network,
  } = selection;

  return [
    {
      id: "catalog-sync",
      label: "URL-backed selections are settled",
      ok: catalogSelectionCanonical,
      fix: "wait for URL-backed selections to finish syncing",
    },
    {
      id: "provider-supported",
      label: "Provider is supported",
      ok: !connection || connection.target === "gcp" || connection.target === "aws",
      fix: "choose a supported Google Cloud or AWS connection",
    },
    ...(connection?.target === "aws" ? [{
      id: "aws-launch-resources",
      label: "AWS launch resources configured",
      ok: Boolean(connection.provider?.vpcId && connection.provider?.launchTemplateId && connection.provider?.securityGroupIds?.length),
      fix: "reconnect AWS with a VPC, security groups, and launch template",
    }] : []),
    {
      id: "connection-validated",
      label: "Provider connection validated",
      ok: connection?.status === "connected",
      fix: "validate the provider connection",
    },
    {
      id: "name",
      label: "Workspace name entered",
      ok: Boolean(name.trim()),
      fix: "enter a workspace name",
    },
    {
      id: "scope",
      label: "Project, account, or subscription loaded",
      ok: Boolean(scope),
      fix: "load a project, account, or subscription from the provider catalog",
    },
    {
      id: "region",
      label: "Region loaded",
      ok: Boolean(region),
      fix: "load a region from the provider catalog",
    },
    {
      id: "zone",
      label: "Zone available for the region",
      ok: !region || Boolean(zone),
      fix: "load an available zone for the selected region",
    },
    {
      id: "size",
      label: "Machine size loaded",
      ok: Boolean(size),
      fix: "load a machine size from the provider catalog",
    },
    {
      id: "image",
      label: "Image loaded",
      ok: Boolean(image),
      fix: "load an image from the provider catalog",
    },
    {
      id: "network",
      label: "Network loaded",
      ok: Boolean(network),
      fix: "load a network from the provider catalog",
    },
    {
      id: "disk",
      label: "Disk size is a whole number in range",
      ok: diskGiBValid,
      fix: "enter a whole-number disk size between 20 and 16,384 GiB",
    },
  ];
}

/** The unmet fixes, in checklist order — the text the blocker status announces. */
export function unmetReadinessFixes(checks: readonly ReadinessCheck[]): string[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) => check.fix ?? check.label);
}

export function canProvision(checks: readonly ReadinessCheck[]): boolean {
  return checks.every((check) => check.ok);
}

/* ── Step resolution and rail status ───────────────────────────────────────── */

export interface StepAvailability {
  connect: boolean;
  configure: boolean;
  operate: boolean;
}

/**
 * A step is reachable only once its precondition holds, so the page can never
 * strand you in an inert form: Configure needs a connection to have a catalog
 * to offer, Operate needs at least one workspace to operate.
 */
export function stepAvailability(
  connections: readonly WorkspaceHostConnectionRow[],
  workspaces: readonly WorkspaceHostControlRow[],
): StepAvailability {
  return {
    connect: true,
    configure: connections.length > 0,
    operate: workspaces.length > 0,
  };
}

/**
 * Which step a fresh visit lands on. Operate wins the moment a workspace
 * exists — after first setup the rail stops behaving like a wizard, and the
 * daily job is operating hosts, not re-reading setup.
 */
export function resolveLandingStep(
  connections: readonly WorkspaceHostConnectionRow[],
  workspaces: readonly WorkspaceHostControlRow[],
): StepId {
  if (workspaces.length > 0) return "operate";
  if (connections.length > 0) return "configure";
  return "connect";
}

/**
 * The step actually rendered: the requested one when it is reachable, else the
 * landing step. A shared link to `?step=operate` for a workspace-less install
 * degrades to Connect rather than to a blank stage.
 */
export function resolveActiveStep(
  requested: string | null | undefined,
  connections: readonly WorkspaceHostConnectionRow[],
  workspaces: readonly WorkspaceHostControlRow[],
): StepId {
  const availability = stepAvailability(connections, workspaces);
  if (isStepId(requested) && availability[requested]) return requested;
  return resolveLandingStep(connections, workspaces);
}

export type RailStepStatus = "todo" | "current" | "done" | "attention";

export interface RailStep {
  id: StepId;
  index: string;
  label: string;
  status: RailStepStatus;
  /** What this step did, or what it is waiting for — never a bare tick. */
  evidence: string;
  /** False when the precondition does not hold; the rail dims and disables it. */
  reachable: boolean;
}

export interface RailModel {
  steps: RailStep[];
  stats: {
    running: number;
    stopped: number;
    drifting: number;
    monthlyUsd: number;
  };
}

const STEP_LABELS: Record<StepId, string> = {
  connect: "Connect",
  configure: "Configure",
  operate: "Operate",
};

const STEP_INDEX: Record<StepId, string> = {
  connect: "01",
  configure: "02",
  operate: "03",
};

/**
 * The rail is a status column, not a breadcrumb: each step reports its own
 * condition, so a problem in a step you are not looking at still surfaces.
 */
export function railModel(
  connections: readonly WorkspaceHostConnectionRow[],
  workspaces: readonly WorkspaceHostControlRow[],
  activeStep: StepId,
  now: number = Date.now(),
): RailModel {
  const availability = stepAvailability(connections, workspaces);
  const connected = connections.filter((row) => row.status === "connected");
  const unhealthyConnection = connections.find(
    (row) => row.status !== "connected",
  );
  const drifting = driftingWorkspaces(workspaces);
  const lastValidated = connected
    .map((row) => row.lastValidatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  const connectEvidence = (): string => {
    if (connections.length === 0) return "No provider connected yet";
    if (unhealthyConnection) {
      return `${unhealthyConnection.label} · ${unhealthyConnection.status}`;
    }
    const names = connected.map((row) => row.target.toUpperCase()).join(", ");
    return lastValidated
      ? `${names} · validated ${formatElapsed(lastValidated, now)} ago`
      : `${names} · connected`;
  };

  const configureEvidence = (): string => {
    if (connections.length === 0) return "Needs a validated connection";
    if (workspaces.length === 0) return "No workspace provisioned yet";
    /* `created_at` is projected as `provisionedAt` and survives every
       observation refresh. Do not fall back to `observedAt`: that timestamp
       moves after lifecycle actions and would make this label false again. */
    const newest = workspaces
      .map((row) => row.provisionedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1);
    return newest
      ? `Last provisioned ${formatElapsed(newest, now)} ago`
      : "Ready to provision";
  };

  const operateEvidence = (): string => {
    if (workspaces.length === 0) return "No workspaces yet";
    const noun = workspaces.length === 1 ? "workspace" : "workspaces";
    /* The two counts are independent: three hosts can have two drifting, so the
       verb agrees with `drifting.length`, never with the host count. */
    const verb = drifting.length === 1 ? "needs" : "need";
    return drifting.length > 0
      ? `${workspaces.length} ${noun} · ${drifting.length} ${verb} attention`
      : `${workspaces.length} ${noun} · all aligned`;
  };

  const statusFor = (
    id: StepId,
    { attention, done }: { attention: boolean; done: boolean },
  ): RailStepStatus => {
    if (id === activeStep) return "current";
    if (attention) return "attention";
    if (done) return "done";
    return "todo";
  };

  return {
    steps: [
      {
        id: "connect",
        index: STEP_INDEX.connect,
        label: STEP_LABELS.connect,
        status: statusFor("connect", {
          attention: Boolean(unhealthyConnection),
          done: connected.length > 0,
        }),
        evidence: connectEvidence(),
        reachable: availability.connect,
      },
      {
        id: "configure",
        index: STEP_INDEX.configure,
        label: STEP_LABELS.configure,
        status: statusFor("configure", {
          attention: false,
          done: workspaces.length > 0,
        }),
        evidence: configureEvidence(),
        reachable: availability.configure,
      },
      {
        id: "operate",
        index: STEP_INDEX.operate,
        label: STEP_LABELS.operate,
        status: statusFor("operate", {
          attention: drifting.length > 0,
          done: workspaces.length > 0,
        }),
        evidence: operateEvidence(),
        reachable: availability.operate,
      },
    ],
    stats: {
      running: workspaces.filter((row) => row.observedState === "running").length,
      stopped: workspaces.filter((row) => row.observedState === "stopped").length,
      drifting: drifting.length,
      /* Cost tracks what is actually running, so it keys on the OBSERVED state
         like Running and Stopped do. `absent` means the provider confirmed the
         instance gone: the destroy path moves the row to `absent` but never
         clears its provision-time `estimated_monthly_usd`, and the row is never
         deleted, so counting it would bill for vanished hardware forever — and
         would contradict the Running/Stopped counts beside it, which already
         ignore `absent`. `destroying` still counts: the instance is up until
         the provider says otherwise. */
      monthlyUsd: workspaces
        .filter((row) => row.observedState !== "absent")
        .reduce(
          (total, row) =>
            total +
            (Number.isFinite(row.estimatedMonthlyUsd)
              ? (row.estimatedMonthlyUsd ?? 0)
              : 0),
          0,
        ),
    },
  };
}

/* ── Estimate ──────────────────────────────────────────────────────────────── */

export function estimateMonthlyUsd(
  size: SizeOption | null,
  diskGiB: number,
  diskGiBValid: boolean,
  diskPricePerGiBMonth: number | undefined,
): number | undefined {
  if (size?.hourlyUsd === undefined || !diskGiBValid) return undefined;
  return size.hourlyUsd * 730 + diskGiB * (diskPricePerGiBMonth ?? 0);
}

export const DISK_MIN_GIB = 20;
export const DISK_MAX_GIB = 16_384;

/** No silent correction: an out-of-range or fractional value is simply invalid. */
export function isDiskGiBValid(raw: string): boolean {
  const value = Number(raw);
  return (
    Number.isInteger(value) && value >= DISK_MIN_GIB && value <= DISK_MAX_GIB
  );
}

/* ── Recent activity ───────────────────────────────────────────────────────── */

export interface ActivityEntry {
  id: string;
  /** ISO timestamp when known; entries without one sort last. */
  ts?: string;
  /** Who this happened to — a workspace or connection name. */
  subject: string;
  /** What happened, in the system's own words. */
  detail: string;
  tone: Tone;
}

/**
 * The rail's activity feed. Operation events and connection validations are
 * the two things that actually happen on this page, so they are the two
 * sources; everything else on a row is state, not an event.
 *
 * Newest first. Entries without a timestamp sort last rather than being
 * dropped — a phase with no clock is still evidence something ran.
 */
export function recentActivity(
  connections: readonly WorkspaceHostConnectionRow[],
  workspaces: readonly WorkspaceHostControlRow[],
  limit = 6,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];

  for (const workspace of workspaces) {
    for (const event of workspace.operation?.events ?? []) {
      entries.push({
        id: `event:${workspace.id}:${event.id}`,
        ts: event.ts,
        subject: workspace.name,
        detail: `${event.phase} · ${event.message}`,
        tone: signalTone(event.level ?? event.status),
      });
    }
  }

  for (const connection of connections) {
    if (!connection.lastValidatedAt) continue;
    entries.push({
      id: `connection:${connection.id}`,
      ts: connection.lastValidatedAt,
      subject: connection.label,
      detail:
        connection.status === "connected"
          ? "Provider catalog validated"
          : `Validation ${connection.status}`,
      tone: signalTone(connection.status),
    });
  }

  entries.sort((a, b) => {
    if (a.ts && b.ts) return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0;
    if (a.ts) return -1;
    if (b.ts) return 1;
    return 0;
  });

  return entries.slice(0, limit);
}
