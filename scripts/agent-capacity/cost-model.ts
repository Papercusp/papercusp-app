/**
 * P-012 cost model (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10004388): Google cost per month
 * for ONE workspace with N assigned agents, for each lever combination, graded against the D-003
 * target (50 agents at a Google cost of about 60-80 USD/month; the owner's starting figure was
 * 1000 USD/month, #1064).
 *
 *   npx tsx scripts/agent-capacity/cost-model.ts [--agents 50] [--p532-saved-gib <GiB>] [--json]
 *
 * Every measured input below names the plan Decision it comes from. Machine prices are NOT typed in
 * here: they come from gcp-rails (Cloud Billing Catalog list prices, on-demand and spot), so a price
 * update there re-prices every row. Re-run this after a new measurement instead of hand-editing a table.
 *
 * Model (per month, 730 h):
 *   pooled compute    = N x duty.mean x hostMonth / activeCapacity
 *                       (agents of many workspaces share a pool of hosts, so the pool is sized for
 *                        the MEAN number of busy agents; D-038 measured p99 at 1.3x the mean)
 *   dedicated compute = ceil(N x duty.mean x duty.p99OverMean / (activeCapacity - 1)) x hostMonth
 *                       (one workspace owns its VM, so it must hold its own p99; one agent slot is
 *                        given to the workspace's Server, which costs about one mixed agent's CPU)
 *   server            = dedicated: inside the dedicated VM (0 extra)
 *                       packed:    hostMonth(e2-standard-16 spot) / tenants per host (D-045 as measured)
 *                       floor:     Server cores and RAM at e2 spot list rates (D-022 method); reachable
 *                                  only with near-perfect packing, so it is a lower bound
 */
import { hourlyPriceUsd, parseMachineType, SPOT_PRICES_2026_10_01 } from './gcp-rails';

export const HOURS_PER_MONTH = 730;
/** The measurement VMs were priced with a 120 GB boot disk (capacity-table --disk-gb 120), so the rows here match D-019/D-020. */
export const HOST_DISK_GB = 120;

export const TARGET = { agents: 50, googleUsdMonthMax: 80, googleUsdMonthGoal: 60, source: 'D-003' } as const;
export const OWNER_BASELINE = { agents: 50, usdMonth: 1000, source: 'owner directive #1064' } as const;

/** Share of agents mid-turn at once in the real fleet, and its p99 over the mean. */
export const DUTY = { mean: 0.35, p99OverMean: 1.3, source: 'D-038' } as const;

export type Workload = 'mixed' | 'heavy';

export interface Capacity {
  id: string;
  workload: Workload;
  machineType: string;
  /** Mean agents in flight at the capacity step (achieved concurrency, not slot count; D-020). */
  active: number;
  /** True when the run never saturated, so the real capacity is at least `active`. */
  atLeast?: boolean;
  source: string;
}

/**
 * mixed = 50/50 Claude/Codex planning workload, replayed (D-009 accepted replay for it).
 * heavy = real typecheck/test-heavy Papercusp engineering (P-019 recordings replayed in P-529/WI-5384).
 */
export const CAPACITY: readonly Capacity[] = [
  { id: 'mixed-e2s4', workload: 'mixed', machineType: 'e2-standard-4', active: 8, source: 'D-019' },
  { id: 'mixed-e2s8', workload: 'mixed', machineType: 'e2-standard-8', active: 32, source: 'D-019' },
  { id: 'mixed-e2s16', workload: 'mixed', machineType: 'e2-standard-16', active: 64, source: 'D-019' },
  { id: 'mixed-e2c16', workload: 'mixed', machineType: 'e2-custom-16-32768', active: 73.2, source: 'D-020' },
  { id: 'mixed-c4a16', workload: 'mixed', machineType: 'c4a-standard-16', active: 87.6, source: 'D-024' },
  { id: 'mixed-c4ahc16', workload: 'mixed', machineType: 'c4a-highcpu-16', active: 83, source: 'D-027' },
  { id: 'heavy-e2s16', workload: 'heavy', machineType: 'e2-standard-16', active: 24, source: 'D-023 (no admission)' },
  { id: 'heavy-e2s16-adm', workload: 'heavy', machineType: 'e2-standard-16', active: 32, source: 'D-023 (heavy-job admission)' },
  {
    id: 'heavy-e2s16-adm-tsc',
    workload: 'heavy',
    machineType: 'e2-standard-16',
    active: 48,
    atLeast: true,
    source: 'D-040 (admission + shared tsc-service; saturation moved from n40 to >= n48)',
  },
];

/**
 * One idle Papercusp Server tenant (D-045, P-011: 16 tenants on a 64 GiB e2-standard-16, embed
 * unload off). ramGiB is the HOST cost per tenant: host MemAvailable fell 61.7 -> 3.9 GiB for 16
 * tenants, 3.61 GiB each (cgroup mean 3.24 plus kernel and page cache). cores is the idle floor
 * (0.16-0.20 measured, upper end taken).
 */
export const SERVER = {
  ramGiB: 3.6,
  cores: 0.2,
  packHost: 'e2-standard-16',
  /** D-045 kept a 10 GiB reserve on the 64 GiB host. */
  reserveGiB: 10,
  /** MemAvailable at start over nominal RAM on that host (61.7 of 64 GiB). */
  usableRamFraction: 61.7 / 64,
  source: 'D-045',
} as const;

export function hostMonthUsd(machineType: string, spot: boolean): number {
  return hourlyPriceUsd(machineType, HOST_DISK_GB, { spot }) * HOURS_PER_MONTH;
}

export function capacity(id: string): Capacity {
  const c = CAPACITY.find((x) => x.id === id);
  if (!c) throw new Error(`unknown capacity row '${id}'`);
  return c;
}

/** Server RAM after a lever that frees `savedGiB` per tenant (P-532: embed model in an idle-exiting sidecar). */
export function serverRamGiB(savedGiB = 0): number {
  if (savedGiB < 0 || savedGiB >= SERVER.ramGiB) throw new Error(`savedGiB ${savedGiB} out of range`);
  return SERVER.ramGiB - savedGiB;
}

/** Tenants per packing host: bound by usable RAM after the reserve, and by CPU. */
export function tenantsPerHost(savedGiB = 0): number {
  const { vcpus, ramGb } = parseMachineType(SERVER.packHost);
  const byRam = Math.floor((ramGb * SERVER.usableRamFraction - SERVER.reserveGiB) / serverRamGiB(savedGiB));
  const byCpu = Math.floor(vcpus / SERVER.cores);
  return Math.min(byRam, byCpu);
}

/** Server cost per workspace-month: [floor, packed]. */
export function serverMonthUsd(savedGiB = 0): { floor: number; packed: number } {
  const e2 = SPOT_PRICES_2026_10_01.e2;
  if (!e2) throw new Error('no e2 spot price');
  const floor = (SERVER.cores * e2.vcpuHour + serverRamGiB(savedGiB) * e2.gbRamHour) * HOURS_PER_MONTH;
  const packed = hostMonthUsd(SERVER.packHost, true) / tenantsPerHost(savedGiB);
  return { floor, packed };
}

export function pooledComputeUsd(agents: number, cap: Capacity, spot: boolean): number {
  return (agents * DUTY.mean * hostMonthUsd(cap.machineType, spot)) / cap.active;
}

export function dedicatedHosts(agents: number, cap: Capacity): number {
  const busyAtP99 = agents * DUTY.mean * DUTY.p99OverMean;
  return Math.max(1, Math.ceil(busyAtP99 / (cap.active - 1)));
}

export interface Scenario {
  id: string;
  label: string;
  workload: Workload;
  placement: 'dedicated' | 'pooled';
  spot: boolean;
  capacityId: string;
  /** Apply the P-532 per-tenant saving (only meaningful for pooled placement). */
  p532?: boolean;
}

/** The lever ladder: each row adds one lever to the row above it. */
export const SCENARIOS: readonly Scenario[] = [
  { id: 'M0', label: 'own VM per workspace, right-sized e2, on-demand', workload: 'mixed', placement: 'dedicated', spot: false, capacityId: 'mixed-e2s8' },
  { id: 'M1', label: '+ spot', workload: 'mixed', placement: 'dedicated', spot: true, capacityId: 'mixed-e2s8' },
  { id: 'M2', label: '+ shared pool, Servers packed (e2-standard-16 spot)', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-e2s16' },
  { id: 'M3', label: '+ lean shape e2-custom-16-32768', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-e2c16' },
  { id: 'M4', label: '+ Arm c4a-highcpu-16', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-c4ahc16' },
  { id: 'M5', label: '+ P-532 embed sidecar (Server RAM)', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-c4ahc16', p532: true },
  { id: 'H0', label: 'heavy work: shared pool, spot e2-standard-16, no levers', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16' },
  { id: 'H1', label: '+ heavy-job admission', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm' },
  { id: 'H2', label: '+ shared tsc-service', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm-tsc' },
  { id: 'H3', label: '+ P-532 embed sidecar (Server RAM)', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm-tsc', p532: true },
];

export interface Row {
  id: string;
  label: string;
  workload: Workload;
  agents: number;
  machineType: string;
  hosts: number | null;
  computeUsd: number;
  serverUsd: { floor: number; packed: number };
  totalUsd: { floor: number; packed: number };
  perAgentUsd: { floor: number; packed: number };
  /** OWNER_BASELINE cost scaled to `agents`, divided by the packed total. */
  reductionVsBaseline: number;
  /** Graded on the packed (as-measured) total; meaningful at TARGET.agents. */
  meetsTarget: boolean;
  /** True when capacity is a lower bound, so the cost is an upper bound. */
  costIsUpperBound: boolean;
  /** True when the row needs a P-532 saving that has not been measured yet. */
  pending: boolean;
  sources: string[];
}

export function evaluate(s: Scenario, agents: number, p532SavedGiB: number | null): Row {
  const cap = capacity(s.capacityId);
  if (cap.workload !== s.workload) throw new Error(`${s.id}: capacity row ${cap.id} is ${cap.workload}, scenario is ${s.workload}`);
  const pending = !!s.p532 && p532SavedGiB === null;
  const saved = s.p532 && p532SavedGiB !== null ? p532SavedGiB : 0;
  let hosts: number | null = null;
  let computeUsd: number;
  let serverUsd: { floor: number; packed: number };
  if (s.placement === 'dedicated') {
    hosts = dedicatedHosts(agents, cap);
    computeUsd = hosts * hostMonthUsd(cap.machineType, s.spot);
    serverUsd = { floor: 0, packed: 0 };
  } else {
    computeUsd = pooledComputeUsd(agents, cap, s.spot);
    serverUsd = serverMonthUsd(saved);
  }
  const totalUsd = { floor: computeUsd + serverUsd.floor, packed: computeUsd + serverUsd.packed };
  const baseline = (OWNER_BASELINE.usdMonth / OWNER_BASELINE.agents) * agents;
  return {
    id: s.id,
    label: s.label,
    workload: s.workload,
    agents,
    machineType: cap.machineType,
    hosts,
    computeUsd,
    serverUsd,
    totalUsd,
    perAgentUsd: { floor: totalUsd.floor / agents, packed: totalUsd.packed / agents },
    reductionVsBaseline: baseline / totalUsd.packed,
    meetsTarget: totalUsd.packed <= (TARGET.googleUsdMonthMax / TARGET.agents) * agents,
    costIsUpperBound: !!cap.atLeast,
    pending,
    sources: [cap.source, DUTY.source, ...(s.placement === 'pooled' ? [SERVER.source, 'D-022'] : [])],
  };
}

export function buildRows(agents: number, p532SavedGiB: number | null): Row[] {
  return SCENARIOS.map((s) => evaluate(s, agents, p532SavedGiB));
}

const usd = (n: number) => n.toFixed(n < 10 ? 2 : 0);

export function renderMarkdown(rows: Row[]): string {
  const out = [
    `| id | lever combination | shape | compute | Server (floor-packed) | total (floor-packed) | per agent | x vs ${OWNER_BASELINE.usdMonth}/${OWNER_BASELINE.agents} | target |`,
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const ub = r.costIsUpperBound ? '<=' : '';
    const tgt = r.pending ? 'PENDING P-532' : r.meetsTarget ? 'yes' : 'no';
    const hosts = r.hosts === null ? '' : ` x${r.hosts}`;
    out.push(
      `| ${r.id} | ${r.label} | ${r.machineType}${hosts} | ${ub}${usd(r.computeUsd)} | ${usd(r.serverUsd.floor)}-${usd(r.serverUsd.packed)} | ${ub}${usd(r.totalUsd.floor)}-${usd(r.totalUsd.packed)} | ${ub}${usd(r.perAgentUsd.floor)}-${usd(r.perAgentUsd.packed)} | ${r.reductionVsBaseline.toFixed(1)}x | ${tgt} |`,
    );
  }
  return out.join('\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && /cost-model\.ts$/.test(process.argv[1])) {
  const agents = Number(arg('agents') ?? TARGET.agents);
  const savedArg = arg('p532-saved-gib');
  const rows = buildRows(agents, savedArg === undefined ? null : Number(savedArg));
  console.log(process.argv.includes('--json') ? JSON.stringify(rows, null, 2) : renderMarkdown(rows));
}
