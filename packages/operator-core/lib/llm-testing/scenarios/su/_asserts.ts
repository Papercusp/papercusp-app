/**
 * Custom-assert builders for the `su` scenarios.
 *
 * Why custom (not the built-in `tool_called` / `text_excludes`):
 *   - `tool_called` name-matching is a LOOSE tail-match (`docs:get` also
 *     matches `plans:get` / `features:get`), so it can't pin an exact tool or
 *     an arg-presence check.
 *   - `text_excludes` is WARN severity — it can't be a load-bearing (gating)
 *     check. These builders emit ERROR severity so a banned/missing behavior
 *     actually fails the run.
 *
 * Each builder returns a `{ kind: 'custom', name, eval }` DeterministicAssert.
 */

import type { DeterministicAssert, RunSummary, ToolCallEvent, Violation } from '@papercusp/testing-shell/llm';

type CustomAssert = Extract<DeterministicAssert, { kind: 'custom' }>;

interface Meta {
  name: string;
  claim: string;
  suggestion?: string;
}

/** Strip a possible mcp prefix to the canonical colon form. The su target
 *  already records canonical names; this is defensive. */
function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

function allToolCalls(run: RunSummary): ToolCallEvent[] {
  return run.turns.flatMap((t) => t.toolCalls);
}

/**
 * The call a tool event actually DISPATCHED, as canonical name + args. `tools:invoke
 * { name, args }` is the playbook's sanctioned dispatch door for a tool that is not loaded
 * directly, and the su target forwards it into the same scenario world (targets/su.ts
 * resolveToolResult). A predicate that reads only `tc.name` / `tc.input` therefore scores a
 * real filing made through that door as "never called". Predicates that check WHAT was done
 * (not which door was used) should read through this. Name-based builders retain
 * the outer call when their spec explicitly names tools:invoke (S31/S33).
 */
export function effectiveToolCall(tc: ToolCallEvent): { name: string; input: Record<string, unknown> } {
  const name = canonical(tc.name);
  const input = (tc.input ?? {}) as Record<string, unknown>;
  if (name === 'tools:invoke' && typeof input.name === 'string') {
    const args = input.args;
    return {
      name: canonical(input.name.trim()),
      input: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
    };
  }
  return { name, input };
}

function stringItems(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function violation(meta: Meta, evidenceTurnIdx?: number): Violation {
  return {
    assertKind: `custom:${meta.name}`,
    severity: 'error',
    ...(evidenceTurnIdx !== undefined ? { evidenceTurnIdx } : {}),
    claim: meta.claim,
    ...(meta.suggestion ? { suggestion: meta.suggestion } : {}),
  };
}

/** Does `name` match one of `specs`? A spec is either an exact canonical name
 *  (`docs:get`) or a group wildcard (`design-phase:*`). */
function nameMatches(name: string, specs: string[]): boolean {
  const c = canonical(name);
  return specs.some((spec) => {
    if (spec.endsWith(':*')) return c.startsWith(spec.slice(0, -1)); // 'design-phase:'
    return c === spec;
  });
}

function matchingCall(
  tc: ToolCallEvent,
  specs: string[],
): { name: string; input: Record<string, unknown> } | null {
  const outer = { name: canonical(tc.name), input: (tc.input ?? {}) as Record<string, unknown> };
  if (nameMatches(outer.name, specs)) return outer;
  const effective = effectiveToolCall(tc);
  return effective.name !== outer.name && nameMatches(effective.name, specs) ? effective : null;
}

/** ERROR unless at least one tool in any of `groups` was called with a
 *  non-empty STRING value at `argKey` (e.g. docs/plans called WITH a harness
 *  scope arg). */
export function assertToolGroupWithStringArg(
  groups: string[],
  argKey: string,
  meta: Meta,
): CustomAssert {
  const specs = groups.map((g) => `${g}:*`);
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const hit = allToolCalls(run).some((tc) => {
        const match = matchingCall(tc, specs);
        if (!match) return false;
        const v = match.input[argKey];
        return typeof v === 'string' && v.trim().length > 0;
      });
      return hit ? [] : [violation(meta)];
    },
  };
}

/** ERROR unless at least one of `specs` (exact or `group:*`) was called. */
export function assertToolCalled(specs: string[], meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => (allToolCalls(run).some((tc) => matchingCall(tc, specs)) ? [] : [violation(meta)]),
  };
}

/** ERROR unless one of `specs` is called within the first `turnCount`
 * assistant turns. This distinguishes an immediate action from a deferred
 * close-out call that eventually happens only after repeated prompting. */
export function assertToolCalledWithin(
  specs: string[],
  turnCount: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turns = run.turns.slice(0, Math.max(0, turnCount));
      const hit = turns.some((turn) => turn.toolCalls.some((tc) => matchingCall(tc, specs)));
      return hit ? [] : [violation(meta)];
    },
  };
}

/** ERROR if ANY of `specs` (exact or `group:*`) was called — the load-bearing
 *  "must NOT fire" gate (the built-in `tool_not_called` is warn-only). */
export function assertToolNotCalled(specs: string[], meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const hits = allToolCalls(run).filter((tc) => matchingCall(tc, specs));
      return hits.length === 0 ? [] : [violation(meta)];
    },
  };
}

/** ERROR if `specs` (exact or `group:*`) were called MORE than `max` times in
 *  total — catches an agent that hand-loops a per-item tool instead of batching
 *  it into one code:run. */
export function assertToolCallCountAtMost(specs: string[], max: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const count = allToolCalls(run).filter((tc) => matchingCall(tc, specs)).length;
      return count <= max ? [] : [violation(meta)];
    },
  };
}

/** ERROR unless one matching call carries an array argument with at least the
 * requested number of elements. A call-count guard alone cannot distinguish a
 * genuine native bulk call from one scalar call that touched only the first
 * row (WI-2146035). */
export function assertToolCalledWithArrayArg(
  specs: string[],
  argKey: string,
  minLength: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const hit = allToolCalls(run).some((tc) => {
        const match = matchingCall(tc, specs);
        if (!match) return false;
        const value = match.input[argKey];
        return Array.isArray(value) && value.length >= minLength;
      });
      return hit ? [] : [violation(meta)];
    },
  };
}

/** ERROR unless `specs` (exact or `group:*`) were called AT LEAST `min` times in
 *  total — the load-bearing "must have re-fetched" gate. Used by the delta
 *  fallback scenario (agent-tool-delta-protocol P-007): when the base snapshot
 *  was compacted away, the SUT must FALL BACK to a full re-fetch rather than
 *  hallucinate-merge a delta against a base it no longer holds, so the snapshot
 *  tool fires more times than the happy (base-present) path needs. */
export function assertToolCallCountAtLeast(specs: string[], min: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const count = allToolCalls(run).filter((tc) => matchingCall(tc, specs)).length;
      return count >= min ? [] : [violation(meta)];
    },
  };
}

/**
 * ERROR unless the agent either uses code:run OR emits the required direct calls together in a
 * single assistant/model turn. P-012: raw RPC count is not inference cost — three parallel tool_use
 * blocks in one response are already one inference turn and must pass the batching rubric.
 */
export function assertCodeRunOrBulkOrSingleTurnFanout(
  specs: string[],
  requiredDirectCalls: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      if (allToolCalls(run).some((tc) => matchingCall(tc, ['code:run']))) return [];
      if (allToolCalls(run).some((tc) => {
        const match = matchingCall(tc, specs);
        if (!match) return false;
        const ids = match.input.ids;
        return Array.isArray(ids) && ids.length >= requiredDirectCalls;
      })) return [];
      const hitTurns = run.turns
        .map((turn, index) => ({ index, count: turn.toolCalls.filter((tc) => matchingCall(tc, specs)).length }))
        .filter((row) => row.count > 0);
      const directCount = hitTurns.reduce((sum, row) => sum + row.count, 0);
      return directCount >= requiredDirectCalls && hitTurns.length === 1
        ? []
        : [violation(meta, hitTurns[1]?.index ?? hitTurns[0]?.index)];
    },
  };
}

/** ERROR unless the given predicate finds a matching tool call. Use for
 *  compound conditions (e.g. design-phase:* OR docs:* with a design-ish arg). */
export function assertToolMatch(
  predicate: (tc: ToolCallEvent) => boolean,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => (allToolCalls(run).some(predicate) ? [] : [violation(meta)]),
  };
}

/**
 * ERROR unless the run claims every requested plan item through one of the
 * claim-capable plan tools. A single matching call is not enough here: the
 * regression this guards against claimed P-002 while silently omitting the
 * requested dependent P-003 (EI-22796206670888081).
 */
export function assertRequestedPlanItemsClaimed(
  planSlug: string,
  requestedItems: string[],
  meta: Meta,
): CustomAssert {
  const requested = [...new Set(requestedItems)];

  const itemsFromCall = (tc: ToolCallEvent): string[] => {
    const { name, input } = effectiveToolCall(tc);

    if (name === 'coord:orient') {
      return input.planSlug === planSlug ? stringItems(input.planItems) : [];
    }
    if (name === 'coord:declare-intent') {
      return input.current_plan_slug === planSlug ? stringItems(input.items) : [];
    }
    if (name === 'plans:set-status') {
      return input.slug === planSlug && input.status === 'wip' && typeof input.itemId === 'string'
        ? [input.itemId]
        : [];
    }
    if (name !== 'plan_items:claim' && name !== 'plan_items:convert') return [];

    const directPlan = input.plan;
    const directItems = directPlan === planSlug
      ? [...stringItems(input.item), ...stringItems(input.itemIds)]
      : [];
    const heterogeneousItems = Array.isArray(input.items)
      ? input.items.flatMap((entry): string[] => {
          if (!entry || typeof entry !== 'object') return [];
          const row = entry as Record<string, unknown>;
          return row.plan === planSlug && typeof row.item === 'string' ? [row.item] : [];
        })
      : [];
    return [...directItems, ...heterogeneousItems];
  };

  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const claimed = new Set(allToolCalls(run).flatMap(itemsFromCall));
      const missing = requested.filter((item) => !claimed.has(item));
      if (missing.length === 0) return [];

      const evidenceTurnIdx = run.turns.findIndex((turn) => turn.toolCalls.some((tc) => itemsFromCall(tc).length > 0));
      return [
        violation({
          ...meta,
          claim: `${meta.claim} Missing requested plan item(s): ${missing.join(', ')}.`,
        }, evidenceTurnIdx >= 0 ? evidenceTurnIdx : undefined),
      ];
    },
  };
}

/** ERROR unless a matching action is followed by a matching verification call. */
export function assertToolSequence(
  action: (tc: ToolCallEvent) => boolean,
  verification: (tc: ToolCallEvent) => boolean,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const calls = allToolCalls(run);
      const actionIndex = calls.findIndex(action);
      const verified = actionIndex >= 0 && calls.slice(actionIndex + 1).some(verification);
      return verified ? [] : [violation(meta)];
    },
  };
}

/** ERROR if ANY turn's assistant text matches `pattern` (a banned behavior the
 *  model expresses in prose — e.g. proposing a raw SQL write or a browser nav
 *  to :3070). Stronger than `text_excludes`, which is warn-only. */
export function assertTextForbids(pattern: RegExp, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      for (let i = 0; i < run.turns.length; i++) {
        if (pattern.test(run.turns[i].assistantText)) return [violation(meta, i)];
      }
      return [];
    },
  };
}

/** A negation cue immediately governing a nearby banned term — "there is NO
 *  `features:update`", "I won't use raw SQL", "doesn't have a psql path". */
const NEGATION_CUE = /\b(no|not|n['’]t|never|isn['’]t|doesn['’]t|won['’]t|cannot|can['’]t|nor|without)\b/i;

/** ERROR if ANY turn's assistant text matches `pattern` in an AFFIRMATIVE
 *  context — i.e. the match is NOT immediately preceded (within
 *  `negationWindow` chars) by a negation cue ("no", "not", "isn't", ...).
 *  `assertTextForbids` alone can't distinguish a model PROPOSING a banned
 *  action ("I'll run `psql ...`") from one correctly explaining why it
 *  refused ("there is no `features:update` verb") — both contain the same
 *  substring. Observed live (SU-S05, 2026-07-17): a model that correctly
 *  cited "no features:update" / "no direct state-write verb" while routing
 *  through the real `messages:send` path tripped the plain forbids-regex as
 *  hard as a model that actually proposed the banned call — a false
 *  positive that would have masked a genuine behavioral fix. Same family as
 *  EI-7923/WI-3229 (see this file's test-header docs): an assert-authoring
 *  gap, not a model regression. */
export function assertTextForbidsAffirmed(
  pattern: RegExp,
  meta: Meta,
  negationWindow = 40,
): CustomAssert {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      for (let i = 0; i < run.turns.length; i++) {
        const text = run.turns[i].assistantText;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
          const windowStart = Math.max(0, m.index - negationWindow);
          const before = text.slice(windowStart, m.index);
          if (!NEGATION_CUE.test(before)) return [violation(meta, i)];
          if (m[0].length === 0) re.lastIndex += 1; // avoid an infinite loop on a zero-length match
        }
      }
      return [];
    },
  };
}

/** ERROR if the selected assistant turn's text matches `pattern`. Use when an
 *  earlier turn may legitimately mention text that must be absent from the
 *  answer under test (for example, a delta scenario's base-list turn naming a
 *  row that the final merged-list turn must remove). */
export function assertTextForbidsInTurn(pattern: RegExp, turnIdx: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      return pattern.test(turn.assistantText) ? [violation(meta, turnIdx)] : [];
    },
  };
}

/** Index of the LAST match of `pattern` in `text`, or -1 if none. Used by
 *  `assertTextForbidsInTurnAfter` (EI-7923/WI-3229): a model may legitimately
 *  use an anchor-like phrase in a lead-in sentence ("Here's the updated
 *  list. Two changes: ...") before the REAL section header right before the
 *  table ("**Current open work items:**"). Anchoring on the FIRST match (the
 *  lead-in) would fail to skip past an intervening "what changed" narration
 *  that legitimately mentions the forbidden term; the last match is the one
 *  closest to the actual content under test. */
function lastMatchIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    last = m.index;
    if (m[0].length === 0) re.lastIndex += 1; // avoid an infinite loop on a zero-length match
  }
  return last;
}

/** ERROR if the selected assistant turn's text matches `pattern` after the
 *  LAST match of `sectionStart`. Useful when the answer may legitimately
 *  discuss a removed item in a "what changed" preamble, but must not include
 *  it in the current list that follows. If the section marker is absent,
 *  fall back to the full turn so the assert still catches obviously wrong
 *  current-list answers. */
export function assertTextForbidsInTurnAfter(
  pattern: RegExp,
  turnIdx: number,
  sectionStart: RegExp,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      const marker = lastMatchIndex(turn.assistantText, sectionStart);
      const text = marker >= 0 ? turn.assistantText.slice(marker) : turn.assistantText;
      return pattern.test(text) ? [violation(meta, turnIdx)] : [];
    },
  };
}

/** Like `assertTextForbidsInTurnAfter`, but checks matching LINES and permits
 * a match when that same line satisfies `allowedLine`. This is for current-view
 * answers that may show a historical row only when it is visibly annotated as
 * removed/closed; an unmarked row still fails the merge contract. */
export function assertTextForbidsInTurnAfterUnlessLine(
  pattern: RegExp,
  turnIdx: number,
  sectionStart: RegExp,
  allowedLine: RegExp,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      const marker = lastMatchIndex(turn.assistantText, sectionStart);
      const text = marker >= 0 ? turn.assistantText.slice(marker) : turn.assistantText;
      const forbidden = new RegExp(pattern.source, pattern.flags.replaceAll('g', ''));
      const allowed = new RegExp(allowedLine.source, allowedLine.flags.replaceAll('g', ''));
      const badLine = text.split('\n').find((line) => forbidden.test(line) && !allowed.test(line));
      return badLine === undefined ? [] : [violation(meta, turnIdx)];
    },
  };
}

/** ERROR unless SOME turn's assistant text matches `pattern` (the model points
 *  at the blessed path — e.g. names the Tauri/desktop flow, or SSE/IPC push). */
export function assertTextRequires(pattern: RegExp, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => (run.turns.some((t) => pattern.test(t.assistantText)) ? [] : [violation(meta)]),
  };
}

/** ERROR unless the selected assistant turn's text matches `pattern`. */
export function assertTextRequiresInTurn(pattern: RegExp, turnIdx: number, meta: Meta): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turn = run.turns[turnIdx];
      if (!turn) return [violation(meta)];
      return pattern.test(turn.assistantText) ? [] : [violation(meta, turnIdx)];
    },
  };
}

/** ERROR unless `pattern` matches within the FIRST `withinTurns` assistant
 *  turns — for the SAME-TURN class of rules (the behavior must fire when its
 *  cue lands, not get queued for close-out; agent policies §19). A full-run
 *  assertTextRequires would pass a deferred mention on the last turn, which is
 *  exactly the failure mode under test. */
export function assertTextRequiresWithin(
  pattern: RegExp,
  withinTurns: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) =>
      run.turns.slice(0, withinTurns).some((t) => pattern.test(t.assistantText))
        ? []
        : [violation(meta)],
  };
}

/** ERROR unless SOME turn from `fromTurnIdx` onward matches `pattern`.
 *
 * (EI-7923/WI-3229) A hardcoded `assertTextRequiresInTurn(pattern, 1, ...)`
 * false-positives whenever the model legitimately needs an extra turn before
 * its substantive answer (e.g. a clarifying question after a compaction wiped
 * disambiguating context) — the correct content lands one turn later than the
 * scenario's fixed index assumed, and the assert fails even though the final
 * delivered answer is right. Use this instead of `assertTextRequiresInTurn`
 * whenever the model may legitimately take an extra turn to get there. */
export function assertTextRequiresFromTurn(
  pattern: RegExp,
  fromTurnIdx: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turns = run.turns.slice(fromTurnIdx);
      const hitIdx = turns.findIndex((t) => pattern.test(t.assistantText));
      return hitIdx >= 0 ? [] : [violation(meta)];
    },
  };
}

/** ERROR if ANY turn from `fromTurnIdx` onward matches `pattern` — the
 *  range-checked sibling of `assertTextForbidsInTurn`, for the same
 *  turn-index-rigidity reason as `assertTextRequiresFromTurn` above: a banned
 *  value can land in whichever turn ends up carrying the final answer, not
 *  necessarily the scenario's originally-assumed fixed index. */
export function assertTextForbidsFromTurn(
  pattern: RegExp,
  fromTurnIdx: number,
  meta: Meta,
): CustomAssert {
  return {
    kind: 'custom',
    name: meta.name,
    eval: (run) => {
      const turns = run.turns.slice(fromTurnIdx);
      const hitIdx = turns.findIndex((t) => pattern.test(t.assistantText));
      return hitIdx >= 0 ? [violation(meta, fromTurnIdx + hitIdx)] : [];
    },
  };
}
