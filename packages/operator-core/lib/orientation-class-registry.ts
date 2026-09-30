/**
 * THE SHARED ORIENTATION CLASS REGISTRY — sink-neutral import seam (plan item P-023).
 *
 * WHY THIS FILE IS A RE-EXPORT AND NOT THE REGISTRY'S HOME.
 *
 * P-023 makes the orientation classes a SHARED declaration that three briefs
 * select from at their own budget (D-015: turn-start, leader-brief and
 * carry-brief answer different questions with different watermark semantics, so
 * the payloads are NOT merged — only the declaration is shared).
 *
 * The declaration itself has to stay in `turn-start-orientation.ts`, because
 * every segment's `render` closure calls helpers defined in that module
 * (`encodeAnnouncedGate`, `encodeExecutableFrontier`, the line formatters, …).
 * Moving `ORIENTATION_CLASS_REGISTRY` into this file would make this module
 * import those helpers while `turn-start-orientation.ts` imports the registry
 * back for `renderOrientationLines` — a cycle. So the registry is declared
 * where its helpers live, and THIS module is the name the other two sinks
 * import it under.
 *
 * That matters for the next author: a consumer for the leader-brief or
 * carry-brief sink (P-024 / P-025) should import from HERE. `turn-start-orientation`
 * is the turn-start sink's own module, and a non-turn-start sink importing it
 * directly reads as a layering inversion even though it resolves to the same
 * binding.
 *
 * ⚠ Do not "simplify" this away by relocating the registry — the cycle above is
 * the reason it is not already here.
 */
export {
  ORIENTATION_CLASS_REGISTRY,
  selectOrientationSegments,
  type OrientationClassEntry,
  type OrientationClassSegment,
  type OrientationSink,
  type RegisteredOrientationClass,
} from './turn-start-orientation';
