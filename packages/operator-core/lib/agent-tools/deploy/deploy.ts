/**
 * deploy:* — deploy / inspect / tear down a harness's execution plane on a cloud
 * frame (`cloud-deployment-layer-2026-06-06` P-012). Thin MCP surface over the
 * `lib/deployment/deploy.ts` orchestration (provision → install → join → DESTROY).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';

const ok = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...payload }) }],
});
const fail = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, ...payload }) }],
});

const slugArg = z.string().min(1).describe('Harness slug');
const wsArg = z.string().min(1).optional().describe('Workspace id (defaults to the active workspace)');

export default defineTool({
  name: 'deploy:harness',
  description:
    "Deploy a harness's execution plane to its configured cloud frame: provision the machine, bootstrap the runtime (own loop + own embedded-pg), join it as a federated peer. The harness must have been created with a non-local `deployment` (e.g. {target:'latitude'}). Set `deployment.desktop` (true | {displays,geometry}) for a GUI-capable frame: one Xvfb display per agent slot, agents get a leased DISPLAY. Returns {ok, frame}.",
  guidance: {
    when: 'Moving a cloud-configured harness onto a real frame so its agents run remotely (distinct IP, own Claude sub) while state federates to the local view.',
    notWhen: 'A local harness (no cloud deployment). Tearing one down — deploy:teardown. Checking status — deploy:status.',
    chaining: 'harness:create { …, deployment:{target:"latitude", desktop:true, …} } → deploy:harness { slug } → deploy:status / deploy:teardown.',
    seeAlso: [
      'deploy:status (check where the harness runs after deploying)',
      'deploy:teardown (tear down the deployed harness)',
      'deploy:pot (deploy a hive to a Swarm instead)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ slug: slugArg, workspace: wsArg }),
  async handler(args) {
    const { deployHarness, defaultDeployDeps } = await import('../../deployment/deploy');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const { frame } = await deployHarness(args.slug, ws, defaultDeployDeps((lvl, m) => console.log(`[${lvl}] ${m}`)));
      return ok({ slug: args.slug, frame });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const deployTeardownTool = defineTool({
  name: 'deploy:teardown',
  description:
    "Tear down a harness's cloud frame — DESTROY (not stop) to end billing. No-op if nothing is deployed. Returns {ok, destroyed}.",
  guidance: {
    when: 'Done with a cloud harness (or to stop its billing). Teardown destroys the machine so it stops costing money.',
    notWhen: 'Pausing temporarily — there is no stop; destroy + redeploy is the model (frames are cattle).',
    seeAlso: [
      'deploy:status (confirm what is deployed before tearing down)',
      'deploy:harness (re-deploy)',
      'deploy:teardown_pot (tear down a deployed HIVE, not a harness)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ slug: slugArg, workspace: wsArg }),
  async handler(args) {
    const { teardownHarness, defaultDeployDeps } = await import('../../deployment/deploy');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const r = await teardownHarness(args.slug, ws, defaultDeployDeps((lvl, m) => console.log(`[${lvl}] ${m}`)));
      return ok({ slug: args.slug, destroyed: r.destroyed });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const migrateConfigJsonTool = defineTool({
  name: 'harness:migrate-config-json',
  description:
    "One-time backfill (deprecate-harness-config-json-2026-06-06): lift every harness's legacy `.papercusp/config.json` INSTANCE content (phase/phases/dept + per-instance knob overrides) into the workspace-PG registry, so the file is no longer read as a config source. Idempotent — already-migrated / file-less harnesses are skipped; scaffold contract artifacts (harness_token/parent_slug/slug) are left in the file. Returns {ok, scanned, migratedCount, results:[{slug,fields}]}.",
  guidance: {
    when: 'Once per workspace after the config.json→PG cutover, to lift any pre-existing harness config.json instance content into the registry. Safe to re-run (idempotent).',
    notWhen: 'Routine operation — this is a one-time backfill. New harnesses persist instance config to PG directly; nothing reads config.json on the live path.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ workspace: wsArg }),
  async handler(args) {
    const { migrateAllConfigJson } = await import('../../deployment/instance-config');
    const ws = args.workspace ?? activeWorkspaceId();
    try {
      const results = await migrateAllConfigJson(ws);
      const migrated = results.filter((r) => r.migrated);
      return ok({ workspace: ws, scanned: results.length, migratedCount: migrated.length, results: migrated });
    } catch (e) {
      return fail({ error: (e instanceof Error ? e.message : String(e)).slice(0, 400) });
    }
  },
});

export const deployStatusTool = defineTool({
  name: 'deploy:status',
  description:
    "Report a harness's deployment: its `deployment` config + the live frame handle (id/host/region) if deployed. Returns {ok, deployment, frame|null}.",
  guidance: {
    when: 'Checking where a harness runs (local vs which cloud frame) and the frame\'s reachable host.',
    seeAlso: [
      'deploy:harness (deploy a harness to a frame)',
      'deploy:pot (deploy a hive to a Swarm)',
      'deploy:teardown (tear down a deployment)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({ slug: slugArg, workspace: wsArg }),
  async handler(args) {
    const { loadHarnessRegistry } = await import('../../harness-registry');
    const ws = args.workspace ?? activeWorkspaceId();
    const reg = await loadHarnessRegistry(ws);
    const p = reg.projects.find((x) => x.slug === args.slug);
    if (!p) return fail({ error: `unknown harness '${args.slug}'` });
    return ok({
      slug: args.slug,
      deployment: p.deployment ?? { target: 'local' },
      frame: p.deploymentFrame ?? null,
    });
  },
});
