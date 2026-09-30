/**
 * GET /api/operator/hive-steering — the HTTP bridge for the oddsmith engine's
 * `pot:get-steering` (DOWN) leg (oddsmith P-020).
 *
 * The oddsmith trading engine reads owner/hive policy DOWN once per tick to learn
 * the kill-switch + its trading knobs (capital ceiling / watchlist / strategy
 * enable). It GETs here; this route returns {@link getOwnerSteering} — the SAME
 * internal accessor `pot:get-steering` uses — as the raw JSON the engine consumes.
 *
 * CONTRACT (mirrors the oddsmith bridge — `operator-bridge-wiring.ts` `getSteering`
 * + `engine/src/loop.ts` `RawHiveSteering` / `defaultMapSteering`): the engine reads
 * the response body's TOP-LEVEL fields
 *   { directive: string | null; pauseNewWork: boolean; pausedUntil: number | null; … }
 * — `pauseNewWork` / an unexpired `pausedUntil` map to the engine kill-switch, and
 * the trading knobs ride a fenced ```oddsmith-steering``` block the owner embeds in
 * the free-text `directive`. {@link OwnerSteering} carries exactly these fields at
 * the top level (extra native fields are ignored by the engine), so we return it
 * verbatim — NOT wrapped in an `{ ok, steering }` envelope.
 *
 * Hive + workspace resolve from defaults (the loopback sidecar carries no principal):
 * optional `?hive=` / `?workspace=` query overrides, else `activeWorkspaceId()` +
 * `resolvePotHomeSlug()` (PAPERCUSP_POT_HOME_SLUG).
 *
 * ADDITIVE + INERT: nothing GETs here until the oddsmith bridge is armed (its
 * `ODDSMITH_OPERATOR_URL` env is set in a later step), so mounting this route does
 * not change any running behaviour. DEFENSIVE: on ANY error (no home hive, DB fault,
 * …) it returns the SAFE no-steering default ({@link DEFAULT_OWNER_STEERING}) with a
 * 200 — the engine maps that to kill-switch off + no knob overrides and keeps its
 * built-in defaults (paper, capital ceiling 0). It never throws a 5xx into a tick.
 *
 * `auth: 'loopback'` — the engine sidecar is a local process; the host's dispatch
 * chokepoint rejects any non-loopback caller. No principal is required.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOwnerSteering, DEFAULT_OWNER_STEERING } from '../../../owner-steering';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolvePotHomeSlug } from '../../../pot/wake';

export default defineTool({
  method: 'GET',
  path: '/operator/hive-steering',
  auth: 'loopback',
  // Polled once per trading tick — no audit signal per poll. Don't record it.
  sampleRate: 0,
  async handler(req) {
    try {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get('workspace')?.trim() || activeWorkspaceId();
      const potHomeSlug = resolvePotHomeSlug(url.searchParams.get('hive'));
      if (!potHomeSlug) {
        // No home hive ⇒ no steering to read. Safe default ⇒ engine keeps its defaults.
        return Response.json(DEFAULT_OWNER_STEERING);
      }
      const steering = await getOwnerSteering(workspaceId, potHomeSlug);
      return Response.json(steering);
    } catch {
      // Fail SAFE — any fault yields the no-steering default (kill-switch off, no knob
      // overrides) so the engine falls back to its built-in defaults. Never throws.
      return Response.json(DEFAULT_OWNER_STEERING);
    }
  },
});
