/**
 * Shared dogfood-bootstrap progress detail strings. Extracted from
 * bootstrap-papercusp-hive.ts so both the clone path AND the join path
 * (papercusp-hive-join.ts) can use them without an import cycle.
 */

/** Recorded on the `clone` step (kept at 0% `running`, NOT `error`) when the
 *  clone/join can't start yet because GitHub isn't signed in — the banner stays
 *  visible at 0% and prompts the user instead of flashing a failure. The wizard's
 *  GitHub step re-triggers the bootstrap once signed in. The UI matches on this. */
export const AWAITING_GH_SIGNIN_DETAIL = 'Sign in to GitHub to begin the download';
