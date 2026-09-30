/**
 * Palette-execution safety filter (P-011) — §3 of the plan.
 *
 * The review's load-bearing catch: "principal-allowed + simple-arg" is NOT
 * "safe to fire one keystroke away with only a toast." The server catalog
 * holds destructive (`backup:promote`, `processes:kill`, deletes), streaming,
 * and interactive (`ask_choice`) tools. This decides HOW — or whether — a
 * capability may run from the command palette.
 *
 * NOTE: this is the projection-time gate (so an ineligible tool never appears,
 * or appears confirm-gated). The dispatch stack re-checks authorization at
 * execution (defense in depth) — this filter is about palette *safety*, not
 * authority.
 */
import type { Capability } from './types';

export type PaletteEligibility =
  | 'fire-and-toast' // run immediately, surface the result in a toast
  | 'confirm' // show, but require an explicit confirm step before running
  | 'exclude'; // never offered in the palette (Phase 1)

export interface PaletteEligibilityOpts {
  /**
   * The caller SUPPLIED the arguments (a sidebar pane / button invoking one
   * specific tool with a fixed payload), so the `requiresArgs` exclusion does
   * not apply to it.
   *
   * WHY this exists: `requiresArgs` was never a safety property — it encodes
   * "the palette cannot PROMPT the user for args" (see the `requiresArgs` doc
   * comment on CapabilityCore: *excluded ... until the palette grows an arg
   * prompt*). But `/api/agent-mcp/run-tool` is shared by every operator UI
   * surface, not just the keystroke palette, and those callers hard-code their
   * arguments. Applying the prompt limitation to them refused calls that had
   * nothing to prompt for: it made EVERY pause/resume control in the Blender,
   * Docs and Agents panes fail with `not_palette_eligible`, because
   * `routines:set` takes a required `name`. That surface exists so the owner
   * can stop cron agents spending his token budget, and it could never stop
   * one (owner report 2026-07-25).
   *
   * Streaming / interactive stay excluded regardless: those are limits of the
   * dispatch+toast SHIM (it cannot host incremental state or a mid-run
   * prompt), not of the arg prompt — supplying args does not make them
   * hostable. Every real authority check (role gate, `authorize` PDP, the
   * destructive/high-risk confirm below, audit) is untouched by this flag.
   */
  argsSupplied?: boolean;
}

export function paletteEligibility(
  cap: Capability,
  opts: PaletteEligibilityOpts = {},
): PaletteEligibility {
  // Browser-reflexive commands run their own in-tab handler (which owns its
  // side effects). Phase 1 surfaces only those explicitly annotated for the
  // palette — i.e. today's existing `paletteEntry` commands.
  if (cap.runsIn === 'browser' || cap.runsIn === 'hybrid') {
    return cap.surfaces?.palette ? 'fire-and-toast' : 'exclude';
  }

  // Server capabilities, executed via the dispatch + toast shim.
  // The shim cannot host streaming (publishState) or interactive (askUser)
  // tools — those are excluded however they are called.
  if (cap.streaming || cap.interactive) return 'exclude';
  // Required args are excluded only when the caller did NOT supply any: the
  // palette has no way to ask for them. A caller that passes them is fine.
  if (cap.requiresArgs && !opts.argsSupplied) return 'exclude';

  // Destructive / high-risk: show, but gate behind a confirm step. Never
  // fire-and-toast a one-keystroke irreversible action.
  if (cap.destructive || cap.tier === 'high') return 'confirm';

  return 'fire-and-toast';
}

/** Whether a capability is offered in the palette at all (confirm-gated counts as visible). */
export function isPaletteVisible(cap: Capability): boolean {
  return paletteEligibility(cap) !== 'exclude';
}

/** Whether running this capability from the palette must first prompt for confirmation. */
export function requiresPaletteConfirm(cap: Capability): boolean {
  return paletteEligibility(cap) === 'confirm';
}
