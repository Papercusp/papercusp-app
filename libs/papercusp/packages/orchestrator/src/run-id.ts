/**
 * Run ID generation. Bash equivalent:
 *
 *   run_id="$(date +%s)-${role}${feature_tag}"
 *
 * Where feature_tag is "-<id>" if a valid FEATURE_ID was passed, otherwise empty.
 *
 * The id shape is `<PREFIX>-<BODY>`: an uppercase-letter prefix declared by the
 * blueprint's `workItem.idPrefix` (coding `F`, research `R`, migration `M`,
 * audit `AUD`, …) OR the unified kind-independent `WI-NNN` scheme (D-008,
 * `unify-work-items`). The old `^F-…` form only matched coding ids, so a
 * research/`WI-` work-item reached the invoke layer with featureId=null — the
 * role then couldn't bind to its task and produced no durable output (EI-35).
 * The body stays uppercase/digit/hyphen so a stray lowercase value is still
 * rejected as junk.
 */

const FEATURE_ID_RE = /^[A-Z][A-Z0-9]*-[A-Z0-9-]+$/;

/** Extract the feature ID from extra-context args, if present and valid. */
export function extractFeatureId(extras: readonly string[]): string | null {
  for (const e of extras) {
    if (e.startsWith('FEATURE_ID=')) {
      const fid = e.slice('FEATURE_ID='.length);
      if (FEATURE_ID_RE.test(fid)) return fid;
    }
  }
  return null;
}

/** Build the run_id string. */
export function makeRunId(role: string, featureId: string | null, nowSeconds: number = Math.floor(Date.now() / 1000)): string {
  const tag = featureId ? `-${featureId}` : '';
  return `${nowSeconds}-${role}${tag}`;
}
