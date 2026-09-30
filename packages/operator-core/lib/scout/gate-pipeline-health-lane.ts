/**
 * gate-pipeline-health-lane.ts — the GATE / PIPELINE-HEALTH digest lane
 * (blender-self-learning-2026-07-12 P-010 / WI-4455).
 *
 * The release pipeline continuously records what is wrong with SHIPPING: a red
 * green-checkpoint verdict, a promotion stall (main behind staging), a rolled-back
 * deploy, a failing content/release fixer. Today those signals live in three
 * disjoint places — the standing gate verdict, the git position, and the
 * pipeline_events log — and NO consumer joins them: a "main is N behind staging"
 * page and a "standing red-test key" are ONE incident (the gate cannot advance),
 * but nothing tells the ideators that. They only saw pipeline pain after a human
 * FILED an incident. (Live example this lane was built from — 2026-07-12: the gate
 * sat at 4 consecutive reds with main ~102 commits behind staging for ~7h, nobody
 * driving it; the root cause was env-debris in the checkpoint tree red-pinning a
 * test that was GREEN at tip.)
 *
 * This lane feeds the release pipeline's health straight into the corpus digest as
 * grounded, citable patterns (`ref` = `pipeline:gate` / `pipeline:promotion-stall`
 * / `pipeline:event:<kind>:<status>`), so ideation can target chronic ship-path
 * pain directly — the gate/pipeline counterpart of the watchdog-health lane (P-007).
 *
 * Deterministic + fail-soft, populated by the cycle seam (cycle-deps readCorpus)
 * exactly like watchdogHealth / standingFacts / nicheMap: an outage here never
 * disturbs the digest or the cycle. Two silences are load-bearing (mirroring the
 * orient pipeline block, pipeline-health.ts): a harness with no green-checkpoint
 * routine (`known:false`) surfaces NOTHING (not a cheerful green), and a STALE
 * verdict (WI-4489) is never surfaced as a red — naming its tests would re-arm the
 * phantom-dispatch loop that item was filed for.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { MetaPattern } from './types';

/** pipeline_events.status values that mean a real FAILURE (not a benign skip/idle). */
export const PIPELINE_FAILURE_STATUSES = [
  'not-green',
  'rolled-back',
  'failed',
  'error',
  'wedged',
  'conflict',
  'crash',
] as const;

/** One 24h pipeline_events failure aggregate (the pure builder's chronic input). */
export interface GatePipelineEventFailure {
  /** e.g. 'green_checkpoint', 'deploy', 'content_fixer', 'release_fixer', 'git_sync'. */
  kind: string;
  /** one of {@link PIPELINE_FAILURE_STATUSES}. */
  status: string;
  /** occurrences in the window. */
  count: number;
}

/** The pure builder's input — the standing gate position + the 24h failure aggregate. */
export interface GatePipelineHealthInput {
  /** false ⇒ this harness runs no green-checkpoint: nothing is known, emit NOTHING. */
  known: boolean;
  gateLabel:
    | 'green'
    | 'red'
    | 'stalled'
    | 'wedged'
    | 'stale-verdict'
    | 'conflict'
    | 'inconclusive';
  /** WI-4489: the recorded red is superseded/unverified ⇒ colour UNKNOWN, never surfaced as red. */
  verdictStale: boolean;
  consecutiveReds: number;
  /** ms since the gate was last green (only when not green now); null if green/unknown. */
  gateStallMs: number | null;
  /** commits on `main`/staging not yet promoted to the green pin. */
  mainBehindStaging: number;
  /** commits on the green pin not yet live on :3070. */
  deployBehind: number;
  recentFailingFiles: readonly string[];
  /** 24h aggregate of failing pipeline events (from pipeline_events). */
  eventFailures: readonly GatePipelineEventFailure[];
}

export interface GatePipelineHealthOpts {
  /** min consecutive reds to surface the gate incident (else it's a blip). */
  minConsecutiveReds?: number;
  /** min gate-stall (ms not-green) to surface the gate incident even at low red count. */
  minGateStallMs?: number;
  /** min commits-behind to surface a promotion / deploy stall. */
  minBehind?: number;
  /** min 24h occurrences for a chronic event-failure pattern. */
  minEventFailures?: number;
  /** cap on emitted patterns. */
  limit?: number;
}

/**
 * The env-debris triage hint (WI-4455 signal c): a red that reproduces in the GATE
 * but NOT at tip is env-debris in the isolated checkpoint tree, not a code regression
 * — the distinction that would have saved ~7h on the 2026-07-12 incident.
 */
const ENV_DEBRIS_TRIAGE =
  'triage: reproduce the failing file(s) at staging TIP — a red that fails in the gate but PASSES ' +
  'at tip is env-debris in the isolated checkpoint tree (e.g. an orphaned node_modules), not a code ' +
  'regression; fix the tree, do not chase the test';

/**
 * The 240s quiet-cut trap (WI-4455 signal d): a checkpoint re-fire within ~240s of a
 * commit judges the PREVIOUS candidate, so a fresh green fix can look still-red.
 */
const QUIET_CUT_TRAP =
  'note: a checkpoint re-fire within ~240s of your commit judges the PREVIOUS candidate — do not ' +
  'read a still-red gate as your fix failing until a run that includes your commit completes';

function humanMs(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

/**
 * PURE: the standing gate position + 24h failure aggregate → digest patterns.
 *
 * Emits (most-acute first): the JOINED gate incident (consecutive reds + stall +
 * failing files + triage hints — the join no consumer makes today), a promotion
 * stall (main behind the green pin), a deploy lag (green pin not live), then the
 * chronic pipeline_events failure classes. `known:false` ⇒ [] (no gate to report);
 * a stale verdict is never surfaced as red (WI-4489). Sorted acute→chronic, capped.
 */
export function buildGatePipelineHealthPatterns(
  input: GatePipelineHealthInput,
  opts: GatePipelineHealthOpts = {},
): MetaPattern[] {
  if (!input.known) return [];
  const minReds = opts.minConsecutiveReds ?? 2;
  const minStall = opts.minGateStallMs ?? 3_600_000; // 1h
  const minBehind = opts.minBehind ?? 20;
  const minFails = opts.minEventFailures ?? 3;
  const limit = opts.limit ?? 8;

  const out: MetaPattern[] = [];
  const notGreen =
    input.gateLabel !== 'green' &&
    input.gateLabel !== 'inconclusive' &&
    !input.verdictStale;
  const stallMs = input.gateStallMs ?? 0;

  // 1. The JOINED gate incident — the acute, un-joined-today signal.
  if (notGreen && (input.consecutiveReds >= minReds || stallMs >= minStall)) {
    const files = input.recentFailingFiles.slice(0, 5);
    const filePart = files.length ? ` failing: ${files.join(', ')}.` : '';
    out.push({
      category: 'gate-pipeline-health',
      ref: 'pipeline:gate',
      summary: `release gate ${input.gateLabel}: ${input.consecutiveReds} consecutive red run(s)${
        stallMs > 0 ? `, no green for ${humanMs(stallMs)}` : ''
      } — nothing ships until it's green`,
      detail: `${input.consecutiveReds} consecutive red(s)${
        stallMs > 0 ? `, ${humanMs(stallMs)} since last green` : ''
      }.${filePart} ${ENV_DEBRIS_TRIAGE}. ${QUIET_CUT_TRAP}`,
      weight: 1,
    });
  }

  // 2. Promotion stall — main/staging ahead of the green pin. Joins with (1): a
  //    behind-count AND a standing red are ONE incident (the gate can't advance).
  if (input.mainBehindStaging >= minBehind) {
    out.push({
      category: 'gate-pipeline-health',
      ref: 'pipeline:promotion-stall',
      summary: `promotion stalled: ${input.mainBehindStaging} commits ahead of the green pin — the gate is not advancing`,
      detail: notGreen
        ? 'same incident as the standing red gate above — the pin cannot advance past a red verdict; green the gate to drain the backlog'
        : input.gateLabel === 'inconclusive'
          ? 'the latest checkpoint rendered no code verdict — inspect and clear that named abort before attributing the backlog to a red or green gate'
          : 'green pin is lagging staging despite a green gate — a promotion/checkpoint routine may be wedged or paused',
      weight: 0.9,
    });
  }

  // 3. Deploy lag — the green pin is not live on :3070.
  if (input.deployBehind >= minBehind) {
    out.push({
      category: 'gate-pipeline-health',
      ref: 'pipeline:deploy-lag',
      summary: `deploy lag: ${input.deployBehind} green-pin commits not yet live on :3070`,
      detail: 'the green pin is ahead of what is deployed — the release/deploy routine is behind or wedged',
      weight: 0.7,
    });
  }

  // 4. Chronic pipeline_events failure classes (deploy rollbacks, fixer failures,
  //    git-sync errors, repeated not-green) — sorted by frequency.
  const chronic = input.eventFailures
    .filter((f) => f.count >= minFails)
    .sort((a, b) => b.count - a.count);
  for (const f of chronic) {
    out.push({
      category: 'gate-pipeline-health',
      ref: `pipeline:event:${f.kind}:${f.status}`,
      summary: `${f.kind} ${f.status} ${f.count}× in the last 24h`,
      detail: `chronic ship-path failure class — ${f.count} occurrence(s)/24h, not a one-off`,
      weight: Math.min(0.6, 0.2 + f.count / 50),
    });
  }

  return out.slice(0, Math.max(1, limit));
}

/**
 * The PG edge: the standing gate position (REUSING computePipelineHealth — the same
 * reader orient + dev:why use, never a re-derived query) + the 24h pipeline_events
 * failure aggregate for the active workspace. Returns [] on any failure (fail-soft
 * lane) or when there is no gate to report on (`known:false`).
 */
export async function buildGatePipelineHealthLane(
  opts: { workspaceId?: string; slug?: string } = {},
): Promise<MetaPattern[]> {
  try {
    const ws = opts.workspaceId ?? activeWorkspaceId();
    const { computePipelineHealth } = await import('../why-chain');
    const health = await computePipelineHealth({ slug: opts.slug });
    if (!health.known) return [];
    const { sql } = getOrgPg();
    const fails = await sql<Array<{ kind: string; status: string; n: number }>>`
      SELECT kind, status, count(*)::int AS n
        FROM harness_shared.pipeline_events
       WHERE workspace_id = ${ws}
         AND created_at > now() - interval '24 hours'
         AND status = ANY(${[...PIPELINE_FAILURE_STATUSES]})
       GROUP BY kind, status`;
    const now = Date.now();
    const gateStallMs =
      health.gateLabel !== 'green' && health.lastGreenAtMs != null
        ? Math.max(0, now - health.lastGreenAtMs)
        : null;
    return buildGatePipelineHealthPatterns({
      known: health.known,
      gateLabel: health.gateLabel,
      verdictStale: health.verdictStale,
      consecutiveReds: health.consecutiveReds,
      gateStallMs,
      mainBehindStaging: health.greenPinBehindStaging ?? 0,
      deployBehind: health.deployedBehindGreenPin ?? 0,
      recentFailingFiles: health.recentFailingFiles,
      eventFailures: fails.map((f) => ({
        kind: f.kind,
        status: f.status,
        count: Number(f.n) || 0,
      })),
    });
  } catch {
    return [];
  }
}
