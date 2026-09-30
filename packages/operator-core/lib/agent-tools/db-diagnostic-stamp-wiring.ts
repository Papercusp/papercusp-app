/**
 * Wire `@papercusp/db-org`'s build-stamp seam to Papercusp's own build info
 * (EI-19484133375867605 — a corrected `[connect-phase-deadline]` was re-filed as a
 * live defect four times, the last 8h after the fix deployed, because the hosts
 * emitting it had booted before the deploy and never reload their code).
 *
 * The db package owns the SEAM (where the stamp hangs, and how it fails safe); this
 * host owns the POLICY (what its build id actually is) — the same split as
 * `server-vintage-wiring.ts`, registered as a startup side effect from
 * `agent-tools/index.ts`.
 *
 * `getBuildInfo()` is deliberately the ONE source for both ports. It is already
 * resolved-once-and-cached (the /api/health contract), so this does no I/O on the
 * failure path, and — the part that matters here — it reports `sha: null` for a
 * bundled artifact with no baked sha rather than claiming the checkout's HEAD. A
 * stamp is only worth having if it cannot lie about which build is talking, so
 * "unknown" must stay expressible: null renders the tag exactly as it read before.
 */

import { setBuildStampResolver } from '@papercusp/db-org';
import { getBuildInfo } from '../build-info';

setBuildStampResolver(() => getBuildInfo().sha);
