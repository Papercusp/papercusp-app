/**
 * promote.ts — operator host adapter for `plans:promote` helpers.
 *
 * The pure `findUnknownFromItems` validator now lives in
 * @papercusp/coordination/core; re-exported here so `tools/promote.ts`
 * and the unit test keep their `../promote` import. `PromoteFeatureInput`
 * is the operator tool-input shape and stays here.
 *
 * (The SC-NNN allocator + SPEC.md mutator that used to live here were
 * retired by plans-central-harness-ux-2026-05-26 D-004.)
 */

export { findUnknownFromItems } from '@papercusp/coordination/core';

/**
 * One promote-input feature with the items it covers. The tool maps the
 * caller's feature list onto this shape; `findUnknownFromItems` validates
 * the `from_items` references before any side effects.
 */
export interface PromoteFeatureInput {
  title: string;
  body?: string;
  acceptance?: string[];
  from_items?: string[];
}
