/**
 * The TIER half of the OMP native-`lsp` gate, in bare-node-importable form.
 * code-intelligence-routing-lsp-gitnexus-2026-08-20 P-023 (D-015).
 *
 * WHY THIS FILE EXISTS — it is the same argument `omp-native-lsp-gate.ts` makes
 * for itself, one layer out. That file exists so the `!isLocalModelSpec` term
 * could not drift between bootstrap-su and bootstrap-role, "quiet in the
 * dangerous direction". P-023 then had to apply the very same term in a THIRD
 * place — `resumeArgsFor` in psu-launcher.mjs — which is bare `node` and cannot
 * import TypeScript. Re-typing the rule there would have re-created precisely
 * the drift the gate file was written to prevent, so the term moved here, to a
 * `.mjs` both sides can import (the launcher already imports its sibling
 * `local-model-spec.mjs` the same way).
 *
 * THE RULE, stated so a test can falsify it:
 *
 *     only a POSITIVELY-KNOWN cloud model may keep the builtin. A local model
 *     never does, and neither does an UNKNOWN one.
 *
 * The unknown half is the load-bearing half and it FAILS CLOSED on purpose. An
 * omp launch carrying no `--model` spec does not run "no model" — it runs OMP's
 * own configured default, which on this box is a local ornith model. Reading
 * absent-model as "not local" would hand the builtin to the exact population the
 * gate exists to exclude, in the one case where nothing in the argv says so.
 *
 * ⚠ This is the TIER term ONLY — it deliberately does not read
 * FLAGS.OMP_NATIVE_LSP_BUILTIN. Callers that can reach the flag (the two
 * bootstrap routes, via `mayKeepOmpNativeLsp`) must AND it in. The resume path
 * cannot reach the flag without adding a launch-time network dependency, and so
 * applies this term alone — see `resumeArgsFor` for that trade-off, recorded
 * rather than hidden.
 */
import { isLocalModelSpec } from './local-model-spec.mjs';

/**
 * Is this model spec positively known to be a cloud model, and therefore
 * tier-eligible to keep OMP's native `lsp` builtin?
 *
 * @param {string | null | undefined} model the resolved launch/resume model spec
 * @returns {boolean} false for local AND for unknown/blank — never throws
 */
export function ompModelTierAllowsNativeLsp(model) {
  if (!model || !String(model).trim()) return false;
  if (isLocalModelSpec(model)) return false;
  return true;
}
