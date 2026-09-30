/**
 * EXECUTABLE advisories — turn a matched command into the tool call that
 * replaces it (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-009,
 * which absorbed P-008 per D-059).
 *
 * The registry has always been able to say WHICH tool answers a command. What it
 * could not say is WHAT TO TYPE. An advisory reading "capability:read
 * { file_path, tail: N } returns the last N lines" leaves the agent to parse its
 * own command back apart, map `-n 25` onto `tail: 25`, and re-quote the path —
 * for a saving of a few hundred bytes. That is a bad trade at the moment of
 * decision, and the ~2% compliance rate is what a bad trade looks like in
 * aggregate. This module closes it: the advisory carries the finished call.
 *
 * == WHY THE ENVELOPE IS `tools:invoke`, NOT A BARE `{ name, args }` ==
 *
 * D-059 measured the other half of the compliance failure and found it was not
 * defiance: 11 of 17 `advise` rows name a tool that the DOCUMENTED discovery
 * path cannot find. `ToolSearch select:capability:read` answers "No matching
 * deferred tools found", which reads as "this tool does not exist here", and
 * falling back to bash is then the CORRECT inference from what the agent was
 * shown. So handing over `{ file_path, tail: 25 }` alone would fix the
 * translation cost and leave the discovery cost — the agent still has to find a
 * callable `capability:read` before those args are worth anything.
 *
 * `tools:invoke { name, args }` has neither problem. It dispatches any catalog
 * tool server-side under the tool's real identity and the same gating a direct
 * call gets, and it ships in every trimmed seed. So the rendered envelope is
 * executable from ANY session surface with no discovery step, which is what
 * "compliance cost approaches zero" actually requires.
 *
 * == WHY ABSENCE IS THE DEFAULT, AND WHY THAT IS LOAD-BEARING HERE ==
 *
 * An envelope is derived ONLY from a pair's own `rewrite()`. That is already the
 * opt-in contract `types.ts` describes for replay ("a pair earns automatic
 * rewriting by demonstrating one, and silence means no"), and reusing it rather
 * than inventing a second derivation keeps one statement of what a pair can
 * exactly express.
 *
 * It also does a job specific to this module. The `ambient-context` pairs
 * (`date`, `uptime`, `nproc`, `free`) name `coord:orient` as their tool, but
 * their whole point is that the answer ALREADY ARRIVED on the agent's last
 * orient — their advisories say "read it there; do not call anything", because
 * calling orient to read a clock costs more than the `date` it replaced. Those
 * pairs declare no `rewrite()`, so they get no envelope, and the one thing this
 * module must never do — render `tools:invoke { name: "coord:orient" }` as a
 * suggested call — cannot happen by construction rather than by remembering to
 * special-case it.
 *
 * == FAIL-OPEN ==
 *
 * Every entry point swallows. This runs inside a PreToolUse gate on every shell
 * command from every agent on the box, and the module's entire value is a nicer
 * advisory. A throwing `rewrite()` must cost the agent an envelope, never a
 * command — the same trade `match.ts` and `check_command.ts` already make.
 */

import { ALL_PAIRS } from './pairs';
import type { SubstitutionPair } from './types';

/**
 * A finished, executable tool call derived from the command that matched.
 *
 * Deliberately NOT `ReplayToolCall` (which spells the tool `toolName`): this is
 * a WIRE shape that crosses `locks:check_command` into two hooks, and it is
 * named for the `tools:invoke { name, args }` envelope it renders into so the
 * field names and the thing an agent types are the same words.
 */
export interface InvokeEnvelope {
  /** The tool to call, e.g. `capability:read`. */
  name: string;
  /** Arguments derived from the matched atom, e.g. `{ file_path, tail }`. */
  args: Record<string, unknown>;
}

/**
 * The longest rendered envelope we will put in an advisory.
 *
 * An envelope exists to be cheaper than the prose it accompanies. A rewrite that
 * inlines, say, a long SQL string can exceed that, at which point the advisory
 * is no longer doing the agent a favour — so an oversized render is dropped
 * entirely rather than truncated. A truncated `tools:invoke {…` is strictly
 * worse than none: it is not executable, but it LOOKS executable, so the agent
 * pays the paste before discovering it was cut.
 */
export const MAX_RENDERED_ENVELOPE_CHARS = 600;

/** Pairs indexed by `intentLabel` — the key the registry row carries. */
const PAIRS_BY_INTENT = new Map<string, SubstitutionPair>(
  ALL_PAIRS.map((pair) => [pair.intentLabel, pair]),
);

/**
 * The executable call for one matched atom, or null when there isn't one.
 *
 * Null is an ordinary, expected answer with four distinct causes, none of which
 * is an error: the intent has no code pair (a hand-added registry row), the pair
 * declares no `rewrite()` (the opt-in default above), the rewrite declined this
 * atom, or the rewrite threw.
 *
 * The `intentLabel` join is what lets the DB stay the source of truth for WHICH
 * patterns are enforced (D-002) while the code stays the source of truth for how
 * one is expressed. Note the consequence: if a row's `bash_pattern` is edited in
 * the DB to claim atoms the code pair's `cover()` does not recognise, this
 * returns null for those atoms and the advisory silently falls back to prose.
 * That is the correct failure direction — a drifted row loses its envelope, it
 * does not gain a wrong one.
 */
export function deriveInvokeEnvelope(intentLabel: string, atom: string): InvokeEnvelope | null {
  const pair = PAIRS_BY_INTENT.get(intentLabel);
  return pair ? envelopeFromPair(pair, atom) : null;
}

/**
 * {@link deriveInvokeEnvelope} for a pair you already hold — and the seam the
 * fail-open contract is tested through.
 *
 * Exported because the alternative is testing "a throwing `rewrite()` costs an
 * envelope, not a command" by adding a deliberately-broken pair to `ALL_PAIRS`,
 * where it would also reach the equivalence harness, the registry seed and the
 * routing generator. A guarantee this module makes on every shell command on the
 * box should be provable without shipping a landmine to five other consumers.
 */
export function envelopeFromPair(pair: SubstitutionPair, atom: string): InvokeEnvelope | null {
  try {
    if (!pair.rewrite) return null;

    const call = pair.rewrite(atom);
    if (!call) return null;
    // A rewrite is free-form code in a pair module; the shape it promises is not
    // enforced at runtime anywhere else, and a malformed one would otherwise
    // render as `tools:invoke { name: "undefined", … }` — an advisory that is
    // worse than the prose it replaced, because it looks runnable.
    if (typeof call.toolName !== 'string' || call.toolName === '') return null;
    if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)) return null;

    return { name: call.toolName, args: call.args };
  } catch {
    return null;
  }
}

/**
 * The paste-ready line for an envelope, or null when it renders too large.
 *
 * Args are rendered as JSON rather than as JS object literal source because the
 * result is a thing an agent copies into a tool call, and JSON is the one
 * spelling that is unambiguous about quoting — `{ file_path: /tmp/x.log }` is
 * not a valid argument to anything, and the paths this fires on routinely
 * contain characters that need quoting.
 */
export function renderInvokeEnvelope(envelope: InvokeEnvelope): string | null {
  try {
    const args = JSON.stringify(envelope.args);
    const line = `tools:invoke { name: "${envelope.name}", args: ${args} }`;
    return line.length > MAX_RENDERED_ENVELOPE_CHARS ? null : line;
  } catch {
    // A rewrite returning a cyclic or non-serialisable arg. Not representable,
    // so not offered — the prose advisory still stands on its own.
    return null;
  }
}

/** A registry match, plus the executable call for it when one could be derived. */
export interface WithInvokeEnvelope {
  intentLabel: string;
  atom: string;
  invoke?: InvokeEnvelope;
  invokeLine?: string;
}

/**
 * Attach an envelope — structured AND rendered — to every match that can carry one.
 *
 * Done SERVER-SIDE, in `locks:check_command`, and it ships the RENDERED STRING
 * rather than leaving each gate to format the args itself. Both decisions are
 * about the same hazard.
 *
 * The derivation needs `ALL_PAIRS` — live code, with each pair's real parser —
 * which a PreToolUse hook does not have: it sees only the wire payload. The omp
 * hook imports nothing but node builtins on purpose, and the cc hook is Python
 * inside a shell script. So a hook-side derivation would mean THREE copies of
 * every pair's argument mapping, in two languages, and this file's own header
 * records what that costs: the two gates' messages "already state the same
 * routing twice, and the pair has drifted before".
 *
 * Shipping `invokeLine` reduces both gates to printing a string they cannot
 * disagree about — the same reason `match.ts` is the single matcher rather than
 * one per consumer. `invoke` is carried alongside it for a programmatic caller
 * that wants the args rather than the paste, and the two cannot diverge because
 * the line is rendered from the object.
 */
export function attachInvokeEnvelopes<T extends { intentLabel: string; atom: string }>(
  matches: T[],
): (T & { invoke?: InvokeEnvelope; invokeLine?: string })[] {
  return matches.map((match) => {
    const invoke = deriveInvokeEnvelope(match.intentLabel, match.atom);
    if (!invoke) return { ...match };

    // An envelope too large to render is dropped WHOLE, structured form
    // included. Returning `invoke` without `invokeLine` would hand the gates
    // exactly the formatting job this function exists to keep away from them.
    const invokeLine = renderInvokeEnvelope(invoke);
    return invokeLine ? { ...match, invoke, invokeLine } : { ...match };
  });
}
