/**
 * P-013 size guide (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10006494): how many agents one
 * machine holds, for each MEASURED shape and workload, and what that costs per agent-month.
 *
 *   npx tsx scripts/agent-capacity/size-guide.ts            print the guide
 *   npx tsx scripts/agent-capacity/size-guide.ts --json     the rows as JSON
 *   npx tsx scripts/agent-capacity/size-guide.ts --write    regenerate SIZE-GUIDE.md
 *
 * Nothing is typed in here. Agent counts come from cost-model's CAPACITY and DUTY (each row names its
 * plan Decision), prices from gcp-rails, and the hosted default from the provisioning code itself. So a
 * new measurement, a price update or a changed hosted default re-sizes every row. SIZE-GUIDE.md is this
 * file's output, and size-guide.test.ts fails when the committed copy differs from a fresh render.
 *
 * Two placements, the same model cost-model uses:
 *   own VM      one workspace owns the VM. It must hold its own p99 busy agents and gives one agent
 *               slot to its Server, so the limit is the largest N with dedicatedHosts(N) === 1.
 *   pooled host many workspaces share hosts sized for the MEAN busy share, so one host serves
 *               floor(active / DUTY.mean) assigned agents. Servers are packed separately.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CAPACITY,
  type Capacity,
  dedicatedHosts,
  DUTY,
  HOST_DISK_GB,
  HOURS_PER_MONTH,
  hostMonthUsd,
  SERVER,
  serverMonthUsd,
  serverRamGiB,
  type Workload,
} from './cost-model';

export const SIZE_GUIDE_PATH = fileURLToPath(new URL('./SIZE-GUIDE.md', import.meta.url));
export const HOSTED_DEFAULTS_REL = 'packages/operator-core/lib/auth/hosted/first-workspace.ts';
/** Overridable so a mutation probe can point the guard at a mutated copy instead of the shared tree. */
export const HOSTED_DEFAULTS_PATH =
  process.env.AGENT_CAPACITY_HOSTED_DEFAULTS_PATH ?? fileURLToPath(new URL(`../../${HOSTED_DEFAULTS_REL}`, import.meta.url));

/** Idle-Server RAM the P-532 embed sidecar frees once it exits (D-052; re-confirmed on a built .deb by WI-10006479). */
export const P532_SAVED_GIB = { value: 1.11, source: 'D-052' } as const;

/** Workspace sizes the "smallest own VM" table answers for. */
export const PICK_AGENT_COUNTS = [1, 5, 10, 15, 25, 50, 100] as const;

export interface SizeRow {
  id: string;
  workload: Workload;
  machineType: string;
  source: string;
  /** Mean agents mid-turn the shape held at its capacity step. */
  active: number;
  /** The run never saturated, so every count derived from `active` is a lower bound. */
  atLeast: boolean;
  /** Most assigned agents one workspace can run on its own VM of this shape. */
  ownVmAgents: number;
  /** Assigned agents one pooled host of this shape serves. */
  pooledAgents: number;
  hostMonthUsd: { onDemand: number; spot: number };
  /** Spot compute per assigned agent-month on a pooled host (cost-model's pooledComputeUsd for one agent). */
  pooledPerAgentSpotUsd: number;
  /** Spot cost per agent of an own VM filled to its limit; the Server runs inside it. */
  ownVmPerAgentSpotUsd: number;
}

/** Inverse of cost-model's dedicatedHosts: the largest N one VM of this shape holds. */
export function ownVmAgents(cap: Capacity): number {
  let n = 0;
  while (dedicatedHosts(n + 1, cap) === 1) n += 1;
  return n;
}

export function pooledAgents(cap: Capacity): number {
  return Math.floor(cap.active / DUTY.mean);
}

export function sizeRows(): SizeRow[] {
  return CAPACITY.map((cap) => {
    const spot = hostMonthUsd(cap.machineType, true);
    const own = ownVmAgents(cap);
    return {
      id: cap.id,
      workload: cap.workload,
      machineType: cap.machineType,
      source: cap.source,
      active: cap.active,
      atLeast: cap.atLeast === true,
      ownVmAgents: own,
      pooledAgents: pooledAgents(cap),
      hostMonthUsd: { onDemand: hostMonthUsd(cap.machineType, false), spot },
      pooledPerAgentSpotUsd: (spot * DUTY.mean) / cap.active,
      ownVmPerAgentSpotUsd: spot / own,
    };
  });
}

export interface ServerRow {
  label: string;
  ramGiB: number;
  cores: number;
  /** Server cores and RAM at e2 spot list rates; a lower bound that needs near-perfect packing. */
  floorUsd: number;
  /** As measured: one e2-standard-16 spot host divided by the tenants it held (D-045 packing). */
  packedUsd: number;
  source: string;
}

export function serverRows(): ServerRow[] {
  const variants = [
    { label: 'embed model in the Server process', saved: 0, source: SERVER.source },
    { label: 'embed sidecar exits when idle (P-532)', saved: P532_SAVED_GIB.value, source: `${SERVER.source} + ${P532_SAVED_GIB.source}` },
  ];
  return variants.map((v) => {
    const usd = serverMonthUsd(v.saved);
    return { label: v.label, ramGiB: serverRamGiB(v.saved), cores: SERVER.cores, floorUsd: usd.floor, packedUsd: usd.packed, source: v.source };
  });
}

export interface HostedDefault {
  machineType: string;
  provisioningModel: string;
  source: string;
}

/**
 * The shape a new Papercusp-hosted workspace gets, read from the provisioning code, so the guide cannot
 * describe a default that is no longer the default.
 */
export function readHostedDefault(sourceText: string = readFileSync(HOSTED_DEFAULTS_PATH, 'utf8')): HostedDefault {
  const block = /export const GCP_FIRST_WORKSPACE_DEFAULTS = \{([\s\S]*?)\n\} as const;/.exec(sourceText);
  const size = block ? /\n\s*size: '([^']+)'/.exec(block[1] ?? '') : null;
  const model = /export const PAPERCUSP_HOSTED_GCP_PROVISIONING_MODEL = '([^']+)'/.exec(sourceText);
  if (!size?.[1] || !model?.[1]) {
    throw new Error(`could not read the hosted default from ${HOSTED_DEFAULTS_REL} (GCP_FIRST_WORKSPACE_DEFAULTS.size / PAPERCUSP_HOSTED_GCP_PROVISIONING_MODEL)`);
  }
  return { machineType: size[1], provisioningModel: model[1], source: HOSTED_DEFAULTS_REL };
}

export interface OwnVmPick {
  agents: number;
  machineType: string;
  hosts: number;
  spotUsd: number;
  lowerBound: boolean;
}

/** Cheapest own-VM setup (spot) for one workspace of `agents`, over the measured shapes of a workload. */
export function cheapestOwnVm(agents: number, workload: Workload, rows: SizeRow[] = sizeRows()): OwnVmPick {
  let best: OwnVmPick | null = null;
  for (const r of rows.filter((x) => x.workload === workload)) {
    const cap = CAPACITY.find((c) => c.id === r.id);
    if (!cap) continue;
    const hosts = dedicatedHosts(agents, cap);
    const spotUsd = hosts * r.hostMonthUsd.spot;
    if (!best || spotUsd < best.spotUsd) best = { agents, machineType: r.machineType, hosts, spotUsd, lowerBound: r.atLeast };
  }
  if (!best) throw new Error(`no measured ${workload} shape`);
  return best;
}

const usd = (n: number) => n.toFixed(n < 10 ? 2 : 0);
const atLeast = (r: { atLeast: boolean }) => (r.atLeast ? '>=' : '');

export function renderSizeGuide(hosted: HostedDefault = readHostedDefault()): string {
  const rows = sizeRows();
  const out: string[] = [];
  out.push(
    '<!-- GENERATED by scripts/agent-capacity/size-guide.ts. Do not edit; regenerate with: npx tsx scripts/agent-capacity/size-guide.ts --write -->',
    '# Agent size guide',
    '',
    'How many agents one machine holds, measured on real GCP VMs (plan `agent-capacity-and-cost-gcp-2026-09-30`).',
    `Agent counts come from \`cost-model.ts\`, and each row names the plan decision it was measured in. Prices are us-central1 list prices from \`gcp-rails.ts\` with a ${HOST_DISK_GB} GB disk and ${HOURS_PER_MONTH} h per month. Compute only: LLM tokens, egress and workspace data disks are not included.`,
    '',
    '- **active**: agents mid-turn at once that the machine held before commands slowed past the bar (D-019). `>=` means the run never saturated, so the real figure is higher.',
    `- **own VM**: assigned agents ONE workspace can run on its own VM. It has to hold its own busy peak (on average ${DUTY.mean * 100}% of agents are busy, and p99 is ${DUTY.p99OverMean}x that, ${DUTY.source}), and one agent slot goes to its Server.`,
    '- **pooled host**: assigned agents one host serves when many workspaces share a pool sized for the average. Servers are packed on their own hosts (see below).',
    '- **mixed** = 50/50 Claude/Codex planning work, replayed. **heavy** = typecheck/test-heavy Papercusp engineering; its rows depend on the levers named in the source column.',
    '',
    '## Agents per machine',
    '',
    '| workload | machine | active | own VM | pooled host | USD/month on-demand / spot | spot USD per agent-month, pooled | spot USD per agent-month, own VM full | source |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const lb = atLeast(r);
    out.push(
      `| ${r.workload} | ${r.machineType} | ${lb}${r.active} | ${lb}${r.ownVmAgents} | ${lb}${r.pooledAgents} | ${usd(r.hostMonthUsd.onDemand)} / ${usd(r.hostMonthUsd.spot)} | ${r.atLeast ? '<=' : ''}${usd(r.pooledPerAgentSpotUsd)} | ${r.atLeast ? '<=' : ''}${usd(r.ownVmPerAgentSpotUsd)} | ${r.source} |`,
    );
  }

  out.push('', '## Smallest own VM for a workspace (mixed work, spot)', '', '| assigned agents | cheapest setup | USD/month |', '|---|---|---|');
  for (const n of PICK_AGENT_COUNTS) {
    const p = cheapestOwnVm(n, 'mixed', rows);
    out.push(`| ${n} | ${p.machineType}${p.hosts > 1 ? ` x${p.hosts}` : ''} | ${p.lowerBound ? '<=' : ''}${usd(p.spotUsd)} |`);
  }
  out.push('', 'A pool beats every row here: it is sized for the average, not for each workspace\'s own peak (see `cost-model.ts`, D-046).');

  out.push('', '## Server per workspace', '', '| Server | host RAM GiB | idle cores | USD/month floor | USD/month packed | source |', '|---|---|---|---|---|---|');
  for (const s of serverRows()) {
    out.push(`| ${s.label} | ${s.ramGiB.toFixed(2)} | ${s.cores} | ${usd(s.floorUsd)} | ${usd(s.packedUsd)} | ${s.source} |`);
  }
  out.push('', 'Floor = the Server\'s cores and RAM at e2 spot rates, reachable only with near-perfect packing. Packed = one e2-standard-16 spot host divided by the Servers it held.');

  const fits = rows.filter((r) => r.machineType === hosted.machineType);
  out.push('', '## Hosted default', '', `A new Papercusp-hosted workspace gets its own \`${hosted.machineType}\` VM, ${hosted.provisioningModel} (read from \`${hosted.source}\`).`);
  if (fits.length === 0) {
    out.push('', `**Not measured.** No capacity run covered \`${hosted.machineType}\`, so this guide cannot say how many agents it holds.`);
  } else {
    out.push('');
    for (const r of fits) {
      out.push(`- ${r.workload}: up to ${atLeast(r)}${r.ownVmAgents} assigned agents (${atLeast(r)}${r.active} active), ${usd(r.hostMonthUsd.spot)} USD/month on spot (${r.source}).`);
    }
    for (const w of ['mixed', 'heavy'] as const) {
      if (!fits.some((r) => r.workload === w)) out.push(`- ${w}: not measured on this shape.`);
    }
  }

  const cheapest = (w: Workload) => rows.filter((r) => r.workload === w).reduce((a, b) => (b.pooledPerAgentSpotUsd < a.pooledPerAgentSpotUsd ? b : a));
  const mixed = cheapest('mixed');
  const heavy = cheapest('heavy');
  const server = serverRows()[1];
  out.push(
    '',
    '## Pricing inputs',
    '',
    'The Google cost a price has to cover each month, with a shared pool on spot:',
    '',
    `- per workspace, its Server: ${usd(server?.floorUsd ?? 0)}-${usd(server?.packedUsd ?? 0)} USD, floor to packed; Server variant: ${server?.label ?? 'unknown'}; source: ${server?.source ?? 'unknown'}.`,
    `- per mixed agent: ${atLeast(mixed) ? '<=' : ''}${usd(mixed.pooledPerAgentSpotUsd)} USD on ${mixed.machineType}; source: ${mixed.source}.`,
    `- per heavy agent: ${atLeast(heavy) ? '<=' : ''}${usd(heavy.pooledPerAgentSpotUsd)} USD on ${heavy.machineType}; source: ${heavy.source}.`,
    '',
    'The pricing model is the owner\'s decision and is not made yet. The default in use is a base fee per workspace plus a per-agent fee (D-046, D-052); metered busy agent-hours is the alternative. This guide commits no price.',
    '',
    'To re-run the measurements behind these rows, see `README.md` in this directory.',
    '',
  );
  return out.join('\n');
}

if (process.argv[1] && /size-guide\.ts$/.test(process.argv[1])) {
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows: sizeRows(), servers: serverRows(), hostedDefault: readHostedDefault() }, null, 2));
  } else if (process.argv.includes('--write')) {
    writeFileSync(SIZE_GUIDE_PATH, renderSizeGuide());
    console.log(`wrote ${SIZE_GUIDE_PATH}`);
  } else {
    console.log(renderSizeGuide());
  }
}
