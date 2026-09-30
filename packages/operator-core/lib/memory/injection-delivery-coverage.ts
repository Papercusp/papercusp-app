/**
 * Per-(client, port) context-injection DELIVERY coverage — the derive-miss TRACE.
 *
 * Plan: codex-context-injection-parity-2026-08-09, P-005 / D-005 §3b.
 * Table: harness_shared.context_injection_coverage (migration 772 — its header
 * carries the full rationale, including why this is NOT a column on
 * memory_recall_stats).
 *
 * ⚠⚠ NOT `injection-coverage.ts`, WHICH IS A DIFFERENT MODULE ON A DIFFERENT
 * PLAN. The two names are close enough that one of them has already been
 * clobbered once (2026-08-09). Keep them straight:
 *
 *   injection-coverage.ts   (context-injection-retrieval-reach-…-2026-08-03 P-004)
 *     "Is retrieval still REACHING the corpus semantically?" — a PURE assessor
 *     over embed-coverage surfaces. No I/O. Exports assessInjectionReach /
 *     formatInjectionReachToast, consumed by dbos/periodic-workflows.ts.
 *
 *   THIS FILE                (codex-context-injection-parity-2026-08-09 P-005)
 *     "Is injection being DELIVERED to each client at all?" — a counter WRITER.
 *     Does I/O. Knows nothing about embeddings or corpus reach.
 *
 * One is about whether the corpus can answer; this one is about whether anybody
 * asked. A regression in either is invisible in the other.
 *
 * ── THE QUESTION THIS ANSWERS ──
 * "Is client X actually receiving per-turn context?" had no answer from the
 * outside, because the ways of getting no context are indistinguishable once
 * they have all written nothing:
 *
 *   no rows at all         the hook never fired            (install/trust bug)
 *   outcome='unknown-tool' it fired; the tool is unmapped   (VOCABULARY DRIFT)
 *   outcome='no-signal'    it fired; known tool, no signal  (expected quiet)
 *   outcome='no-recall'    it ran; nothing relevant         (healthy quiet)
 *   outcome='recalled'     it ran and returned context      (working)
 *
 * Only 'unknown-tool' is actionable, and before this it was invisible — which
 * is exactly how codex and omp stayed structurally zeroed on the mid-turn port
 * without anything reporting a fault (D-005 §1).
 *
 * ── FAIL-SILENT, LIKE EVERY OTHER TELEMETRY WRITE ON THIS PATH ──
 * This runs inside a hook-serving request whose whole contract is that it must
 * never cost the agent's turn. It never throws and is never awaited by the
 * caller. Losing a counter is a rounding error; surfacing an error into a turn
 * is a wedged agent.
 */

/**
 * The injection PORTS, as ONE source of truth. Matches memory_recall_stats.surface
 * vocabulary.
 *
 * ⚠⚠ EVERY PORT LISTED HERE MUST HAVE A PRODUCTION WRITER, or this vocabulary
 * lies. Until WI-37597 only `mid-turn` did: `recordInjectionCoverage` was called
 * from `mid-turn-context.ts` and nowhere else, so `context_injection_coverage`
 * had never held a single `turn-start` row for any client — while this type
 * cheerfully declared the value, and the reader below blended both ports into one
 * per-client number that healthy mid-turn traffic kept green.
 *
 * A turn-start outage was therefore STRUCTURALLY invisible, not merely unlikely —
 * the same shape as the defect this whole plan exists to fix (D-005 §1: a
 * Claude-only deriveQuery made non-Claude rows impossible rather than rare), and
 * the reason EI-20001110634702380 closed cause-undetermined.
 *
 * So: adding a port here OBLIGES you to add its writer in the same change.
 * `injection-delivery-coverage.test.ts` fails if a port has no writer.
 */
export const INJECTION_PORTS = ['turn-start', 'mid-turn'] as const;
export type InjectionPort = (typeof INJECTION_PORTS)[number];

export type InjectionDeliveryOutcome =
  /** The injection ran and returned context. */
  | 'recalled'
  /** It ran, and found nothing relevant. Healthy quiet. */
  | 'no-recall'
  /** Reached the endpoint; a KNOWN tool carried no query signal. Expected. */
  | 'no-signal'
  /** Reached the endpoint; the tool is absent from the shared vocabulary. */
  | 'unknown-tool';

export interface InjectionDeliveryEvent {
  port: InjectionPort;
  outcome: InjectionDeliveryOutcome;
  /** '' when the caller sent none — a real reading (a host without the P-005
   *  threading), deliberately not defaulted to a client name. */
  client?: string | null;
  /** The tool name, for the tool-specific outcomes. '' otherwise. */
  tool?: string | null;
  workspaceId?: string | null;
}

/**
 * A tool name is part of the primary key, so an unbounded one would be an
 * unbounded key. Nothing legitimate is close to this.
 */
const TOOL_CLAMP = 120;

/** Only these outcomes are about a specific tool; the others store ''. */
function toolFor(ev: InjectionDeliveryEvent): string {
  if (ev.outcome !== 'unknown-tool' && ev.outcome !== 'no-signal') return '';
  return (ev.tool ?? '').trim().slice(0, TOOL_CLAMP);
}

function keyOf(ev: InjectionDeliveryEvent, tool: string): string {
  return [ev.workspaceId ?? '', ev.client ?? '', ev.port, ev.outcome, tool].join(' ');
}

/**
 * Record one or more delivery-coverage events. Never throws; never
 * load-bearing. Call WITHOUT awaiting.
 *
 * Events are AGGREGATED IN JS FIRST. A codex mid-turn batch can carry a dozen
 * calls that all miss the same way, and one upsert carrying n=12 is both
 * cheaper and more honest than twelve racing increments.
 */
export async function recordInjectionCoverage(
  events: readonly InjectionDeliveryEvent[],
): Promise<void> {
  try {
    if (!events.length) return;

    const counts = new Map<string, { ev: InjectionDeliveryEvent; tool: string; n: number }>();
    for (const ev of events) {
      if (!ev?.port || !ev?.outcome) continue;
      const tool = toolFor(ev);
      const key = keyOf(ev, tool);
      const prior = counts.get(key);
      if (prior) prior.n += 1;
      else counts.set(key, { ev, tool, n: 1 });
    }
    if (counts.size === 0) return;

    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;

    for (const { ev, tool, n } of counts.values()) {
      await sql`
        INSERT INTO harness_shared.context_injection_coverage
          (day, workspace_id, client, port, outcome, tool, n, first_seen_at, last_seen_at)
        VALUES (
          CURRENT_DATE,
          ${ev.workspaceId ?? ''},
          ${ev.client ?? ''},
          ${ev.port},
          ${ev.outcome},
          ${tool},
          ${n},
          now(),
          now()
        )
        ON CONFLICT (day, workspace_id, client, port, outcome, tool)
        DO UPDATE SET
          n = harness_shared.context_injection_coverage.n + EXCLUDED.n,
          last_seen_at = now()
      `;
    }
  } catch {
    /* swallow — see the fail-silent note in the header. */
  }
}

// ── the READ side: the detector's data source ────────────────────────────────

/**
 * The frozen injection client set (D-001). The denominator is deliberately
 * restricted to these three: `agent_chat` and harness-chat sessions never had a
 * hook layer and never will, so counting them would manufacture a permanent
 * "gap" for a client that is working exactly as designed.
 */
export const INJECTION_CLIENTS = ['claude', 'codex', 'omp'] as const;
export type InjectionClient = (typeof INJECTION_CLIENTS)[number];

/**
 * ⚠⚠ THE TWO `workspace_id`s ARE NOT INTERCHANGEABLE — DO NOT "FIX" THIS INTO A JOIN.
 *
 * `harness_shared.session_turns` (the denominator) is written under the LITERAL
 * string 'default' — the session-transcript CORPUS namespace, which is NOT a
 * tenant (session-ingest.ts:1075/1458/1781 hardcode it; the warning at
 * session-ingest.ts:1703 explains why).
 * `harness_shared.context_injection_coverage` (the numerator) is written under
 * the REAL tenant (activeWorkspaceId(), 'papercusp-workspace' here).
 *
 * Measured 2026-08-09: session_turns held 53,936 rows in 7d, 100% under
 * 'default' and ZERO under 'papercusp-workspace'. So scoping the sessions leg to
 * the tenant — the obviously-correct-looking thing, and what the multi-tenant
 * SQL advisory actively suggests — returns zero sessions ALWAYS, which makes the
 * detector structurally incapable of ever firing while looking perfectly
 * healthy. That is the same shape as the defect this whole plan exists to fix
 * (D-005 §1: a Claude-only deriveQuery made non-Claude rows structurally
 * impossible, not merely rare), and it is the second time this corpus-vs-tenant
 * confusion has bitten this codebase — the first cost the substitution registry
 * every bucket count.
 */
const SESSION_CORPUS_NAMESPACE = 'default';

/**
 * One (client, port) cell — the grain at which an outage is actually visible.
 *
 * Reporting only the per-client total is what made a turn-start outage
 * undetectable: a client whose turn-start port has gone completely silent still
 * shows healthy `events` as long as its mid-turn port is working, so the failure
 * is MASKED by the traffic of the port that still works. Every field here exists
 * to be read per port, never summed back up.
 */
export interface PortInjectionCoverage {
  port: InjectionPort;
  /** Coverage events recorded for this port in the window. */
  events: number;
  byOutcome: Record<InjectionDeliveryOutcome, number>;
  /** Tool names behind `unknown-tool` on this port — the actionable drift. */
  driftTools: string[];
  /**
   * Has THIS PORT ever produced a row for this client, at any time? Per-port for
   * the same reason the client-level flag exists: a port with no baseline gives
   * no evidence its writer is deployed, so it can never be a REGRESSION — only a
   * known gap. This is what stops the turn-start writer's own rollout from
   * paging every client the moment the reader learns to look for it.
   */
  everObserved: boolean;
}

export interface ClientInjectionCoverage {
  client: string;
  /** Sessions seen for this client in the window — the DENOMINATOR. */
  sessions: number;
  /** Coverage events recorded in the window, ACROSS ALL PORTS. */
  events: number;
  byOutcome: Record<InjectionDeliveryOutcome, number>;
  /** Tool names behind `unknown-tool` — the actionable drift, named. */
  driftTools: string[];
  /**
   * Has this client EVER produced a coverage row, at any time? A client with no
   * baseline gives us no evidence that its recording path is even deployed, so
   * it can never be a REGRESSION — only a known gap. See the status function.
   */
  everObserved: boolean;
  /**
   * Per-port breakdown — ALWAYS one entry per INJECTION_PORTS, in that order,
   * present even when the port recorded nothing. A missing entry and a zeroed
   * entry read identically to a consumer looping over what it was given, and the
   * zeroed one is the whole signal here, so absence is never an option.
   */
  ports: PortInjectionCoverage[];
}

/** A window row as the numerator query returns it (one per client/port/outcome/tool). */
export interface CoverageWindowRow {
  client: string;
  port: string;
  outcome: string;
  tool: string;
  n: number;
}

/** A baseline row — this (client, port) has been observed at some point, ever. */
export interface CoverageEverRow {
  client: string;
  port: string;
}

export interface InjectionDeliveryCoverageReading {
  windowHours: number;
  clients: ClientInjectionCoverage[];
  /** Total events across all clients in the window. */
  totalEvents: number;
}

const ZERO_OUTCOMES = (): Record<InjectionDeliveryOutcome, number> => ({
  recalled: 0, 'no-recall': 0, 'no-signal': 0, 'unknown-tool': 0,
});

/**
 * Read per-client injection-delivery coverage for the health panel.
 *
 * THROWS on an unreadable source — the caller runs under `panelSafe`, which
 * turns a throw into a greyed `unknown` panel. That is the correct degradation:
 * a detector that cannot read its inputs must not report health.
 */
export async function readInjectionDeliveryCoverage(opts: {
  workspaceId: string;
  windowHours?: number;
}): Promise<InjectionDeliveryCoverageReading> {
  const windowHours = opts.windowHours ?? 24;
  const { getOrgPg } = await import('@papercusp/db-org');
  const sql = getOrgPg().sql;

  // A plain JS array — postgres.js serialises this to a real text[]. Do NOT wrap
  // it in sql.array() with a ::text[] cast: that path stringifies to the bare
  // literal `claude,codex,omp` and the query dies on "malformed array literal".
  // Caught only by running this against the live DB (2026-08-09); no unit test
  // touches the SQL, so a green suite says nothing about it.
  const clients: string[] = [...INJECTION_CLIENTS];

  // Denominator — corpus namespace, NOT the tenant (see the block comment above).
  const sessionRows = await sql<{ client: string; sessions: number }[]>`
    SELECT source_kind AS client, count(DISTINCT session_id)::int AS sessions
      FROM harness_shared.session_turns
     WHERE workspace_id = ${SESSION_CORPUS_NAMESPACE}
       AND source_kind = ANY(${clients})
       AND ts > now() - (${windowHours}::text || ' hours')::interval
     GROUP BY 1
  `;

  // Numerator — real tenant. GROUPED BY PORT: without `port` in the grouping the
  // two ports are summed before anything can compare them, and a dead port is
  // arithmetically indistinguishable from a quiet one.
  const windowRows = await sql<CoverageWindowRow[]>`
    SELECT client, port, outcome, tool, sum(n)::int AS n
      FROM harness_shared.context_injection_coverage
     WHERE workspace_id = ${opts.workspaceId}
       AND day >= (now() - (${windowHours}::text || ' hours')::interval)::date
     GROUP BY 1, 2, 3, 4
  `;

  // Baseline — has this (client, PORT) EVER been observed, at any time?
  const everRows = await sql<CoverageEverRow[]>`
    SELECT DISTINCT client, port
      FROM harness_shared.context_injection_coverage
     WHERE workspace_id = ${opts.workspaceId}
  `;

  const sessionsBy = new Map(sessionRows.map((r) => [r.client, Number(r.sessions) || 0]));

  return {
    windowHours,
    ...foldInjectionCoverage({ clients, windowRows, everRows, sessionsBy }),
  };
}

/**
 * Fold raw rows into the per-client / per-port reading. PURE — no I/O.
 *
 * Extracted from the reader so the property that actually matters can be tested
 * without a database: mid-turn traffic must NEVER make the turn-start port look
 * observed. That is the exact masking this module shipped with, and no unit test
 * could reach it while the folding lived inside a function whose first statement
 * opens a PG connection.
 */
export function foldInjectionCoverage(input: {
  clients: readonly string[];
  windowRows: readonly CoverageWindowRow[];
  everRows: readonly CoverageEverRow[];
  sessionsBy: ReadonlyMap<string, number>;
}): { clients: ClientInjectionCoverage[]; totalEvents: number } {
  // Keyed on client AND port together — keying on either alone is precisely the
  // blend this function exists to prevent.
  const ever = new Set(input.everRows.map((r) => `${r.client}\x00${r.port}`));

  const out: ClientInjectionCoverage[] = input.clients.map((client) => {
    const clientOutcomes = ZERO_OUTCOMES();
    const clientDrift: string[] = [];
    let clientEvents = 0;

    const ports: PortInjectionCoverage[] = INJECTION_PORTS.map((port) => {
      const byOutcome = ZERO_OUTCOMES();
      const driftTools: string[] = [];
      let events = 0;
      for (const r of input.windowRows) {
        if (r.client !== client || r.port !== port) continue;
        const n = Number(r.n) || 0;
        events += n;
        if (r.outcome in byOutcome) byOutcome[r.outcome as InjectionDeliveryOutcome] += n;
        if (r.outcome === 'unknown-tool' && r.tool) driftTools.push(r.tool);
      }
      // Roll the port up into the client totals, so the two views cannot drift
      // apart the way two independently-computed sums would.
      clientEvents += events;
      for (const k of Object.keys(byOutcome) as InjectionDeliveryOutcome[]) {
        clientOutcomes[k] += byOutcome[k];
      }
      clientDrift.push(...driftTools);
      return {
        port,
        events,
        byOutcome,
        driftTools: [...new Set(driftTools)].sort(),
        everObserved: ever.has(`${client}\x00${port}`),
      };
    });

    return {
      client,
      sessions: input.sessionsBy.get(client) ?? 0,
      events: clientEvents,
      byOutcome: clientOutcomes,
      driftTools: [...new Set(clientDrift)].sort(),
      // Client-level baseline stays ANY-port on purpose: it answers "has this
      // client's recording path ever worked at all", which the per-port flags
      // then refine.
      everObserved: ports.some((p) => p.everObserved),
      ports,
    };
  });

  return { clients: out, totalEvents: out.reduce((a, c) => a + c.events, 0) };
}
