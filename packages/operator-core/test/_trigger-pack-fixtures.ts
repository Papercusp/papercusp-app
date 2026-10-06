/**
 * Shared fixtures for the trigger-pack integration suites (plan
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05
 * P-012, D-013): R-8 `cupboard/trigger-pack-materialization.integration.test.ts`
 * and R-9 `external-triggers/portable-pack-dispatch.integration.test.ts`.
 *
 * Kept out of the test files so a suite can reuse them without importing (and so
 * re-registering) another suite's hooks and tests.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import type { RegisteredProvider } from '../lib/integrations/provider-registry';

export const PLUGIN = '@pack-publisher/portable-mail-workflow';
export const REPLY_SLUG = 'pack-reply-2026-10-05';
export const FOLLOW_SLUG = 'pack-follow-up-2026-10-05';
export const PACK_GITHUB_URL = 'https://github.com/pack-publisher/portable-mail-workflow';

/** A startable template: it carries its own BAR source, like the flagship templates. */
export function packTemplate(slug: string, title: string, withBars = true): string {
  const requirement = JSON.stringify({
    intent: {
      request: `${title} handles one triggering event.`,
      constraints: ['Read the triggering event through triggers:read-payload.'],
      sourceRefs: ['P-001'],
    },
    acceptance: {
      condition: 'A run of this template handles exactly one triggering event.',
      falsifier: 'A run completes without handling its event, or handles it twice.',
      requiredScope: ['tree'],
      evidencePlane: 'tree',
    },
    verification: {
      method: 'Fire the pack binding through the binding engine and read the resulting run.',
      check: { kind: 'instrument', instrumentKey: 'none' },
      replication: 'Run the trigger-pack integration suites.',
    },
  });
  const bars = withBars
    ? `## Requirements\n\n**R-1 — Handle the event.**\n\`\`\`requirement\n${requirement}\n\`\`\`\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n\n`
    : '';
  return `---\ntitle: ${title}\nslug: ${slug}\nstatus: ready\ncreated: 2026-10-05\nupdated: 2026-10-05\n---\n\n# ${title}\n\n## Now\n\n**State:** Ready pack template.\n\n**Next:** Handle the triggering event.\n\n${bars}## Phase 1 — Handle\n\n- **P-001** \`todo\` Read the triggering event and handle it.\n`;
}

export const PLAN_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['trigger', 'tone'],
  properties: { trigger: { type: 'object', additionalProperties: true }, tone: { type: 'string' } },
};

/** A portable pack: no provider, account, source id or plan-run id anywhere. */
export function portablePackManifest(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'plugin',
    name: PLUGIN,
    version: '1.0.0',
    papercusp: '^0.1.0',
    description: 'Portable mail workflow: reply to inbound mail, then follow up.',
    author: 'Pack Publisher',
    publisher: '@pack-publisher',
    license: 'MIT',
    versionPin: { mode: 'exact' },
    capabilities: [],
    triggerPack: {
      inputs: {
        type: 'object',
        additionalProperties: false,
        required: ['tone'],
        properties: { tone: { type: 'string' } },
      },
      defaultStormPolicy: { maxRuns: 2, windowSeconds: 3600 },
      targets: [
        { id: 'reply', kind: 'plan', path: 'plan-reply.md', inputSchema: PLAN_INPUT_SCHEMA },
        { id: 'follow-up', kind: 'plan', path: 'plan-follow-up.md', inputSchema: PLAN_INPUT_SCHEMA },
      ],
      bindings: [
        {
          id: 'inbound-mail',
          source: { kind: 'external', datatype: 'email-message', capabilities: ['mail.read'] },
          target: 'reply',
          eventPattern: 'ext:*:message.received',
          filter: { direction: 'inbound' },
        },
        { id: 'after-reply', source: { kind: 'internal', event: 'binding-run-completed' }, target: 'follow-up' },
        { id: 'manual-follow-up', source: { kind: 'manual' }, target: 'follow-up' },
      ],
      edges: [{ from: 'inbound-mail', to: 'after-reply', event: 'binding-run-completed', correlation: 'inherit' }],
    },
    ...overrides,
  };
}

/** Two installed providers: a Graph-shaped one and gmail, both producing email-message. */
export const fakeRegistry = {
  get(kind: string) {
    const capabilities: Record<string, string[]> = {
      'outlook-fixture': ['mail.read'],
      gmail: ['mail.read', 'mail.draft'],
    };
    if (!capabilities[kind]) return undefined;
    return { descriptor: { id: kind, datatypes: ['email-message'], capabilities: capabilities[kind] } } as unknown as RegisteredProvider;
  },
};

export async function writePackDir(dir: string, manifest: Record<string, unknown>, withBars = true): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(join(dir, 'plan-reply.md'), packTemplate(REPLY_SLUG, 'Pack reply', withBars));
  await fs.writeFile(join(dir, 'plan-follow-up.md'), packTemplate(FOLLOW_SLUG, 'Pack follow-up', withBars));
}

/**
 * Seed one workspace's pot, harness registry and datatypes. Plan slugs are a
 * workspace-level identity, so suites give each test its own workspace.
 */
export async function seedPackWorkspace(
  sql: Sql,
  ws: string,
  harness: string,
  datatypes: string[] = ['email-message'],
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${ws}, ${harness}, ${Buffer.from(`pk:${ws}:${harness}`)}, ${'kc-' + ws}, 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload)
    VALUES (${ws}, ${JSON.stringify({ projects: [{ slug: harness, path: `/tmp/${harness}`, harness_kind: 'hive' }] })}::text::jsonb)
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload`;
  for (const datatype of datatypes) {
    await sql`
      INSERT INTO harness_shared.datatype_registry
        (workspace_id, id, title, description, tier, payload_schema, authoritative_writer)
      VALUES (${ws}, ${datatype}, ${datatype}, ${'Fixture datatype ' + datatype}, 'workspace',
              '{"type":"object","additionalProperties":true}'::jsonb, 'papercusp')
      ON CONFLICT (workspace_id, id) DO NOTHING`;
  }
}
