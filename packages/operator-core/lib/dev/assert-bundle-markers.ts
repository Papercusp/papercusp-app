/**
 * assertBundleContainsMarkers — refuse to run a pre-built bundle whose contents
 * don't carry the instrumentation a diagnostic depends on (EI-18683847182779973).
 *
 * THE DEFECT THIS GUARDS: an investigation rig runs a large pre-built serve
 * bundle (esbuild inlines every dependency into one file). When a diagnostic
 * patch is applied to `node_modules` AFTER the bundle was built, the rig
 * silently executes WITHOUT the instrumentation — and the absent field does
 * not fail loudly. It reads `undefined`, which every ordinary render
 * (`?? false`, a falsy check, JSON of an absent key) converts into a
 * plausible-looking, LEGITIMATE value. Worse: the value it fabricates is
 * systematically the FALSY one, which in a diagnostic context is usually the
 * "nothing unusual happened" reading — so a stale bundle doesn't lose data,
 * it manufactures a clean-looking CONFIRMATION of whatever hypothesis
 * predicted that falsy value.
 *
 * Verifying against SOURCE (`node_modules`, the patch file, the repo) cannot
 * catch this — that is exactly where the check passes even though the run is
 * broken, because the build step and the patch step are each independently
 * correct; nothing checks their ORDER, and nothing checks the produced
 * binary. The fix is to assert on the ARTIFACT actually being executed.
 *
 * USAGE: call this immediately before spawning/executing a bundle whose
 * output you plan to use as evidence for a diagnostic conclusion — pass every
 * field/symbol name the experiment reads that only exists because of a patch
 * (e.g. `['udxRelayed', 'udxServerAddress']` for a hyperdht relay-instrumentation
 * patch). Cheap — one file read + substring scan — and it fails LOUD at
 * launch instead of silently fabricating an answer after a full run.
 *
 * This intentionally does NOT attempt provenance/hash comparison against
 * `patches/` (a bundle could rebuild without ever touching that directory's
 * mtime, e.g. a fresh `npm install`) — a marker-presence check is simpler,
 * cannot false-negative on a build-system detail, and directly answers the
 * one question that matters: "does the artifact I am about to trust actually
 * contain what I think it contains?"
 */
import { readFileSync } from 'node:fs';

export interface BundleMarkerCheck {
  /** Absolute or cwd-relative path to the bundle file to inspect. */
  bundlePath: string;
  /** Every string that MUST appear verbatim in the bundle for its instrumentation
   *  to be present (a symbol name, a distinctive literal the patch introduces, …). */
  requiredMarkers: readonly string[];
}

export interface BundleMarkerResult {
  ok: boolean;
  /** Markers from `requiredMarkers` that were NOT found in the bundle. Empty when ok. */
  missing: string[];
}

/**
 * Pure check — no throw, no I/O beyond the one read. Prefer
 * `assertBundleContainsMarkers` at a call site; this is exported separately so
 * a caller that wants to WARN instead of hard-fail (or test the logic without
 * exercising the throwing wrapper) can do so.
 */
export function checkBundleContainsMarkers({
  bundlePath,
  requiredMarkers,
}: BundleMarkerCheck): BundleMarkerResult {
  const contents = readFileSync(bundlePath, 'utf8');
  const missing = requiredMarkers.filter((marker) => !contents.includes(marker));
  return { ok: missing.length === 0, missing };
}

/**
 * Throws a loud, specific error if `bundlePath` is missing any of
 * `requiredMarkers` — call this before trusting a pre-built bundle's output
 * for a diagnostic conclusion. See the module doc-comment above for the full
 * defect this closes (EI-18683847182779973).
 */
export function assertBundleContainsMarkers(check: BundleMarkerCheck): void {
  const { ok, missing } = checkBundleContainsMarkers(check);
  if (ok) return;
  throw new Error(
    `assertBundleContainsMarkers: ${check.bundlePath} is missing required instrumentation ` +
      `marker(s): ${missing.join(', ')}. This bundle was very likely built BEFORE a diagnostic ` +
      `patch (e.g. under patches/) was applied to node_modules — the absent field will read as ` +
      `\`undefined\`, collapse to a plausible-looking falsy value, and silently fabricate a clean ` +
      `confirmation of whatever hypothesis predicted that value. Rebuild the bundle AFTER the ` +
      `patch is applied, then re-run this check. (EI-18683847182779973)`,
  );
}
