/**
 * sentinel-context — the Sentinel's "understands the full system" live
 * read-context.
 *
 * The Sentinel brain is the SAME converse brain as the operator, loaded with the
 * Sentinel persona (role='sentinel'). Where the operator reacts turn-by-turn to the
 * user, the Sentinel must walk in already KNOWING the live state of the whole
 * system — escalations, anomalies, progress, and "what's worth surfacing" — so it
 * can surface, file, and nudge, never re-derive from raw coord.
 *
 * This module follows the queen-brief.ts pattern EXACTLY (P-005 reuse):
 *   - a PURE, deterministic renderer (`renderSentinelContext`) over already-shaped
 *     input — no Date.now / Math.random in the output, so it unit-tests with no DB
 *     and the same input always renders the same bytes;
 *   - a deps-wiring adapter (`gatherSentinelContext`) that consumes the READY-MADE
 *     digests (NOT raw coord): `curation:feed`'s salience ranking (rankFleetFeed
 *     over gatherFleetSignals), the `curation:state-of-pot` corpus digest
 *     (synthesizeStateOfHive), and the Overwatch anomaly brief
 *     (computeOverwatchBrief). Each source is fail-soft — a flaky leg degrades to
 *     an empty section, never throws the whole gather.
 *
 * It is a SENTINEL slice of the queen-brief: escalations + anomalies + progress +
 * "what's worth surfacing", NOT placement rank (the Queen owns placement; the
 * Sentinel owns surfacing). Bounded by per-section caps so it stays a compact block
 * (token caps — D-007 of the converse-prompt budget discipline).
 */

import type { Anomaly, AnomalySeverity, AnomalyActionType } from '../overwatch/brief-types';

/* ────────────────────────────────────────────────────────────────────────────
 * Input shape — already-digested, never raw coord. The adapter
 * (gatherSentinelContext) fills this from the ready-made digest sources.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One salience-ranked live signal — the curation:feed projection (a FeedRow
 *  slice: only the fields the Sentinel surfaces). */
export interface SentinelSignal {
  /** The signal kind — escalation / blocker / decision / completion / progress. */
  kind: string;
  /** One calm line for the user. */
  title: string;
  /** Owning harness slug, when applicable. */
  harness?: string | null;
  /** Escalation severity, when the signal derives from one. */
  severity?: 'blocker' | 'question' | 'advisory' | null;
  /** Drill-in pointer (e.g. `escalation:<msgId>`, `wi:<harness>#<id>`). */
  ref?: string | null;
  /** Curation disposition (surface > batch > suppress). */
  disposition?: string;
  /** Always-surface fire-alarm flag. */
  urgent?: boolean;
}

/** One standing meta-pattern from the state-of-pot corpus digest — the
 *  "what keeps biting us" substrate (recurring friction / time-token sink /
 *  chronic deferral / capability gap). A MetaPattern slice. */
export interface SentinelPattern {
  /** Which lane this pattern came from (friction / sink / deferral / gap). */
  lane: string;
  /** The pattern's one-line summary. */
  summary: string;
  /** Drill-back ref to the originals. */
  ref?: string | null;
}

/** One live agent's load + liveness (fleet:assignments) — the progress floor. */
export interface SentinelBee {
  /** The agent's coord id / label. */
  id: string;
  /** Head-of-line work it is doing now (short label), if any. */
  doing?: string | null;
  /** Claimed-work count. */
  load: number;
  /** Liveness — a fresh heartbeat. */
  alive: boolean;
}

/** One open deep-thinking delegation the Sentinel can answer follow-ups from
 *  without re-delegating or waking the Queen again. */
export interface SentinelDelegation {
  id: string;
  title: string;
  harness?: string | null;
  state: string;
  claimed: boolean;
  lastActivityAt?: string | null;
}

/** The system-status snapshot the Sentinel walks in with. Every field optional /
 *  empty-tolerant — a degraded gather still renders a coherent (smaller) block. */
export interface SentinelContextInput {
  /** The hive/workspace this context covers (for the heading). */
  potSlug?: string;
  /** Salience-ranked live signals (curation:feed), already ranked surface-first. */
  signals?: readonly SentinelSignal[];
  /** Detected drift + suggested action (Overwatch brief), already severity-ordered. */
  anomalies?: readonly Anomaly[];
  /** Standing meta-patterns (state-of-pot corpus digest). */
  patterns?: readonly SentinelPattern[];
  /** Live agent load + liveness (fleet:assignments) — the progress floor. */
  bees?: readonly SentinelBee[];
  /** Open deep-thinking delegations already in flight for the conversation lane. */
  delegations?: readonly SentinelDelegation[];
  /** The state-of-pot one-line headline (the digest's own rollup). */
  headline?: string | null;
  /** Override the default per-section caps. */
  caps?: Partial<SentinelContextCaps>;
}

/** Per-section list caps so the context stays a DIGEST, never a raw dump (P-007). */
export interface SentinelContextCaps {
  signals: number;
  anomalies: number;
  patterns: number;
  bees: number;
  delegations: number;
}

export const DEFAULT_SENTINEL_CONTEXT_CAPS: SentinelContextCaps = {
  signals: 12,
  anomalies: 10,
  patterns: 8,
  bees: 16,
  delegations: 6,
};

/* ────────────────────────────────────────────────────────────────────────────
 * The renderer — pure + deterministic (no clock / random in the output).
 * ──────────────────────────────────────────────────────────────────────────── */

/** Uppercase action verb per anomaly action — mirrors the overwatch renderer. */
const ACTION_VERB: Record<AnomalyActionType, string> = {
  nudge: 'NUDGE',
  escalate: 'ESCALATE',
  observe: 'OBSERVE',
};

/** Stable severity rank so anomalies render most-urgent-first, deterministically. */
const SEVERITY_RANK: Record<AnomalySeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Append a capped list section; emits a "+N more" overflow line when truncated. */
function section(
  out: string[],
  heading: string,
  lines: readonly string[],
  cap: number,
  drillHint?: string,
  intro?: string,
): void {
  if (lines.length === 0) return;
  out.push('');
  out.push(`### ${heading}`);
  if (intro) out.push(intro);
  for (const line of lines.slice(0, cap)) out.push(line);
  const overflow = lines.length - cap;
  if (overflow > 0) out.push(`…+${overflow} more${drillHint ? ` (${drillHint})` : ''}`);
}

function renderSignalLine(s: SentinelSignal): string {
  const sev = s.severity ? ` (${s.severity})` : '';
  const where = s.harness ? ` [${s.harness}]` : '';
  const urgent = s.urgent ? '⚠ ' : '';
  const ref = s.ref ? ` — ${s.ref}` : '';
  return `- ${urgent}[${s.kind}${sev}]${where} ${s.title}${ref}`;
}

function renderAnomalyLine(a: Anomaly): string {
  const act = a.suggestedAction;
  const verb = ACTION_VERB[act.type];
  const target = act.target ? ` ${act.target}` : '';
  // EI-13557: surface the stable conditionKey for escalate actions so the reader
  // passes it verbatim to coord:escalate instead of inventing/omitting one — the
  // root cause of the self-inflating "N aging owner-attention escalations" advisory.
  const conditionKey = act.type === 'escalate' && act.conditionKey ? ` [conditionKey: ${act.conditionKey}]` : '';
  return `- [${a.severity}] ${a.kind} — ${a.subject}: ${a.detail} → ${verb}${target}${conditionKey}`;
}

function renderDelegationLine(d: SentinelDelegation): string {
  const where = d.harness ? ` [${d.harness}]` : '';
  const claim = d.claimed ? 'claimed' : 'unclaimed';
  const activity = d.lastActivityAt ? `, last activity ${d.lastActivityAt}` : '';
  return `- ${d.id}${where} ${d.state}, ${claim}${activity} — ${d.title}`;
}

/**
 * Render the Sentinel's live system-status context as a deterministic markdown
 * block. Injected into the sentinel converse prompt's SYSTEM sections (only when
 * role==='sentinel') so the Sentinel walks in already understanding the full system.
 *
 * Sections, in surfacing priority: anomalies (the actionable drift) → live signals
 * (escalations/blockers/decisions/completions, salience-ranked) → standing
 * patterns (what keeps biting) → progress (who's running). Each is capped. An
 * all-quiet system renders the headings with an explicit "nothing" so silence is a
 * trustworthy signal, not an omission.
 */
export function renderSentinelContext(input: SentinelContextInput): string {
  const caps = { ...DEFAULT_SENTINEL_CONTEXT_CAPS, ...input.caps };
  const out: string[] = [];

  const scope = input.potSlug && input.potSlug.trim() ? ` — ${input.potSlug.trim()}` : '';
  out.push(`## Live system status${scope} (your standing context — you watch the whole system)`);
  out.push(
    'This is the deterministic snapshot of the running system, built from the ready-made ' +
      'digests (the salience-ranked signal feed, the Kettle anomaly brief, the state-of-pot ' +
      'corpus digest, and the live fleet). It is your STANDING awareness as Papercup: act on ' +
      'it by SURFACING what matters to the user, FILING an observation/escalation, or NUDGING a ' +
      'running agent — never by re-placing work (that is the Mug). Drill into anything this ' +
      'digest omits with a tool (curation:feed, curation:state-of-pot, fleet:assignments) only ' +
      'when you need it. When an anomaly line carries `[conditionKey: …]`, pass that exact string ' +
      "as coord:escalate's `conditionKey` argument — it coalesces repeated firings of the SAME " +
      'condition onto one row instead of leaking a fresh escalation every time its live count changes ' +
      '(EI-13557); keep any count/duration in `body`, never in `summary`.',
  );

  if (input.headline && input.headline.trim()) {
    out.push('');
    out.push(`**Headline:** ${input.headline.trim()}`);
  }

  // ANOMALIES — the actionable drift (most-severe first, deterministic stable sort).
  const anomalies = (input.anomalies ?? [])
    .map((a, idx) => ({ a, idx }))
    .sort((x, y) => SEVERITY_RANK[x.a.severity] - SEVERITY_RANK[y.a.severity] || x.idx - y.idx)
    .map(({ a }) => a);
  out.push('');
  out.push('### Anomalies — detected drift (act on these)');
  if (anomalies.length === 0) {
    out.push('_no anomalies — system healthy._');
  } else {
    for (const a of anomalies.slice(0, caps.anomalies)) out.push(renderAnomalyLine(a));
    const overflow = anomalies.length - caps.anomalies;
    if (overflow > 0) out.push(`…+${overflow} more (overwatch brief drills down)`);
  }

  // LIVE SIGNALS — salience-ranked escalations/blockers/decisions/completions.
  section(
    out,
    "Live signals — what's worth surfacing (salience-ranked)",
    (input.signals ?? []).map(renderSignalLine),
    caps.signals,
    'curation:feed to drill down',
    'These lines are internal engineering context for tool use. They may contain exact work-item, session, actor, or repository identifiers. Use them to investigate, but paraphrase those identifiers in owner-facing replies unless the owner explicitly asks for the exact value.',
  );

  // OPEN DELEGATIONS — hard-thinking work already in flight. Follow-up questions
  // ("how's that analysis going?") should be answered from THESE items rather than
  // re-delegated or handed to the Queen again.
  section(
    out,
    'Open deep delegations — answer follow-up status questions from these items first',
    (input.delegations ?? []).map(renderDelegationLine),
    caps.delegations,
    'work_items:get to drill down',
  );

  // STANDING PATTERNS — what keeps biting (the corpus digest meta-patterns).
  section(
    out,
    'Standing patterns — recurring friction / sinks / deferrals / gaps',
    (input.patterns ?? []).map((p) => `- [${p.lane}] ${p.summary}${p.ref ? ` — ${p.ref}` : ''}`),
    caps.patterns,
    'curation:state-of-pot to drill down',
  );

  // PROGRESS — who's running (the live fleet floor).
  section(
    out,
    'Progress — live fleet (load + liveness)',
    (input.bees ?? []).map(
      (b) => `- ${b.id}: load ${b.load}${b.doing ? `, doing ${b.doing}` : ''} ${b.alive ? '[alive]' : '[DEAD]'}`,
    ),
    caps.bees,
    'fleet:assignments to drill down',
  );

  return out.join('\n');
}

/**
 * The heading scope LABEL for the Sentinel's standing context. When the
 * per-hive→workspace brain re-key is ON (FLAGS.WORKSPACE_COORDINATION) the
 * summary's digest legs already span the whole workspace — signals
 * (buildFleetReaders), patterns (buildStateOfHiveReaders) and bees
 * (listFleetAssignments({ workspaceId })) carry no hive filter, and the anomalies
 * leg runs computeSystemHealth(workspaceId) (workspace-scoped, potSlug used only
 * for addressing). See plan workspace-scoped-coordination-2026-06-20 D-008. So the
 * Sentinel (whose persona is "you watch the whole system") should present its
 * summary as WORKSPACE-scoped (all hives) rather than mislabeled with one
 * arbitrary harness. OFF → the primary hive slug, byte-identical to today.
 *
 * Pure (the flag value is passed in) so the live-chat + proactive-sweep call sites
 * stay consistent and it unit-tests with no DB. This changes ONLY the heading
 * LABEL — the anomalies leg's potSlug (computeOverwatchBrief addressing) is left
 * unchanged; the deeper per-hive anomaly depth rides on the overwatch/queen re-key
 * (P-004/P-003), which the Sentinel inherits for free.
 */
export function sentinelScopeLabel(workspaceId: string, primaryPotSlug: string, workspaceCoordOn: boolean): string {
  return workspaceCoordOn ? `workspace ${workspaceId} (all hives)` : primaryPotSlug;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The deps-wiring adapter — consumes the READY-MADE digests (P-005 reuse, never
 * fork a gatherer). Fail-soft per leg.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The injectable digest sources. Each returns an already-digested slice so the
 *  builder stays pure + the gather is trivially mockable in tests. */
export interface SentinelContextDeps {
  /** The salience-ranked live signal feed (curation:feed projection). */
  signals(): Promise<readonly SentinelSignal[]>;
  /** The Overwatch anomaly brief's detected drift. */
  anomalies(): Promise<readonly Anomaly[]>;
  /** The state-of-pot corpus digest: standing meta-patterns + headline. */
  patterns(): Promise<{ patterns: readonly SentinelPattern[]; headline?: string | null }>;
  /** The live fleet (fleet:assignments). */
  bees(): Promise<readonly SentinelBee[]>;
  /** Open deep-thinking delegations already in flight. */
  delegations(): Promise<readonly SentinelDelegation[]>;
}

/** Run a digest leg, swallowing any error to a fallback — one flaky source can't
 *  kill the whole context build (mirrors the overwatch / fleet-signals fail-soft). */
async function safe<T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[sentinel-context] ${label} failed (degrading that section):`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Gather the four ready-made digests into a `SentinelContextInput`. Fail-soft per
 * leg: a degraded source yields an empty section, never throws. The caller renders
 * the result with `renderSentinelContext`.
 */
export async function gatherSentinelContext(
  deps: SentinelContextDeps,
  opts: { potSlug?: string; caps?: Partial<SentinelContextCaps> } = {},
): Promise<SentinelContextInput> {
  const [signals, anomalies, patternBundle, bees, delegations] = await Promise.all([
    safe(() => deps.signals(), [] as readonly SentinelSignal[], 'signals'),
    safe(() => deps.anomalies(), [] as readonly Anomaly[], 'anomalies'),
    safe(
      () => deps.patterns(),
      { patterns: [] as readonly SentinelPattern[], headline: null } as { patterns: readonly SentinelPattern[]; headline?: string | null },
      'patterns',
    ),
    safe(() => deps.bees(), [] as readonly SentinelBee[], 'bees'),
    safe(() => deps.delegations(), [] as readonly SentinelDelegation[], 'delegations'),
  ]);
  return {
    potSlug: opts.potSlug,
    signals,
    anomalies,
    patterns: patternBundle.patterns,
    headline: patternBundle.headline ?? null,
    bees,
    delegations,
    caps: opts.caps,
  };
}

/**
 * Production deps: wire the four ready-made digest sources to their real
 * implementations. Each leg consumes the SAME module the corresponding tool does
 * (rankFleetFeed/gatherFleetSignals, computeOverwatchBrief, synthesizeStateOfHive,
 * listFleetAssignments/groupByAgent) — NOT a re-derivation from raw coord. Lazy
 * imports keep this off the prompt-assembly hot path until a sentinel turn needs it.
 */
export function buildSentinelContextDeps(workspaceId: string, potSlug: string): SentinelContextDeps {
  return {
    async signals() {
      const { gatherFleetSignals } = await import('../curation/fleet-signals');
      const { buildFleetReaders } = await import('../curation/deps');
      const { rankFleetFeed } = await import('../agent-tools/curation/feed');
      const { dropTriagedHandledSignals } = await import('../curation/salience-policy');
      const { readTriagedHandledItemIds } = await import('../attention/triage-store');
      const raw = await gatherFleetSignals(buildFleetReaders());
      const handled = await readTriagedHandledItemIds().catch(() => new Set<string>());
      const rows = rankFleetFeed(dropTriagedHandledSignals(raw, handled), { surfaceOnly: true });
      return rows.map((r) => ({
        kind: r.kind,
        title: r.title,
        harness: r.harness,
        severity: r.severity,
        ref: r.ref,
        disposition: r.disposition,
        urgent: r.urgent,
      }));
    },
    async anomalies() {
      const { computeOverwatchBrief } = await import('../overwatch/compute-brief');
      const brief = await computeOverwatchBrief(workspaceId, potSlug, { wokeBy: 'sentinel-context' });
      return brief.anomalies;
    },
    async patterns() {
      const { synthesizeStateOfHive } = await import('../scout/corpus-digest');
      const { buildStateOfHiveReaders } = await import('../scout/corpus-digest-deps');
      const digest = await synthesizeStateOfHive(buildStateOfHiveReaders(), { nowMs: Date.now() });
      const take = (lane: string, arr: ReadonlyArray<{ summary: string; ref: string }>): SentinelPattern[] =>
        arr.map((p) => ({ lane, summary: p.summary, ref: p.ref }));
      const patterns: SentinelPattern[] = [
        ...take('friction', digest.recurringFriction),
        ...take('sink', digest.timeTokenSinks),
        ...take('deferral', digest.chronicDeferrals),
        ...take('gap', digest.capabilityGaps),
      ];
      return { patterns, headline: digest.headline };
    },
    async bees() {
      const { listFleetAssignments, groupByAgent } = await import('../fleet/assignments');
      const rows = await listFleetAssignments({ workspaceId, activeOnly: true });
      const agents = groupByAgent(rows).filter((g) => g.claims.length > 0 || g.alive);
      return agents.map((a) => ({
        id: a.name ?? a.label ?? a.agentId,
        doing: a.doing ? a.doing.title || a.doing.id || null : null,
        load: a.load,
        alive: a.alive,
      }));
    },
    async delegations() {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { sql } = getOrgPg();
      const rows = await sql<Array<{
        feature_id: string;
        harness_slug: string | null;
        title: string | null;
        status: string | null;
        taken_by: string | null;
        last_progress_at: unknown;
        updated_ts: unknown;
      }>>`
        SELECT feature_id, harness_slug, title, status, taken_by, last_progress_at, updated_ts
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND item_kind = 'task'
           AND status <> ALL(ARRAY['passed', 'deprecated', 'resolved', 'closed']::text[])
           AND payload->>'deep_delegation' = 'true'
         ORDER BY COALESCE(last_progress_at, to_timestamp(updated_ts::double precision / 1000.0))
                  DESC NULLS LAST,
                  feature_id ASC
         LIMIT ${DEFAULT_SENTINEL_CONTEXT_CAPS.delegations}`;
      const tsIso = (v: unknown): string | null =>
        v == null ? null : v instanceof Date ? v.toISOString() : String(v);
      return rows.map((r) => ({
        id: r.feature_id,
        harness: r.harness_slug,
        title: r.title ?? '(untitled deep delegation)',
        state: r.status ?? 'todo',
        claimed: !!r.taken_by,
        lastActivityAt: tsIso(r.last_progress_at) ?? tsIso(r.updated_ts),
      }));
    },
  };
}
