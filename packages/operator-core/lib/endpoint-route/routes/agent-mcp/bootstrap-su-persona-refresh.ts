/**
 * POST /api/agent-mcp/console/bootstrap-su/persona-refresh   { coordOwnerId }
 *
 * Re-render a LIVE su session's base persona from the CURRENT prompt sources, and
 * return the path the caller should hand the successor as `--system-prompt-file`.
 *
 * WHY (stale-prompt-render-in-live-sessions-2026-08-02, P-002 / D-001).
 * `mintRecycleArgs` rebuilds a respawn's argv from the ORIGINAL argv and copies
 * every non-resume flag through verbatim — including `--system-prompt-file`. Only
 * the carry document is refreshed. So a session's BASE persona render is pinned to
 * the first launch of its chain forever: a session respawned fifty times still runs
 * render #1. Measured 2026-08-02: 27 of 53 live claude sessions were running a
 * pre-fix render, the oldest 14 days old — i.e. every prompt fix of the preceding
 * fortnight had reached only half the fleet. A respawn is already a full relaunch,
 * so re-rendering costs almost nothing and fixes every long-lived session at once.
 *
 * NARROW BY CONSTRUCTION — this is a RENDER, not a re-bootstrap. It writes exactly
 * one file and touches nothing else: no adv row, no mode registry, no standing
 * facts, no loop arming, no saved-prompt materialization, no seat consumption. Each
 * of those is a launch side effect that must fire once per session, not once per
 * respawn. The prompt assembly itself is the SAME code the launch runs
 * (`su-persona-render` + `composeModePromptSection`), never a copy — a second
 * assembly that drifted would make a "refreshed" prompt quietly differ from a fresh
 * one, which is worse than staleness because nothing would report it.
 *
 * FAIL-SOFT IS THE CONTRACT. Every failure returns 200 `{ ok: false, reason }`
 * rather than an error status, because the only correct caller behaviour is
 * identical in all of them: keep the inherited render and respawn anyway. A respawn
 * that died because the operator was briefly unreachable would lose the whole
 * session, which is strictly worse than running a stale prompt. The `reason` exists
 * so the failure is diagnosable instead of silent.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readSuLaunchSpecByOwner, recordSuLaunchSpec } from '../../../adv-sessions';
import { isSuAgent } from '../../../su-agents';
import { launchContextDir } from '../../../su-launch-context';
import {
  parseSuLaunchSpecRecord,
  rebuildSuLaunchArtifact,
  suPersonaRefreshPathFor,
} from '../../../su-persona-render';
import { CORS_HEADERS, composeModePromptSection, gatePrincipal, jsonRes } from './bootstrap-su';
import { requestSessionIdentityActivation } from '../../../agent-tools/coordination/control-anchor';

const personaRefresh = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/persona-refresh',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    let coordOwnerId: string | null = null;
    try {
      const body = (await req.json()) as { coordOwnerId?: unknown };
      if (typeof body.coordOwnerId === 'string' && body.coordOwnerId.trim().length > 0) {
        coordOwnerId = body.coordOwnerId.trim().slice(0, 200);
      }
    } catch {
      /* fall through to the 400 */
    }
    if (!coordOwnerId) return jsonRes({ ok: false, error: 'coordOwnerId required' }, 400);

    try {
      // The coord ownerId is the respawn-stable key by design: mintRecycleArgs
      // rotates only the NATIVE claude session id, leaving PAPERCUSP_SID untouched
      // (WI-1980 D-003), so it still names this session after N respawns.
      const record = parseSuLaunchSpecRecord(await readSuLaunchSpecByOwner(coordOwnerId));
      if (!record) {
        // Pre-migration-738 sessions, non-su rows, and a shape we do not recognise
        // all land here. Not an error: they keep the inherited render.
        return jsonRes({ ok: false, reason: 'no-launch-spec' });
      }
      // claude is the only backend this can help. `--system-prompt-file` is a claude
      // flag; codex carries its instructions in CODEX_HOME/AGENTS.md and omp in its
      // own launch-context env, so neither has an argv slot to swap — and neither is
      // reachable anyway, since carry-respawn itself is claude-only. Refusing here
      // keeps that truth in ONE place instead of relying on the caller to know it.
      if (record.agent !== 'claude' || !isSuAgent(record.agent)) {
        return jsonRes({ ok: false, reason: 'unsupported-agent', agent: record.agent });
      }

      const rebuilt = await rebuildSuLaunchArtifact({
        ownerId: coordOwnerId,
        operatorBaseUrl: new URL(req.url).origin,
        record,
        modeSection: composeModePromptSection({
          autoMode: record.autoMode,
          drainMode: record.drainMode,
          loopArmed: record.loopArmed,
        }),
      });
      const { artifact, promptText, spec } = rebuilt;

      // Write atomically to a path that is NOT the inherited one. The caller's
      // fallback is the file it already has, so that file must stay intact and
      // known-good — rewriting it in place would destroy the fallback at exactly the
      // moment a bad render made the fallback necessary.
      const promptFile = suPersonaRefreshPathFor(coordOwnerId);
      mkdirSync(launchContextDir(), { recursive: true });
      const tmp = `${promptFile}.tmp-${process.pid}`;
      writeFileSync(tmp, promptText, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, promptFile);

      // P-009: a carry-respawn is a new host-delivery attempt even when the
      // content hashes happen to be unchanged. Persist the current immutable
      // artifact on the existing launch receipt, then open a desired activation;
      // the successor's turn-start channel records prepared/applied acknowledgement.
      const updatedRecord = {
        ...record,
        stack: artifact.stack,
        specificationRevision: artifact.specificationRevision,
        stateRevision: artifact.stateRevision,
        specificationArtifact: artifact.specificationArtifact,
      };
      if (!(await recordSuLaunchSpec(null, coordOwnerId, updatedRecord))) {
        throw new Error('refreshed launch specification receipt was not persisted');
      }
      await requestSessionIdentityActivation({
        ownerId: coordOwnerId,
        workspaceId: record.workspaceId,
        revision: {
          specificationRevision: artifact.specificationRevision,
          stateRevision: artifact.stateRevision,
        },
        attribution: {
          actorId: coordOwnerId,
          principalId: record.principalId ?? coordOwnerId,
          sessionId: coordOwnerId,
        },
        source: 'restart',
        restart: true,
      });

      return jsonRes({
        ok: true,
        promptFile,
        bytes: Buffer.byteLength(promptText, 'utf8'),
        personaTier: spec.personaTier ?? null,
        promptSource: spec.promptFile,
        specificationRevision: artifact.specificationRevision,
        stateRevision: artifact.stateRevision,
        compositionSource: artifact.compositionSource,
      });
    } catch (err) {
      return jsonRes({
        ok: false,
        reason: 'render-failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

const optionsForPersonaRefresh = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/persona-refresh',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

export default [personaRefresh, optionsForPersonaRefresh];
