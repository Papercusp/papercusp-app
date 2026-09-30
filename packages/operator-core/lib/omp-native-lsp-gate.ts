/**
 * The ONE decision: may an OMP session keep its native `lsp` builtin?
 * code-intelligence-routing-lsp-gitnexus-2026-08-20 P-021 (D-013).
 *
 * Both bootstrap routes (bootstrap-su.ts, bootstrap-role.ts) resolve this and
 * thread the answer to psu-launcher.mjs via `envelopeEnv.PAPERCUSP_OMP_NATIVE_LSP`
 * — the reason the bare-node launcher needs no flag read (and therefore no
 * launch-time network dependency) of its own.
 *
 * WHY THIS IS A FILE AND NOT A THREE-TERM BOOLEAN INLINE IN EACH ROUTE: the
 * `!isLocalModelSpec` term is a SAFETY GATE, and the two routes drifting would
 * be quiet in the dangerous direction. Having one function means the invariant
 * below gets ONE unit test that actually pins it, instead of two integration
 * tests that each pin half of it.
 *
 * THE INVARIANT, stated so a test can falsify it:
 *
 *     only a POSITIVELY-KNOWN cloud model keeps the builtin — whatever the flag
 *     says. A local model never does, and neither does an UNKNOWN one.
 *
 * The unknown half is not paranoia: an omp launch that carries no `--model`
 * spec does not run "no model", it runs OMP'S OWN CONFIGURED DEFAULT — which on
 * this box is a local ornith model. Reading absent-model as "not local" would
 * therefore hand the builtin to the exact population the gate exists to
 * exclude, in the one case where nothing in the argv says so.
 *
 * That is what makes FLAGS.OMP_NATIVE_LSP_BUILTIN safe to ship DEFAULT-ON. The
 * documented tool-attractor incidents are all weak LOCAL models: session 9885
 * abused `lsp` as a tools:call wrapper, and the sibling attractor `eval`
 * doom-looped ornith 56-80× (sessions 10234/10239) until it was disabled at the
 * omp-config layer, because message-based fixes could not break the reflex.
 * Encoding that exclusion in CODE rather than in a flag DEFAULT means flipping
 * the flag can never hand the builtin to the model class the gate protects — so
 * this ships as a live feature rather than as a dark flag nobody flips.
 *
 * ⚠ NOT the same switch as FLAGS.CODE_INTEL_LSP. That governs Papercusp's own
 * read-only `lsp.*` facade; this governs OMP's in-process builtin. Collapsing
 * them would mean enabling our facade silently re-arms the attractor above on
 * every OMP launch — precisely the hazard D-013 records.
 */
import { ompModelTierAllowsNativeLsp } from './omp-native-lsp-tier.mjs';

/**
 * @param agent      the launch backend ('omp' | 'claude' | 'codex' | …). The
 *                   builtin only exists on omp, so anything else is false.
 * @param model      the resolved launch model spec. null/blank means UNKNOWN,
 *                   which fails CLOSED (omp's own default model is local here).
 * @param flagEnabled the resolved value of FLAGS.OMP_NATIVE_LSP_BUILTIN.
 */
export function mayKeepOmpNativeLsp({
  agent,
  model,
  flagEnabled,
}: {
  agent: string | null | undefined;
  model: string | null | undefined;
  flagEnabled: boolean;
}): boolean {
  if (agent !== 'omp') return false;
  // ORDER IS DELIBERATE: the tier gate is evaluated as its own term rather than
  // folded into the flag read, so that no future edit to the flag half can
  // accidentally short-circuit past it.
  //
  // The term itself now lives in omp-native-lsp-tier.mjs (P-023/D-015) because
  // the RESUME path needs the identical rule and is bare `node` that cannot
  // import TypeScript. It fails closed on an unknown/blank model: absent a
  // spec, omp launches on its own configured default, which is local here.
  // "We were not told" is not evidence that the model is safe.
  if (!ompModelTierAllowsNativeLsp(model)) return false;
  return flagEnabled === true;
}
