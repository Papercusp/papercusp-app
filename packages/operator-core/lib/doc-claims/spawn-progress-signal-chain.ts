/**
 * The EMITTED progress-signal chain for in-process loopback launches must stay
 * JOINED (WI-6113 / WI-3302; sibling of `gate-candidate-ref.ts`, same P-004
 * family).
 *
 * ── WHAT THIS PINS, AND WHY A UNIT TEST CANNOT ──────────────────────────────
 *
 * `spawned_agents.last_output_at` is the only liveness proxy that a wedged-alive
 * in-process launch cannot fake: `heartbeat_at` is an unconditional 60s wall-clock
 * timer (durable-spawn.ts's `managedSetInterval('durable-spawn-heartbeat', …)`),
 * so it stays fresh while the workload is dead. Populating `last_output_at`
 * therefore takes a chain of FOUR independently-owned hops:
 *
 *   1. invoke.ts echoes `OUTER_ACTIVITY_ECHO_MARKER` to its OWN process.stderr
 *      whenever the inner agent-CLI child emits real output.
 *   2. orchestrator-runner's `runChild` watches that outer stream and fires
 *      `onOutputActivity`.
 *   3. the /invoke route wires `onOutputActivity` to a stamper that calls
 *      `heartbeatSpawns(sql, [id], outputAtMs)` — the THREE-argument form.
 *   4. the in-process launch callers (durable-spawn, launch-blueprint) pass
 *      `spawnRecordId` so the route knows which row to stamp.
 *
 * Every hop has its own unit test and every hop passed while the CHAIN was
 * broken: WI-3302 was exactly this shape — invoke.ts forwarded the inner child's
 * output to the chunk-bus but never echoed it onto its own streams, so hop 2 saw
 * silence and `last_output_at` was NULL on 0/1553 sampled rows. Nothing failed.
 * A per-hop test cannot see that, because each hop was individually correct.
 *
 * ── WHY THE SOURCE, AND NOT PRODUCTION DATA ─────────────────────────────────
 *
 * Production data cannot falsify this claim: as of 2026-08-24 the newest
 * `last_output_at` stamp anywhere is 2026-08-10, but that zero is ABSENCE OF
 * OPPORTUNITY, not failure — since 2026-08-22 10:46 the only `launch-*` rows are
 * mug launches correctly refused (the tier is retired) and rows whose `failed`
 * status was written by the boot-id reclaim sweep after a host restart, not by
 * real runs. A dormant population makes a query indistinguishable from a break,
 * which is precisely why the chain needs a build-time pin instead.
 *
 * ── THE THREE-ARGUMENT DISTINCTION IS THE WHOLE POINT ───────────────────────
 *
 * `heartbeatSpawns(sql, ids)` (2-arg) is the KEEPALIVE and is correct at its four
 * call sites. `heartbeatSpawns(sql, ids, outputAtMs)` (3-arg) is the only form
 * that advances `last_output_at`. A refactor that "simplifies" the route's
 * stamper down to the 2-arg form is silent, plausible, and re-breaks the class —
 * so arity, not mere presence of the identifier, is what this judges.
 */
import { stripComments } from './gate-candidate-ref';

/** A source is this short only when the read failed or the file moved. */
const MIN_JUDGEABLE_CHARS = 200;

export interface ChainSources {
  /** libs/papercusp/packages/orchestrator/src/invoke.ts */
  invoke: string;
  /** packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts */
  route: string;
  /** packages/operator-core/lib/dbos/durable-spawn.ts */
  durableSpawn: string;
  /** packages/operator-core/lib/blueprint/launch-blueprint.ts */
  launchBlueprint: string;
}

export interface ChainVerdict {
  ok: boolean;
  violations: string[];
  /** hop 1: `process.stderr.write(...OUTER_ACTIVITY_ECHO_MARKER...)` sites. */
  echoSites: number;
  /** hop 3a: `onOutputActivity:` wiring sites in the route. */
  wiringSites: number;
  /** hop 3b: route `heartbeatSpawns` calls carrying an outputAtMs argument. */
  stampingCalls: number;
  /** route `heartbeatSpawns` calls in the 2-arg keepalive form. */
  keepaliveCalls: number;
  /** hop 4: callers that pass `spawnRecordId`. */
  recordIdCallers: string[];
  /**
   * Sources that could not be judged at all. NOT the same as "no violations
   * found" — an unreadable source is an instrument failure, and collapsing the
   * two is the false-absence class this repo keeps paying for.
   */
  unjudgeable: string[];
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

/**
 * Return the balanced argument text of every `name(...)` call in `source`.
 * String and template literals are skipped so a comma inside a string can never
 * inflate the arity.
 */
export function callArguments(source: string, name: string): string[] {
  const out: string[] = [];
  const needle = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = needle.exec(source)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    let quote: string | null = null;
    for (; i < source.length && depth > 0; i += 1) {
      const ch = source[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (OPENERS.has(ch)) depth += 1;
      else if (CLOSERS.has(ch)) depth -= 1;
    }
    if (depth === 0) out.push(source.slice(start, i - 1));
  }
  return out;
}

/** Count top-level arguments in a balanced argument text. */
export function topLevelArity(args: string): number {
  if (args.trim() === '') return 0;
  let depth = 0;
  let quote: string | null = null;
  let count = 1;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return count;
}

const strip = (source: string): string => stripComments(source).join('\n');

/**
 * Judge the four hops. Every violation names the OBSERVABLE CONSEQUENCE of the
 * break, not just the missing token, because the consequence is what a future
 * reader needs in order to decide whether their refactor is the one at fault.
 */
export function judgeProgressSignalChain(sources: ChainSources): ChainVerdict {
  const violations: string[] = [];
  const unjudgeable: string[] = [];

  for (const [label, text] of Object.entries(sources)) {
    if (text.length < MIN_JUDGEABLE_CHARS) unjudgeable.push(label);
  }
  if (unjudgeable.length > 0) {
    violations.push(
      `sources unreadable or moved (${unjudgeable.join(', ')}) — the chain was NOT judged. ` +
        'This is an instrument failure, not a clean result: do not read it as "no violations".',
    );
  }

  const invoke = strip(sources.invoke);
  const route = strip(sources.route);
  const durableSpawn = strip(sources.durableSpawn);
  const launchBlueprint = strip(sources.launchBlueprint);

  // Hop 1 — invoke.ts must echo onto its OWN stderr, not merely define the marker.
  const echoSites = callArguments(invoke, 'process\\.stderr\\.write').filter((a) =>
    a.includes('OUTER_ACTIVITY_ECHO_MARKER'),
  ).length;
  if (!unjudgeable.includes('invoke') && echoSites === 0) {
    violations.push(
      'hop 1 broken: invoke.ts no longer writes OUTER_ACTIVITY_ECHO_MARKER to its own ' +
        'process.stderr, so the outer process observes silence for the whole run and ' +
        'last_output_at stays NULL — the exact WI-3302 regression (0/1553 rows stamped).',
    );
  }

  // Hop 3a — the route must wire the callback at all.
  const wiringSites = (route.match(/onOutputActivity\s*:/g) ?? []).length;
  if (!unjudgeable.includes('route') && wiringSites === 0) {
    violations.push(
      'hop 3 broken: the /invoke route no longer wires onOutputActivity, so child output ' +
        'is observed but never persisted — last_output_at can never advance.',
    );
  }

  // Hop 3b — and it must wire it to the THREE-argument stamping form.
  const routeCalls = callArguments(route, 'heartbeatSpawns').map(topLevelArity);
  const stampingCalls = routeCalls.filter((n) => n >= 3).length;
  const keepaliveCalls = routeCalls.filter((n) => n === 2).length;
  if (!unjudgeable.includes('route') && stampingCalls === 0) {
    violations.push(
      'hop 3 degraded: every heartbeatSpawns call in the /invoke route is the 2-argument ' +
        'KEEPALIVE form. Only heartbeatSpawns(sql, ids, outputAtMs) advances last_output_at; ' +
        'the 2-arg form refreshes heartbeat_at, which a wedged-alive process fakes for free.',
    );
  }

  // Hop 4 — the in-process launch callers must identify the row to stamp.
  const recordIdCallers: string[] = [];
  for (const [label, text] of [
    ['durableSpawn', durableSpawn],
    ['launchBlueprint', launchBlueprint],
  ] as const) {
    if (/spawnRecordId\s*:/.test(text)) recordIdCallers.push(label);
    else if (!unjudgeable.includes(label)) {
      violations.push(
        `hop 4 broken: ${label} no longer passes spawnRecordId in its invoke body, so the ` +
          'route cannot tell which spawned_agents row to stamp and this launch class silently ' +
          'reverts to keepalive-only liveness.',
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    echoSites,
    wiringSites,
    stampingCalls,
    keepaliveCalls,
    recordIdCallers,
    unjudgeable,
  };
}
