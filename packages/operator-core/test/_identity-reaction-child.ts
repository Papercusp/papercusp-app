/**
 * Process driver for the real identity-reaction DBOS integration test
 * (portable-identity-packages-2026-09-26 P-018, Phase E).
 *
 * Every lookup and write is the production one against the throwaway database:
 * the emit (`emitAwaitedEvent`) reaches the worn muted subscriptions through the
 * key latch, enqueues through the request-side `DBOSClient` (this process never
 * boots bootstrap.ts, so `dbosStarted()` is false), and the executor launched
 * here dequeues onto `identityReaction`, which authorizes from live state and
 * dispatches the bound tool through the real projected dispatcher as the wearer.
 *
 *   setup     — class, pot, registry, catalogued keys, wearers (run once).
 *   scenarios — the non-crash scenarios; prints `IRX_REPORT <json>`.
 *   crash     — both crash wearers reach the tool, then this process SIGKILLs.
 *   recover   — a fresh executor recovers the PENDING workflows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { pinPackageInput, resolveBlueprint } from '@papercusp/orchestrator/blueprint';
import { registerProjectedTool, type ProjectedTool } from '@papercusp/agent-mcp';

const mode = process.env.IRX_MODE;
const dsn = process.env.IRX_DSN;
// `?? ''` keeps these `string` inside the hoisted helpers below; the guard still rejects empty values.
const workspaceId = process.env.IRX_WORKSPACE ?? '';
const potDir = process.env.IRX_POT_DIR ?? '';
const appVersion = process.env.DBOS__APPVERSION;
if (!mode || !['setup', 'scenarios', 'crash', 'recover'].includes(mode) || !dsn || !workspaceId || !potDir || !appVersion) {
  throw new Error('identity-reaction fixture configuration is incomplete');
}

export const HARNESS = 'irx-pot';
export const CLASS_REF = 'irx.tasks@1.0.0';
const CAP = 'irx:tasks-create';
const GUARDED_CAP = 'irx:guarded';

const sql = postgres(dsn, { max: 4, onnotice: () => {} });
const log = (msg: string) => process.stderr.write(`[irx-child:${mode}] ${msg}\n`);

/* ------------------------------------------------------------------ */
/* The bound test tools: each effect is one committed row.             */
/* ------------------------------------------------------------------ */

async function effect(tool: string, owner: string | null, title: unknown) {
  await sql`INSERT INTO public.irx_effects (tool, owner_id, title) VALUES (${tool}, ${owner}, ${String(title ?? '')})`;
}

function testTool(name: string, capabilities: string[], extra: Partial<ProjectedTool> = {}): ProjectedTool {
  return {
    pluginName: 'irx-test',
    description: `identity-reaction test tool ${name}`,
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    capabilities,
    effect: 'write',
    expose: { mcp: { name } },
    fn: async (input, ctx) => {
      const owner = ctx.principal?.slug ?? null;
      const title = (input as { title?: unknown } | null)?.title;
      if (title === 'crash') {
        await sql`INSERT INTO public.irx_entered (owner_id) VALUES (${owner})`;
        if (mode === 'crash') {
          // Hold until BOTH crash wearers are authorized and inside the dispatch,
          // then die before either effect commits.
          const until = Date.now() + 60_000;
          while (Date.now() < until) {
            const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM public.irx_entered`;
            if (n >= 2) process.kill(process.pid, 'SIGKILL');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error('crash wearers never both reached the dispatch');
        }
      }
      await effect(name, owner, title);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    ...extra,
  };
}

registerProjectedTool(testTool('irx:create', [CAP]));
registerProjectedTool(testTool('irx:guarded-tool', [GUARDED_CAP]));
registerProjectedTool(testTool('irx:limited', [CAP], { rolesQuota: { su: { perRun: 1 } } }));
registerProjectedTool(testTool('irx:admin-only', [CAP], { agentRoles: ['worker'] }));
registerProjectedTool(testTool('irx:bare', [CAP]));

/* ------------------------------------------------------------------ */
/* DBOS: this process's executor on the throwaway system database.     */
/* ------------------------------------------------------------------ */

DBOS.setConfig({
  name: 'identity-reaction-it', systemDatabaseUrl: dsn,
  systemDatabaseSchemaName: 'dbos', applicationVersion: appVersion,
  runAdminServer: false,
});
// Registers the workflow and its queue before launch, as bootstrap.ts does.
await import('../lib/dbos/identity-reaction-workflow');
const { emitAwaitedEvent } = await import('../lib/events/await/engine');

/* ------------------------------------------------------------------ */
/* Fixture helpers.                                                     */
/* ------------------------------------------------------------------ */

const asyncRule = (id: string, on: string, verb: string, title = id) => pinPackageInput({
  packageKind: 'rule', ref: id, revision: '1.0.0', files: [{ path: 'rule.json', bytes: id }],
  value: { id, title: id, description: `${id} rule`, version: '1.0.0', delivery: 'async', on,
    fire: `class:${CLASS_REF}#${verb}`, args: { title } },
});

const RULES = {
  'file-task': asyncRule('file-task', 'irx.basic', 'create'),
  'guarded-task': asyncRule('guarded-task', 'irx.guarded', 'guarded'),
  'limited-task': asyncRule('limited-task', 'irx.quota', 'limited'),
  'admin-task': asyncRule('admin-task', 'irx.role', 'admin'),
  'bare-task': asyncRule('bare-task', 'irx.bare', 'bare'),
  'crash-task': asyncRule('crash-task', 'irx.crash', 'create', 'crash'),
};
type RuleRef = keyof typeof RULES;

async function compile(id: string, refs: RuleRef[]) {
  const { compileBlueprintWithPackages } = await import('../lib/blueprint/compile-packages');
  const source = resolveBlueprint({ id, bundles: refs.map((ref) => ({ kind: 'rule', ref })),
    workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } });
  return compileBlueprintWithPackages(source, { workspaceId, harnessSlug: HARNESS,
    resolvePackage: async ({ ref }) => RULES[ref as RuleRef] ?? null });
}

type Artifact = Awaited<ReturnType<typeof compile>>;

/** `ownerId` wears `artifact`: launch record, applied control anchor, subscriptions. */
async function wear(ownerId: string, artifact: Artifact) {
  const { replaceIdentityRuleSubscriptions } = await import('../lib/agent-identities/identity-rule-subscriptions');
  const revision = { specificationRevision: artifact.specificationRevision, stateRevision: `state-${ownerId}` };
  const [{ id }] = await sql<{ id: number }[]>`
    SELECT COALESCE(max(id), 97000) + 1 AS id FROM harness_shared.adv_sessions WHERE id > 97000`;
  await sql`INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode, coord_owner_id, session_id, started_at, launch_spec)
    VALUES (${id}, ${workspaceId}, 'console', ${ownerId}, ${`native-${ownerId}-${id}`}, now(),
      ${JSON.stringify({ ...revision, specificationArtifact: artifact })}::text::jsonb)`;
  await sql`
    INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_generation, control_state)
    VALUES (${ownerId}, ${workspaceId}, 1, ${sql.json({ activation: { applied: revision }, scope: { harness: HARNESS } })})
    ON CONFLICT (owner_id) DO UPDATE SET control_state = EXCLUDED.control_state,
      control_generation = harness_shared.session_briefs.control_generation + 1`;
  await sql.begin((tx) => replaceIdentityRuleSubscriptions(tx, { ownerId, workspaceId, artifact }));
}

/** Detach: the control anchor no longer carries an applied activation. */
async function detach(ownerId: string) {
  await sql`UPDATE harness_shared.session_briefs
     SET control_state = ${sql.json({ scope: { harness: HARNESS } })},
         control_generation = control_generation + 1
   WHERE owner_id = ${ownerId}`;
}

function writePotBlueprint(suCapabilities: string[]) {
  mkdirSync(join(potDir, '.papercusp'), { recursive: true });
  writeFileSync(join(potDir, '.papercusp', 'blueprint.yaml'), [
    `id: ${HARNESS}`,
    // A standalone (non-extending) pot must carry the sections resolveBlueprint requires.
    'workItem:',
    '  kind: feature',
    'spine:',
    '  edges:',
    '    DONE:',
    '      to: done',
    'fleet:',
    '  workerRoles:',
    '    - id: su',
    `      capabilities: [${suCapabilities.map((cap) => JSON.stringify(cap)).join(', ')}]`,
    '',
  ].join('\n'));
}

async function receipts(eventKey: string) {
  // The receipt id is `identity-reaction:<fire>:<owner>:<tag>:<pin>`; the parent reads the owner from it.
  return sql<{ dedup_id: string; rule_id: string; status: string; error_message: string | null; fire: string; contributor: string | null }[]>`
    SELECT dedup_id, rule_id, status, error_message, fire, contributor
      FROM harness_shared.event_reactions
     WHERE workspace_id = ${workspaceId} AND trigger_tool = ${`event:${eventKey}`}
     ORDER BY dedup_id`;
}

/** Wait until `count` receipts for `eventKey` are terminal. */
async function settled(eventKey: string, count: number, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.event_reactions
       WHERE workspace_id = ${workspaceId} AND trigger_tool = ${`event:${eventKey}`} AND status <> 'authorizing'`;
    if (n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`receipts for ${eventKey} did not settle (${count} expected)`);
}

/** No receipt exists before the step runs; the workflow id is the receipt id `identity-reaction:<key>@<fire>:…`. */
async function workflowStatuses(eventKey: string) {
  return sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM dbos.workflow_status
     WHERE name = 'identityReaction' AND workflow_uuid LIKE ${`identity-reaction:${eventKey}@%`}
     GROUP BY status ORDER BY status`;
}

const emit = (key: string) => emitAwaitedEvent({ key, workspaceId, payload: { key }, source: 'irx-test' });

/* ------------------------------------------------------------------ */
/* Modes.                                                               */
/* ------------------------------------------------------------------ */

if (mode === 'setup') {
  const registry = await import('../lib/capability-class-registry-store');
  const { writeOperatorState } = await import('../lib/operator-state-pg');
  const { registerEventKey } = await import('../lib/event-key-registry-store');
  await sql`CREATE TABLE IF NOT EXISTS public.irx_effects (id bigserial PRIMARY KEY, tool text, owner_id text, title text)`;
  await sql`CREATE TABLE IF NOT EXISTS public.irx_entered (id bigserial PRIMARY KEY, owner_id text)`;
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${workspaceId}, ${HARNESS}, ${Buffer.from([0])}, 'kc-irx', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  writePotBlueprint([CAP, GUARDED_CAP]);
  // The harness is its own pot: a hive entry resolves to itself (memory/hive-scope).
  await writeOperatorState('harness_registry',
    { projects: [{ slug: HARNESS, name: HARNESS, path: potDir, harness_kind: 'hive' }] }, workspaceId);
  for (const key of ['irx.basic', 'irx.guarded', 'irx.quota', 'irx.role', 'irx.bare', 'irx.crash']) {
    await registerEventKey(sql, { workspaceId, eventKey: key, title: key, description: `${key} test key`, status: 'active' });
  }

  const inputSchema = { type: 'object', properties: { title: { type: 'string' } } };
  const outputSchema = { type: 'string', maxLength: 128 };
  const { capabilityClass } = await registry.defineCapabilityClass(sql, {
    workspaceId, id: 'irx.tasks', version: '1.0.0', title: 'IRX tasks', description: 'identity-reaction test class',
    interfaceVerbs: {
      create: { inputSchema, outputSchema, capability: CAP },
      guarded: { inputSchema, outputSchema, capability: GUARDED_CAP },
      limited: { inputSchema, outputSchema, capability: CAP },
      admin: { inputSchema, outputSchema, capability: CAP },
      bare: { inputSchema, outputSchema },
    },
  });
  const verbBindings = {
    create: 'irx:create', guarded: 'irx:guarded-tool', limited: 'irx:limited', admin: 'irx:admin-only', bare: 'irx:bare',
  };
  const report = registry.validateProviderInterface({
    capabilityClass, providerPackage: 'irx-test', providerVersion: '1.0.0',
    registryRevision: 'irx-registry-1', verbBindings,
    lookup: (name) => ({ name, pluginName: 'irx-test', inputSchema, outputSchema }),
  });
  await registry.recordProviderConformance(sql, {
    workspaceId, classId: 'irx.tasks', classVersion: '1.0.0',
    providerPackage: 'irx-test', providerVersion: '1.0.0', verbBindings, report,
  });
  await registry.bindCapabilityProviderToPot(sql, {
    workspaceId, potSlug: HARNESS, classId: 'irx.tasks', classVersion: '1.0.0',
    providerPackage: 'irx-test', providerVersion: '1.0.0',
  });

  // The install checks (D-027 §1) against the real catalogs.
  const { checkAsyncRuleInstall } = await import('../lib/agent-identities/identity-async-rules');
  const install = {
    good: await checkAsyncRuleInstall(sql, workspaceId, { on: 'irx.basic', fire: `class:${CLASS_REF}#create` }),
    missingCapability: await checkAsyncRuleInstall(sql, workspaceId, { on: 'irx.bare', fire: `class:${CLASS_REF}#bare` }),
    uncatalogued: await checkAsyncRuleInstall(sql, workspaceId, { on: 'irx.nowhere', fire: `class:${CLASS_REF}#create` }),
  };

  const a = await compile('irx-a', ['file-task', 'guarded-task', 'limited-task', 'admin-task', 'bare-task']);
  const c = await compile('irx-c', ['crash-task']);
  for (const owner of ['su-irx-alpha', 'su-irx-beta', 'su-irx-detach', 'su-irx-upgrade']) await wear(owner, a);
  for (const owner of ['su-irx-crash', 'su-irx-crash-detach']) await wear(owner, c);

  // Initialize the DBOS system schema, then stop: the executor is launched by
  // the modes that exercise it.
  await DBOS.launch();
  await DBOS.shutdown();
  process.stdout.write(`IRX_REPORT ${JSON.stringify({ install })}\n`);
} else if (mode === 'scenarios') {
  // PHASE 1 — no executor: every reaction is ENQUEUED by the request-side client.
  await emit('irx.basic');
  await emit('irx.guarded');
  const enqueued = {
    basic: await workflowStatuses('irx.basic'),
    guarded: await workflowStatuses('irx.guarded'),
  };
  // Change live state between enqueue and execution.
  await detach('su-irx-detach');
  await wear('su-irx-upgrade', await compile('irx-b', ['file-task']));
  writePotBlueprint([CAP]); // revoke the guarded capability from the pot's su ceiling

  await DBOS.launch();
  await settled('irx.basic', 4);
  await settled('irx.guarded', 4);

  // Replay: the same workflow id and the same step body collapse onto the receipt.
  const { enqueueIdentityReaction, IDENTITY_REACTION_WORKFLOW_NAME } = await import('../lib/dbos/identity-reaction-workflow');
  const { executeIdentityReaction } = await import('../lib/events/identity-reaction');
  const runs = await DBOS.listWorkflows({ workflowName: IDENTITY_REACTION_WORKFLOW_NAME, loadInput: true });
  const alpha = runs.map((run) => run.input?.[0] as { ownerId: string; eventKey: string } | undefined)
    .find((input) => input?.ownerId === 'su-irx-alpha' && input.eventKey === 'irx.basic');
  if (!alpha) throw new Error('alpha irx.basic workflow input not found');
  const replay = {
    enqueue: await enqueueIdentityReaction(alpha as never),
    execute: await executeIdentityReaction(alpha as never),
  };

  // PHASE 2 — executor running. Quota is per wearer: settle one fire before the next.
  await emit('irx.quota');
  await settled('irx.quota', 2);
  await emit('irx.quota');
  await settled('irx.quota', 4);
  await emit('irx.role');
  await settled('irx.role', 2);
  await emit('irx.bare');
  await settled('irx.bare', 2);

  const report = {
    enqueued,
    replay,
    receipts: {
      basic: await receipts('irx.basic'),
      guarded: await receipts('irx.guarded'),
      quota: await receipts('irx.quota'),
      role: await receipts('irx.role'),
      bare: await receipts('irx.bare'),
    },
  };
  await DBOS.shutdown();
  process.stdout.write(`IRX_REPORT ${JSON.stringify(report)}\n`);
} else if (mode === 'crash') {
  await DBOS.launch();
  await emit('irx.crash');
  // The tool SIGKILLs this process once both wearers are inside the dispatch.
  await new Promise((resolve) => setTimeout(resolve, 90_000));
  throw new Error('crash wearers did not reach the dispatch before the deadline');
} else {
  await DBOS.launch();
  await settled('irx.crash', 2);
  await DBOS.shutdown();
  process.stdout.write(`IRX_REPORT ${JSON.stringify({ receipts: await receipts('irx.crash') })}\n`);
}

await sql.end({ timeout: 5 });
log('done');
process.exit(0);
