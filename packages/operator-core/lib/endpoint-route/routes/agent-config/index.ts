/**
 * GET / POST /api/agent-config
 *
 * GET  — saved AgentConfig + detected binary paths + the backend that
 *        would actually be used now (after env-var fallbacks).
 * POST — replace AgentConfig (full body). Mirrors into process.env so
 *        subsequent spawns pick it up immediately.
 *
 * POST is STRICT: if normalization would silently drop anything the body
 * asked to store (an invalid tier row, a dangling ceiling, an unknown
 * surface key), the request fails 422 with the reason instead of persisting
 * a gutted config. Silent normalization is how a transiently invalid edit
 * from /settings/agent used to delete stored settings — the saved config
 * looked fine until a reload re-hydrated the holes (owner bug 2026-06-11).
 * Reads stay lenient (readAgentConfig normalizes legacy rows).
 *
 * Ported from app/api/agent-config/route.ts. `auth: 'public'` preserves
 * the original (un-authed) behavior.
 */
import {
  readAgentConfig,
  writeAgentConfig,
  effectiveBackend,
  bulkResolverLaunchProfilesProblem,
  parseBackends,
  parseBulkResolverLaunchProfiles,
  parseRoleBackends,
  parseSurfaceModels,
  parseTiers,
  parseTierCeilings,
  parseTerminalEmulator,
  type AgentConfig,
} from '../../../agent-config';
import { DEFAULT_MODEL_TIERS, MODEL_EFFORT_LEVELS } from '../../../agent-config-constants';
import { classifyLoopModelSpec } from '../../../agent-loop/model-selection';
import { resolveRoleLaunch } from '../../../fleet/role-launch';
import { launchableModes } from '../../../modes/registry';
// Never the sync `detectBinaries()` here: it runs four blocking
// spawnSync('which') calls on the operator main thread per request
// (WI-10003266, measured in :3170 loop-saturation profiles).
import { detectBinariesAsync, detectBinariesCached } from '../../../agent-bin-detect';
import { defineTool } from '@papercusp/agent-mcp';
import { notifySyncInvalidate } from '../../../sync-sse';

export default [
  defineTool({
    method: 'GET',
    path: '/agent-config',
    auth: 'public',
    async handler() {
      const cfg = await readAgentConfig();
      const { latestResumableSessionForAgentCached } = await import('../../../latest-agent-session-memo');
      const { readCodexHomeDiagnostics } = await import('../../../codex-home-diagnostics');
      // The memo wraps listResumableSessions(50).find(agent === 'codex') unchanged — that
      // `.find` relies on listResumableSessions' PER-AGENT FLOOR to include codex rows at all.
      // Before that floor existed this silently reported `codexDiagnostics: null` whenever
      // claude happened to fill the window — a "no codex session exists" answer to what was
      // really "the window was full" (WI-38226). The list is activity-ordered, so the first hit
      // is the most recently ACTIVE codex session, not the most recently launched.
      // Memoized (≤30s) because that activity-scored listing measured ~410ms of this route's
      // ~800ms and was paid on EVERY config read purely for this diagnostics field (WI-2147549).
      const latestCodexSession = await latestResumableSessionForAgentCached('codex');
      return Response.json({
        config: cfg,
        // The committed default tier menu — the EFFECTIVE workspace baseline when
        // cfg.tiers is empty. Surfaced so the 👑-tab model-tier override editor
        // (queen-steering D-006) gets the baseline without a client-side
        // operator-core constant import. Additive; existing consumers ignore it.
        defaultTiers: DEFAULT_MODEL_TIERS,
        // The workspace-effective tier menu for startup-sensitive clients:
        // stored rows replace the committed baseline wholesale. Keep the
        // merge and Agent Chat capability classification on the server, but
        // return them on this already-required config read so a cold PUI does
        // not have to initialize the full agent-tool registry merely to open
        // its model picker.
        effectiveTiers: (cfg.tiers?.length ? cfg.tiers : DEFAULT_MODEL_TIERS).map((tier) => ({
          ...tier,
          loopCapability: classifyLoopModelSpec(tier.spec),
        })),
        // PUI/PSU option-source parity: clients render the launch vocabularies
        // from the same two registries the launcher validates. Never duplicate
        // these arrays in a Rust/GUI client — adding an effort or launchable
        // mode must reach every surface from one source change.
        effortLevels: MODEL_EFFORT_LEVELS,
        launchableModes: launchableModes().map(({ id, title, oneLiner }) => ({
          id,
          title,
          oneLiner,
        })),
        binaries: await detectBinariesCached(),
        codexDiagnostics: latestCodexSession
          ? {
              sessionId: latestCodexSession.id,
              ownerId: latestCodexSession.coordOwnerId,
              startedAt: latestCodexSession.startedAt,
              endedAt: latestCodexSession.endedAt,
              home: await readCodexHomeDiagnostics(latestCodexSession.id),
            }
          : null,
        effectiveBackend: effectiveBackend(cfg),
        // role-model-one-answer-2026-09-03 P-004 — WHAT EACH ROLE WILL LAUNCH AS,
        // resolved by the SAME function the launch path calls (fleet/role-launch.ts),
        // so this readout cannot drift from the real behaviour. Keyed by role.
        //
        // Rendered as the settings page's "Launches as" column. Before it, the page
        // showed the three INPUTS (backend / model / ceiling) and nothing showed
        // their RESULT — so a per-role model that the launch path silently ignored
        // looked perfectly configured (measured: nine release-fixers, 2026-09-03).
        //
        // Population is the CONFIGURED roles (the union of models / roleBackends /
        // tierCeilings keys), not every launchable role: a role with no
        // configuration resolves to its committed default, which the page can say
        // without a server round-trip. Steering is deliberately NOT applied — this
        // route is workspace-level and names no pot, so it reports the WORKSPACE
        // answer rather than guessing which session override to fold in.
        roleLaunch: Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(cfg.models ?? {}),
              ...Object.keys(cfg.roleBackends ?? {}),
              ...Object.keys(cfg.tierCeilings ?? {}),
            ]),
          ]
            .sort()
            .map((role) => {
              const r = resolveRoleLaunch(role, { cfg });
              return [
                role,
                {
                  model: r.model,
                  backend: r.backend,
                  source: r.source,
                  backendSource: r.backendSource,
                  why: r.why,
                  conflict: r.conflict,
                },
              ];
            }),
        ),
        envOverrides: {
          AGENT_BACKEND: process.env.AGENT_BACKEND ?? null,
          AGENT_CMD: process.env.AGENT_CMD ?? null,
          CLAUDE_CMD: process.env.CLAUDE_CMD ?? null,
          TERMINAL: process.env.TERMINAL ?? null,
        },
      });
    },
  }),
  defineTool({
    method: 'POST',
    path: '/agent-config',
    auth: 'loopback',
    async handler(req) {
      const body = (await req.json().catch(() => null)) as Partial<AgentConfig> | null;
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      // Older settings-page bundles know nothing about newly-added fields. Keep
      // the stored terminal preference when such a client POSTs its legacy
      // full-body shape; config:terminal-emulator is the explicit clear/set
      // surface, so an unrelated model edit cannot silently reset it.
      const current = await readAgentConfig();
      // GET projects "no preference" as terminal:'' — so a client that
      // round-trips the GET document echoes a blank back. A blank is NOT a
      // value the parser dropped (WI-10003430: every fresh hosted host 422'd
      // its own GET output), and like an absent field it must not clear a
      // preference set via config:terminal-emulator.
      const terminalBlank =
        body.terminal == null || (typeof body.terminal === 'string' && body.terminal.trim() === '');
      const next: AgentConfig = {
        backend:
          body.backend === 'claude-code' || body.backend === 'omp' || body.backend === 'codex' ? body.backend : 'auto',
        cmd: typeof body.cmd === 'string' ? body.cmd : '',
        models:
          body.models && typeof body.models === 'object' && !Array.isArray(body.models)
            ? Object.fromEntries(
                Object.entries(body.models)
                  .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && v.trim())
                  .map(([k, v]) => [k, (v as string).trim()]),
              )
            : {},
        roleBackends: parseRoleBackends(body.roleBackends),
        backends: parseBackends(body.backends),
        surfaceModels: parseSurfaceModels(body.surfaceModels),
        tiers: parseTiers(body.tiers),
        tierCeilings: parseTierCeilings(body.tierCeilings, body.tiers),
        terminal: terminalBlank ? (current.terminal ?? '') : parseTerminalEmulator(body.terminal),
        resolverProfiles:
          body.resolverProfiles === undefined
            ? current.resolverProfiles
            : parseBulkResolverLaunchProfiles(body.resolverProfiles, current.resolverProfiles),
      };
      // Strict-save guard: persisting LESS than the body asked for is silent
      // data loss, not normalization. Count the entries the parsers kept.
      const dropped: string[] = [];
      const sentCount = (v: unknown) =>
        Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0;
      if (body.models != null && sentCount(body.models) !== Object.keys(next.models).length) {
        dropped.push('models: every value must be a non-empty model id string');
      }
      if (body.roleBackends != null && sentCount(body.roleBackends) !== Object.keys(next.roleBackends ?? {}).length) {
        dropped.push('roleBackends: every value must be a concrete backend');
      }
      if (body.backends != null && sentCount(body.backends) !== Object.keys(next.backends ?? {}).length) {
        dropped.push('backends: unknown surface key or backend');
      }
      if (
        body.surfaceModels != null &&
        sentCount(body.surfaceModels) !== Object.keys(next.surfaceModels ?? {}).length
      ) {
        dropped.push('surfaceModels: unknown surface key or empty model id');
      }
      if (body.tiers != null && sentCount(body.tiers) !== (next.tiers ?? []).length) {
        dropped.push('tiers: a row is invalid (needs a unique name and a <modelId>[:<effort>] spec)');
      }
      if (body.tierCeilings != null && sentCount(body.tierCeilings) !== Object.keys(next.tierCeilings ?? {}).length) {
        dropped.push('tierCeilings: a ceiling names a tier absent from the menu');
      }
      if (!terminalBlank && !next.terminal) {
        dropped.push('terminal: must be a binary name, not a path or shell command');
      }
      if (body.resolverProfiles !== undefined) {
        const problem = bulkResolverLaunchProfilesProblem(body.resolverProfiles, current.resolverProfiles);
        if (problem) dropped.push(`resolverProfiles: ${problem}`);
      }
      if (dropped.length > 0) {
        return Response.json(
          { error: `config rejected — would silently drop: ${dropped.join('; ')}`, dropped },
          { status: 422 },
        );
      }
      await writeAgentConfig(next);
      void notifySyncInvalidate('agentConfig.modelTiersBaseline', {}).catch(() => {});
      return Response.json({
        config: next,
        binaries: await detectBinariesAsync(),
        effectiveBackend: effectiveBackend(next),
      });
    },
  }),
  // P-005: pane-level resolver controls update ONE profile without replacing
  // the rest of operator_agent_config. POST intentionally remains the legacy
  // full-document save used by /settings/agent; teaching a small command-strip
  // control to round-trip that whole document would let a stale browser tab
  // overwrite unrelated model/routing edits. PATCH reuses the same document,
  // parser, validator and writer while merging only resolverProfiles.
  defineTool({
    method: 'PATCH',
    path: '/agent-config',
    auth: 'loopback',
    async handler(req) {
      const body = (await req.json().catch(() => null)) as Partial<AgentConfig> | null;
      if (!body || typeof body !== 'object' || body.resolverProfiles === undefined) {
        return Response.json(
          { error: 'resolverProfiles is required for a partial agent-config update' },
          { status: 400 },
        );
      }
      const extra = Object.keys(body).filter((key) => key !== 'resolverProfiles');
      if (extra.length > 0) {
        return Response.json(
          { error: `partial agent-config update accepts only resolverProfiles (got ${extra.join(', ')})` },
          { status: 400 },
        );
      }

      const current = await readAgentConfig();
      const problem = bulkResolverLaunchProfilesProblem(body.resolverProfiles, current.resolverProfiles);
      if (problem) {
        return Response.json({ error: `config rejected — resolverProfiles: ${problem}` }, { status: 422 });
      }
      const next: AgentConfig = {
        ...current,
        resolverProfiles: parseBulkResolverLaunchProfiles(body.resolverProfiles, current.resolverProfiles),
      };
      await writeAgentConfig(next);
      return Response.json({ config: next });
    },
  }),
];
