/**
 * The reaction rule registry — the single inspectable Events registry
 * (event-reaction-system D-002). One `@papercusp/event-reaction`
 * `ReactionRegistry` (itself over a `@papercusp/rules` `RulesEngine`), indexed by
 * trigger tool, holding every reaction rule from every source: the built-in
 * Events file (`./rules`), `emits:` co-location sugar (coord-lifecycle-automation
 * D-002), and plugin/blueprint-contributed rules (D-012).
 *
 * This module is the PUBLIC registration boundary other subsystems build on —
 * `registerReactionRule` is the stable API the `emits` desugar calls. The registry
 * is anchored on `globalThis` so every importer (and both the tsx runtime and a
 * vitest module graph) shares ONE registry instance. (The lib intentionally does
 * NOT anchor a singleton — process-wide sharing is this host's concern.)
 */

import type { MatchedAction } from '@papercusp/rules';
import { ReactionRegistry } from '@papercusp/event-reaction';
import { pinModuleState } from '@papercusp/module-singleton';
import type { ReactionRule, ToolInvocationEvent } from './types';

type ReactionEngine = ReactionRegistry<ToolInvocationEvent, string>;

// Realm-pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[key]` pair: hand-rolling shares the registry correctly but is
// invisible to listModuleDuplications(), which then answers a confident `[]`
// while this module is split (EI-19479108855357092).
const __state = pinModuleState<{ engine: ReactionEngine | null }>(
  '@papercusp/operator-core.reactionEngine',
  () => ({ engine: null }),
);

/** The wildcard trigger key every `<schema>.<table>.changed` event also matches. */
export const TABLE_CHANGED_KEY = '*.changed';

/**
 * The trigger key(s) an event matches rules on. The primary key is the event's
 * `tool` (the rule index, e.g. `coord:handoff` or `harness_shared.harness_plans.changed`).
 *
 * A table-change event (`<schema>.<table>.changed`, emitted from the sync change
 * stream via `emitSystemEvent`) ALSO matches the wildcard `'*.changed'` key — so a
 * single rule keyed on `'*.changed'` reacts to a change on ANY table without
 * enumerating the open-ended table set (caching-layer-tag-eca-2026-06-22 P-004:
 * the cache-invalidation rule reads the concrete table off `e.tool`).
 */
function keyOf(event: ToolInvocationEvent): string | string[] {
  if (event.tool.endsWith('.changed')) return [event.tool, TABLE_CHANGED_KEY];
  return event.tool;
}

function engine(): ReactionEngine {
  if (!__state.engine) {
    __state.engine = new ReactionRegistry<ToolInvocationEvent, string>({
      keyOf,
      onError: (err, rule) => {

        console.warn(
          `[events] rule "${rule.id}" condition threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    });
  }
  return __state.engine;
}

/**
 * Register an event-reaction rule. Idempotent by `rule.id` (re-registering the
 * same id replaces). Safe to call at module-load. THE public API the `emits`
 * desugar + plugin/blueprint contributions call.
 *
 * ⚠ EI-6980 — your `when`/`args` sees ONE PER-ITEM event, never the bulk envelope.
 * Every agent-facing bulk-capable tool returns `{ ok, results: [...], counts }`
 * (`runBulk`/`bulkContent`), even for a single-item call — but `matchAndRun`
 * (`./engine.ts`'s `fanOutBulkEvent`, D-007) explodes that envelope into one
 * synthetic event PER RESULT ITEM before matching, and never matches the bulk
 * carrier itself. So `e.result.data` in your rule is always a single flat
 * per-item record (e.g. `{ workItem, completion, ... }`) — a rule written to
 * read `e.result.data.results[]` matches NOTHING, silently, with no error
 * (reconcile-rule.ts sat dead this way — EI-5925/EI-6960). Read the per-item
 * shape directly, the way `./reflect-rules.ts` does (`data.workItem`).
 */
export function registerReactionRule(rule: ReactionRule): void {
  engine().add(rule);
}

/** Remove a rule by id. Returns true if one was removed. */
export function unregisterReactionRule(id: string): boolean {
  return engine().remove(id);
}

/** Every registered rule — inspectability / the reactive-graph view (D-010). */
export function listReactionRules(): ReactionRule[] {
  return engine().rules();
}

/** Rules registered on a given trigger tool. */
export function reactionRulesFor(tool: string): ReactionRule[] {
  return engine().rulesFor(tool);
}

/** Match an event → the reaction actions that should fire (pure). */
export function matchReactions(event: ToolInvocationEvent): Array<MatchedAction<ToolInvocationEvent, string>> {
  return engine().match(event);
}

/** The reactive graph as `{ on, ruleId, fire }` edges — the "what fires what" view (D-010). */
export function reactionGraph(): Array<{ on: string; ruleId: string; fire: string }> {
  return engine().describe();
}

/**
 * Test-only: empty the registry.
 *
 * ⚠ THIS CLEARS PROCESS-GLOBAL STATE THAT OTHER TEST FILES CANNOT REBUILD. The engine is
 * pinned to the realm (`pinModuleState` above), so a clear here is visible to every file
 * sharing the vitest worker — and most rules register by IMPORT SIDE-EFFECT (`events/index.ts`
 * → `events/rules.ts` → e.g. `decision-ledger/bet-signal-rule.ts`). ESM runs a module body
 * ONCE per worker, so after this clear a later file's `await import('./its-rule')` is a cached
 * no-op that silently restores NOTHING. The victim file then asserts against a registry holding
 * only whatever registered after the clear.
 *
 * That is not hypothetical: it red-pinned `decision-ledger/bet-signal-rule.test.ts` ~6×/6h
 * (EI-20413591345557630 + 3 earlier duplicates), failing ONLY in whole-workspace CI runs and
 * never locally, because it depends on which files share a worker and in what order.
 *
 * So: if you assert that a rule "self-registers", do NOT rely on a static/dynamic import
 * having done it. Force the module body to re-run first:
 *
 *     vi.resetModules();
 *     await import('./the-rule');   // body re-runs → re-registers into this same pinned engine
 *
 * and prefer snapshotting + restoring around your clear so your file does not degrade the
 * registry for whatever runs next (see `bet-signal-rule.test.ts` for the worked pattern).
 */
export function _resetReactionsForTests(): void {
  engine().clear();
}
