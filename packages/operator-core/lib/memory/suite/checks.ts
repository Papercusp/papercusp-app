/**
 * memory-core suite — the test list driven by /admin/testing?tab=memory
 * and the periodic test-runs orchestrator.
 *
 * Each check is self-contained: writes use a `__memtest__/<runId>/...`
 * content prefix so the cleanup phase can find and delete them, even
 * after a crash partway through a prior run.
 *
 * Synthetic users (__memtest_user_a / __memtest_user_b) are created on
 * suite start with is_active=false so the user-picker doesn't show
 * them; dropped on suite end.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  getMemoryClient,
  getResolvedMode,
  invalidateMemoryClient,
} from '../mem0-client';
import { buildMemoryContextBlock } from '../injection';
import { extractAnchors, anchorMetadata } from '../anchors';
// extractAddedIds moved behind Mem0Backend (generalize-memory-backend-swappable
// D-002); this suite is mem0-internal diagnostics, so the lib import is right.
import { extractAddedIds } from '@papercusp/memory';
import { persistAnchorsSql } from '../persist-anchors';
import { activeWorkspaceId } from '../../workspace-registry';
import type { AdminTestCheckResult } from '../../admin-test-suites-shared';

type CheckResult = Omit<AdminTestCheckResult, 'suiteId' | 'id' | 'label' | 'durationMs'>;

interface SuiteState {
  runId: string;
  workspaceId: string;
  userAId: string;
  userBId: string;
}

let _state: SuiteState | null = null;

const PREFIX_BASE = '__memtest__';
const USERNAME_A = '__memtest_user_a';
const USERNAME_B = '__memtest_user_b';

function pass(actual: string, details?: string[]): CheckResult {
  return { status: 'pass', expected: 'Check completes successfully.', actual, details };
}
function warn(expected: string, actual: string, details?: string[]): CheckResult {
  return { status: 'warn', expected, actual, details };
}
function fail(expected: string, actual: string, details?: string[]): CheckResult {
  return { status: 'fail', expected, actual, details };
}
function skip(reason: string): CheckResult {
  return { status: 'skip', expected: 'Check enabled.', actual: reason };
}
function check(condition: boolean, expected: string, actualOk: string, actualFail: string, details?: string[]): CheckResult {
  return condition ? pass(actualOk, details) : fail(expected, actualFail, details);
}

interface Mem0Entry {
  id: string;
  memory?: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

async function pgFieldsFor(): Promise<{ host: string; port: number; user: string; password: string; dbname: string } | null> {
  try {
    const { pgFields } = await import('../mem0-connection');
    return await pgFields();
  } catch {
    return null;
  }
}

async function ensureSyntheticUsers(): Promise<{ userAId: string; userBId: string }> {
  const { sql } = getOrgPg();
  // Upsert idempotently so a prior crash mid-suite doesn't leave us stuck.
  // is_active=false hides them from the user picker.
  const a = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name, is_active)
    VALUES (${USERNAME_A}, 'Memory Test User A', false)
    ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id
  `;
  const b = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name, is_active)
    VALUES (${USERNAME_B}, 'Memory Test User B', false)
    ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING id
  `;
  return { userAId: a[0].id, userBId: b[0].id };
}

async function dropSyntheticUsers(): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      DELETE FROM harness_shared.users
       WHERE username IN (${USERNAME_A}, ${USERNAME_B})
    `;
  } catch {
    /* best-effort */
  }
}

function memHasPrefix(entry: Mem0Entry, prefix: string): boolean {
  const text = entry.memory ?? '';
  if (text.startsWith(prefix)) return true;
  // mem0 sometimes summarises the content; metadata.test_tag is more reliable
  const tag = (entry.metadata ?? {}).test_tag as string | undefined;
  return tag === prefix;
}

async function deleteSuiteEntries(prefix: string): Promise<number> {
  const client = await getMemoryClient();
  if (!client) return 0;
  let purged = 0;
  // Sweep across users — we don't know who owns lingering entries
  const targets = [
    { user_id: _state?.userAId ?? '' },
    { user_id: _state?.userBId ?? '' },
    { user_id: `workspace:${_state?.workspaceId ?? activeWorkspaceId()}` },
  ];
  for (const t of targets) {
    if (!t.user_id) continue;
    try {
      const result = await client.getAll({ filters: t, topK: 5000 });
      for (const entry of (result.results ?? []) as Mem0Entry[]) {
        if (memHasPrefix(entry, prefix)) {
          try { await client.delete(entry.id); purged += 1; } catch { /* */ }
        }
      }
    } catch { /* */ }
  }
  return purged;
}

async function setupSuite(runId: string): Promise<SuiteState> {
  const workspaceId = activeWorkspaceId();
  const { userAId, userBId } = await ensureSyntheticUsers();
  const state: SuiteState = { runId, workspaceId, userAId, userBId };
  _state = state;
  // Sweep any leftover __memtest__ entries from prior crashed runs.
  await deleteSuiteEntries(PREFIX_BASE);
  return state;
}

async function teardownSuite(): Promise<{ purged: number }> {
  if (!_state) return { purged: 0 };
  const purged = await deleteSuiteEntries(PREFIX_BASE);
  await dropSyntheticUsers();
  _state = null;
  return { purged };
}

function uniqueFact(runId: string, slot: string, payload: string): string {
  return `${PREFIX_BASE}/${runId}/${slot} ${payload}`;
}

// ─── Check implementations ────────────────────────────────────────────

async function checkPgvectorExtension(): Promise<CheckResult> {
  const fields = await pgFieldsFor();
  if (!fields) return fail('pgvector extension installed in embedded PG.', 'Could not resolve PG connection fields.');
  try {
    const { Client } = await import('pg');
    const c = new Client({ host: fields.host, port: fields.port, user: fields.user, password: fields.password, database: fields.dbname });
    await c.connect();
    try {
      const r = await c.query("SELECT extname FROM pg_extension WHERE extname='vector'");
      return check(
        (r.rowCount ?? 0) > 0,
        'pgvector extension installed in embedded PG.',
        'vector extension installed.',
        'vector extension missing — mem0 falls back to volatile in-process store.',
      );
    } finally {
      await c.end();
    }
  } catch (e) {
    return fail('pgvector extension installed in embedded PG.', `PG probe failed: ${(e as Error).message}`);
  }
}

async function checkMem0Client(): Promise<CheckResult> {
  const client = await getMemoryClient();
  if (!client) {
    const mode = getResolvedMode();
    return fail(
      'mem0 client constructs without error.',
      `getMemoryClient() returned null (resolved mode=${mode ?? 'unknown'}). Verify pgvector + embedder + LLM key.`,
    );
  }
  return pass(`mem0 client ready (mode=${getResolvedMode() ?? 'unknown'}).`);
}

async function checkEmbedderResolution(): Promise<CheckResult> {
  const mode = getResolvedMode();
  if (mode === null) {
    // Force a build attempt so the resolver runs.
    await getMemoryClient();
  }
  const resolved = getResolvedMode();
  if (resolved === null) {
    return fail(
      'Embedder resolves to openai or local.',
      'Could not resolve an embedder. Set OpenAI key at /settings/api-keys, install @huggingface/transformers, or set memoryEmbedderMode in /settings/user.',
    );
  }
  return pass(`Embedder resolved to '${resolved}'.`);
}

/**
 * Can mem0 run its fact-extraction LLM step at all?
 *
 * Checks the extraction cascade IN ITS REAL ORDER since
 * inference-rename-and-provider-agnostic-default-2026-08-09 P-005. It used to check only for a
 * raw Anthropic key, which made it report a warning — and, with no OpenAI key, an outright
 * FAILURE — on a box that extracts perfectly well via rung #1. That was already wrong before
 * this plan (rung #1 predates it); removing the settings field just guaranteed it would fire.
 *
 * Rung #1 is the session transport (Haiku on the Claude session or the default account — no key,
 * $0 marginal), so a resolvable transport is a PASS on its own and the raw key is a fall-through.
 */
async function checkAnthropicKey(): Promise<CheckResult> {
  try {
    const { probeStatelessTransport } = await import('@papercusp/papercusp-shared/agent');
    const probe = probeStatelessTransport();
    if (probe.ok) {
      return pass(`Fact extraction available via the ${probe.label} transport (no raw key needed).`);
    }
  } catch {
    // The probe is an OPTIMISATION on the happy path, not the verdict — fall through to the
    // key checks below rather than failing the whole check because one import misbehaved.
  }
  try {
    const { readCredentials } = await import('../../credentials');
    const creds = await readCredentials();
    if (creds.anthropic_api_key || process.env.ANTHROPIC_API_KEY) {
      return pass('Anthropic key present — Haiku fact extraction enabled.');
    }
    if (creds.openai_api_key || process.env.OPENAI_API_KEY) {
      return warn(
        'Fact extraction reaches Haiku (session transport or an Anthropic key).',
        'No session transport and no Anthropic key — mem0 falls back to OpenAI gpt-4o-mini for extraction (more expensive).',
      );
    }
    return fail(
      'Some fact-extraction route available (session transport, Anthropic key, or OpenAI key).',
      'No session transport and neither key found — the mem0 LLM step will fail. Set a default ' +
        'account at /settings/deploy-accounts (Inference), or add an OpenAI embeddings key at /settings/api-keys.',
    );
  } catch (e) {
    return fail('Credentials readable.', `readCredentials threw: ${(e as Error).message}`);
  }
}

async function checkRoundtripRememberList(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const content = uniqueFact(_state.runId, 'roundtrip-list', `cipher word=heliotrope-${Date.now()}`);
  await client.add(content, {
    userId: _state.userAId,
    metadata: { kind: 'project', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  const all = await client.getAll({ filters: { user_id: _state.userAId }, topK: 5000 });
  const hit = (all.results as Mem0Entry[] | undefined)?.find((e) => memHasPrefix(e, PREFIX_BASE) && (e.memory ?? '').includes('heliotrope'));
  return check(
    !!hit,
    'Written entry visible in getAll for the same user.',
    `Found entry id=${hit?.id}.`,
    `Could not find the written entry (got ${(all.results ?? []).length} entries).`,
  );
}

async function checkRoundtripSemanticSearch(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const marker = `quokka-${Date.now()}`;
  const content = uniqueFact(_state.runId, 'roundtrip-search', `The user's favourite animal is the ${marker}.`);
  await client.add(content, {
    userId: _state.userAId,
    metadata: { kind: 'preference', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  // Brief wait for any async indexing.
  await new Promise((r) => setTimeout(r, 250));
  const searchRes = await client.search('What animal does the user like?', { userId: _state.userAId, limit: 5 });
  const top = ((searchRes.results as Mem0Entry[] | undefined) ?? []).slice(0, 3);
  const matched = top.some((e) => (e.memory ?? '').includes(marker));
  return check(
    matched,
    'Semantic search retrieves the seeded fact within top-3.',
    `Found the seeded fact in top-3 (top score=${top[0]?.score ?? 'n/a'}).`,
    `Seeded fact not in top-3. Top: ${top.map((e) => `${(e.memory ?? '').slice(0, 60)}…`).join(' | ')}`,
  );
}

async function checkRoundtripUpdate(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const original = uniqueFact(_state.runId, 'update-orig', `colour=blue-${Date.now()}`);
  const added = await client.add(original, {
    userId: _state.userAId,
    metadata: { kind: 'preference', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  }) as { results?: Array<{ id: string }> } | Array<{ id: string }>;
  // mem0 v3 returns { results: [{ id, ... }] }, sometimes a bare array. Find an id.
  const ids = Array.isArray(added) ? added.map((r) => r.id) : (added.results ?? []).map((r) => r.id);
  if (ids.length === 0) {
    // Fall back to a getAll lookup
    const all = await client.getAll({ filters: { user_id: _state.userAId }, topK: 5000 });
    const found = ((all.results as Mem0Entry[] | undefined) ?? []).find((e) => (e.memory ?? '').includes('colour=blue'));
    if (!found) return fail('Memory id retrievable after add.', 'No id returned and getAll did not surface the entry.');
    ids.push(found.id);
  }
  const updated = uniqueFact(_state.runId, 'update-new', `colour=teal-${Date.now()}`);
  await client.update(ids[0], updated);
  const got = await client.get(ids[0]);
  return check(
    (got?.memory ?? '').includes('teal'),
    'Updated content visible after update().',
    `Entry now: "${(got?.memory ?? '').slice(0, 80)}"`,
    `Entry not updated: "${(got?.memory ?? '').slice(0, 80)}"`,
  );
}

async function checkRoundtripForget(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const content = uniqueFact(_state.runId, 'forget', `transient-fact-${Date.now()}`);
  const added = await client.add(content, {
    userId: _state.userAId,
    metadata: { kind: 'preference', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  }) as { results?: Array<{ id: string }> };
  let id: string | undefined = (added.results ?? [])[0]?.id;
  if (!id) {
    const all = await client.getAll({ filters: { user_id: _state.userAId }, topK: 5000 });
    id = ((all.results as Mem0Entry[] | undefined) ?? []).find((e) => (e.memory ?? '').includes('transient-fact'))?.id;
  }
  if (!id) return fail('Memory id retrievable for forget.', 'Could not locate id after add.');
  await client.delete(id);
  const got = await client.get(id);
  return check(
    !got || (got as unknown) === null,
    'Entry gone after forget.',
    'Entry not found post-delete (expected).',
    `Entry still present post-delete: "${(got?.memory ?? '').slice(0, 80)}"`,
  );
}

async function checkTenancyPerUserIsolation(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const marker = `nimbus-${Date.now()}`;
  await client.add(uniqueFact(_state.runId, 'tenancy-a', `secret-A=${marker}`), {
    userId: _state.userAId,
    metadata: { kind: 'identity', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  const bView = await client.getAll({ filters: { user_id: _state.userBId }, topK: 5000 });
  const leaked = ((bView.results as Mem0Entry[] | undefined) ?? []).some((e) => (e.memory ?? '').includes(marker));
  return check(
    !leaked,
    "User B cannot see User A's memories.",
    'User A memory is not visible to User B.',
    "Tenancy leak: User A's memory appeared in User B's getAll.",
  );
}

// (checkTenancyWorkspaceShared removed — the `workspace:` scope was retired,
// docs-and-memory-as-projections-2026-06-05 D-005.)

async function checkTenancyHarnessScoped(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const slug = `__memtest_harness_${_state.runId}`;
  const marker = `solstice-${Date.now()}`;
  await client.add(uniqueFact(_state.runId, 'harness', `harness-fact=${marker}`), {
    userId: `harness:${slug}`,
    metadata: { kind: 'project', scope: 'harness', harness_slug: slug, test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  const harnessView = await client.getAll({ filters: { user_id: `harness:${slug}` }, topK: 100 });
  const visible = ((harnessView.results as Mem0Entry[] | undefined) ?? []).some((e) => (e.memory ?? '').includes(marker));
  const userAView = await client.getAll({ filters: { user_id: _state.userAId }, topK: 5000 });
  const leaked = ((userAView.results as Mem0Entry[] | undefined) ?? []).some((e) => (e.memory ?? '').includes(marker));
  if (leaked) return fail('Harness memory isolated from personal scope.', `Isolation breach: harness entry appeared in user A's personal bucket.`);
  return check(visible, 'Harness-scoped memory visible under harness:<slug> scope.', 'Harness memory stored and retrieved correctly.', 'Harness memory not found in harness bucket.');
}

async function checkInjectionHarnessScoped(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const slug = `__memtest_harness_${_state.runId}`;
  const marker = `equinox-${Date.now()}`;
  await client.add(`Harness convention: all migrations must be reviewed before merging. (${marker})`, {
    userId: `harness:${slug}`,
    metadata: { kind: 'project', scope: 'harness', harness_slug: slug, test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  await new Promise((r) => setTimeout(r, 200));
  const block = await buildMemoryContextBlock({
    userId: _state.userAId,
    workspaceId: _state.workspaceId,
    harnessSlugs: [slug],
    queryContext: 'What are the migration review requirements?',
    limit: 6,
  });
  return check(
    !!block && block.includes(marker),
    'Harness-scoped memory surfaced when harnessSlugs includes the slug.',
    'Harness memory found in injection block.',
    `Harness memory not surfaced. Block: ${block ? block.slice(0, 200) : 'null'}`,
  );
}

// (checkInjectionDeprecationReadthrough / checkTtlExpired / checkTtlFutureSurvives
// removed — the `workspace:` scope and the `ephemeral` kind were retired in
// docs-and-memory-as-projections-2026-06-05 D-005/D-006.)

async function checkInjectionRelevant(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const marker = `umbra-${Date.now()}`;
  await client.add(`The user prefers all responses in Markdown bullet points. (${marker})`, {
    userId: _state.userAId,
    metadata: { kind: 'preference', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  await new Promise((r) => setTimeout(r, 200));
  const block = await buildMemoryContextBlock({
    userId: _state.userAId,
    workspaceId: _state.workspaceId,
    queryContext: 'How should you format your replies?',
    limit: 6,
  });
  return check(
    !!block && block.includes(marker),
    'buildMemoryContextBlock returns a block containing the relevant fact.',
    `Block returned with marker (${(block ?? '').length} chars).`,
    `Block did not include the seeded fact. Block: ${block ? block.slice(0, 200) : 'null'}`,
  );
}

async function checkInjectionEmpty(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const block = await buildMemoryContextBlock({
    userId: _state.userAId,
    workspaceId: _state.workspaceId,
    queryContext: '',
    limit: 6,
  });
  return check(
    block === null,
    'Empty queryContext returns null (no injection).',
    'Returned null as expected.',
    `Expected null for empty queryContext; got ${typeof block} (${(block ?? '').length} chars).`,
  );
}

// (checkInjectionShared removed — workspace-shared injection retired, D-005.)

/**
 * D-006 dedup watermark: a fact surfaced on one turn is NOT re-injected on the
 * next turn within the reinject window (last_surfaced_at guard). Surface once,
 * let the async bump land, then surface again — the second block must omit it.
 */
async function checkInjectionDedup(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const marker = `lodestar-${Date.now()}`;
  await client.add(`The user's favorite deploy window is ${marker} on Fridays.`, {
    userId: _state.userAId,
    metadata: { kind: 'preference', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  await new Promise((r) => setTimeout(r, 250));
  const query = 'When is the favorite deploy window?';
  const first = await buildMemoryContextBlock({
    userId: _state.userAId, workspaceId: _state.workspaceId, queryContext: query, limit: 6,
  });
  if (!first || !first.includes(marker)) {
    return fail('First injection surfaces the fact (precondition).',
      `Fact not surfaced on the first turn; cannot test dedup. Block: ${first ? first.slice(0, 160) : 'null'}`);
  }
  // Let the fire-and-forget last_surfaced_at bump commit, then re-inject.
  await new Promise((r) => setTimeout(r, 600));
  const second = await buildMemoryContextBlock({
    userId: _state.userAId, workspaceId: _state.workspaceId, queryContext: query, limit: 6,
  });
  const deduped = !second || !second.includes(marker);
  return check(
    deduped,
    'A recently-surfaced fact is deduped on the next turn (watermark guard).',
    'Second injection correctly omitted the just-surfaced fact.',
    `Fact was re-injected turn-over-turn (dedup failed). Block: ${second ? second.slice(0, 160) : 'null'}`,
  );
}

async function checkExtractionFromTurn(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const marker = `volcanic-${Date.now()}`;
  // mem0 v3: client.add accepts a message list and triggers extraction via LLM.
  const messages = [
    { role: 'user', content: `I really enjoy ${marker} coffee blends — please remember that.` },
    { role: 'assistant', content: "Got it." },
  ];
  await (client.add as unknown as (m: unknown, o: unknown) => Promise<unknown>)(messages, {
    userId: _state.userBId,
    metadata: { kind: 'preference', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  // Extraction is LLM-bound; allow up to 3s.
  await new Promise((r) => setTimeout(r, 1500));
  const all = await client.getAll({ filters: { user_id: _state.userBId }, topK: 5000 });
  const extracted = ((all.results as Mem0Entry[] | undefined) ?? []).find((e) => (e.memory ?? '').toLowerCase().includes(marker.toLowerCase()));
  return check(
    !!extracted,
    'Haiku extraction creates a memory from a user turn.',
    `Extracted memory: "${(extracted?.memory ?? '').slice(0, 120)}"`,
    'Haiku did not extract a memory containing the marker — could be slow extraction OR extraction failure.',
  );
}

/* ─── Anchors + Layer-1 audit (P-014/P-015/P-019) ──────────────────── */

async function checkAnchorExtraction(): Promise<CheckResult> {
  // Pure-logic — doesn't touch mem0 or PG, but exercised here so the
  // /admin/testing dashboard shows the anchor pipeline lit up.
  const content =
    'See apps/operator/lib/memory/persist-anchors.ts and F-001 and ' +
    'plan papercusp-su-memory-2026-05-25 and migration 085 for context.';
  const anchors = extractAnchors(content);
  const kinds = new Set(anchors.map((a) => a.kind));
  const required = ['file', 'feature', 'plan', 'migration'];
  const missing = required.filter((k) => !kinds.has(k as 'file' | 'feature' | 'plan' | 'migration'));
  return check(
    missing.length === 0,
    'Anchor extractor identifies file/feature/plan/migration tokens.',
    `Extracted ${anchors.length} anchors: ${[...kinds].sort().join(', ')}.`,
    `Missing kinds: ${missing.join(', ')} (got: ${[...kinds].sort().join(', ') || 'none'}).`,
    [JSON.stringify(anchors)],
  );
}

async function checkAnchorsPersistedOnWrite(): Promise<CheckResult> {
  // Insert a synthetic memory_canonical row + anchors via persist-anchors,
  // bypassing mem0 (which needs an LLM key to extract). This proves the
  // PG-side writer plumbing is wired end-to-end.
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const { sql } = getOrgPg();
  const memoryId = '00000000-0000-4000-8000-' + _state.runId.slice(0, 12).replace(/[^0-9a-f]/gi, '0').padEnd(12, '0');
  const anchors: Array<{ kind: 'file' | 'feature'; value: string }> = [
    { kind: 'file', value: 'apps/operator/lib/memory/persist-anchors.ts' },
    { kind: 'feature', value: 'F-001' },
  ];
  try {
    await sql`
      INSERT INTO harness_shared.memory_canonical (id, payload, state)
      VALUES (${memoryId}::uuid, ${JSON.stringify({ memory: `${PREFIX_BASE}/${_state.runId}/anchors-write` })}::text::jsonb, 'active')
      ON CONFLICT (id) DO UPDATE SET state = 'active'
    `;
  } catch (e) {
    return fail('memory_canonical INSERT for synthetic id.', `${(e as Error).message}`);
  }
  const ok = await persistAnchorsSql(sql as unknown as Parameters<typeof persistAnchorsSql>[0], memoryId, anchors);
  if (!ok) {
    return fail(
      'persistAnchorsSql returns true for valid input.',
      'Returned false — table may be missing or PG error swallowed.',
    );
  }
  const rows = (await sql`
    SELECT kind, value FROM harness_shared.memory_anchors
    WHERE memory_id = ${memoryId}::uuid
    ORDER BY kind, value
  `) as unknown as Array<{ kind: string; value: string }>;
  // Cleanup (CASCADE handles memory_anchors).
  await sql`DELETE FROM harness_shared.memory_canonical WHERE id = ${memoryId}::uuid`;

  return check(
    rows.length === anchors.length,
    `${anchors.length} memory_anchors rows persisted for the synthetic id.`,
    `Found ${rows.length} rows: ${rows.map((r) => `${r.kind}:${r.value}`).join(', ')}.`,
    `Expected ${anchors.length} rows, found ${rows.length}.`,
  );
}

async function checkLayer1AuditFlipsState(): Promise<CheckResult> {
  // Seed a row with one valid + one broken file anchor; run audit(); assert
  // state flips to 'broken_anchor' and per-anchor last_check_ok is recorded.
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const { audit } = await import('../audit-memory-anchors');
  const { sql } = getOrgPg();
  const path = await import('node:path');

  const memoryId = '00000000-0000-4000-8000-' + _state.runId.slice(0, 12).replace(/[^0-9a-f]/gi, '0').padEnd(12, '0').slice(0, 12);
  const probeAnchors: Array<{ kind: 'file'; value: string }> = [
    { kind: 'file', value: 'apps/operator/lib/memory/persist-anchors.ts' },        // exists
    { kind: 'file', value: 'apps/operator/__memtest__/no-such-file-xyzzy.ts' },    // missing
  ];

  try {
    await sql`
      INSERT INTO harness_shared.memory_canonical (id, payload, state)
      VALUES (${memoryId}::uuid, ${JSON.stringify({ memory: `${PREFIX_BASE}/${_state.runId}/audit-flip` })}::text::jsonb, 'active')
      ON CONFLICT (id) DO UPDATE SET state = 'active'
    `;
    await persistAnchorsSql(sql as unknown as Parameters<typeof persistAnchorsSql>[0], memoryId, probeAnchors);

    // Walk up two levels from the operator app to find repoRoot (apps/operator → apps → repo).
    const repoRoot = path.resolve(process.cwd(), '..', '..');
    const result = await audit({ dryRun: false, repoRoot });

    if (result.skipped) {
      return skip(`Audit skipped: ${(result as { reason?: string }).reason ?? 'unknown'}.`);
    }

    const stateRows = (await sql`
      SELECT state FROM harness_shared.memory_canonical WHERE id = ${memoryId}::uuid
    `) as unknown as Array<{ state: string }>;
    const state = stateRows[0]?.state;
    const anchorRows = (await sql`
      SELECT kind, value, last_check_ok FROM harness_shared.memory_anchors WHERE memory_id = ${memoryId}::uuid ORDER BY value
    `) as unknown as Array<{ kind: string; value: string; last_check_ok: boolean | null }>;

    const stateOk = state === 'broken_anchor';
    const valid = anchorRows.find((r) => r.value.endsWith('persist-anchors.ts'));
    const broken = anchorRows.find((r) => r.value.endsWith('no-such-file-xyzzy.ts'));
    const anchorsOk = valid?.last_check_ok === true && broken?.last_check_ok === false;

    return check(
      stateOk && anchorsOk,
      'state flips to broken_anchor; per-anchor last_check_ok correctly recorded.',
      `state=${state}, valid.ok=${valid?.last_check_ok}, broken.ok=${broken?.last_check_ok}.`,
      `state=${state} (expected broken_anchor); valid.ok=${valid?.last_check_ok} (expected true); broken.ok=${broken?.last_check_ok} (expected false).`,
    );
  } finally {
    await sql`DELETE FROM harness_shared.memory_canonical WHERE id = ${memoryId}::uuid`;
  }
}

async function checkAnchorMetadataShape(): Promise<CheckResult> {
  // anchorMetadata() is the function remember.ts actually uses — verify its
  // wrapper shape (`{ anchors, anchor_count }`) is stable. Pure-logic, fast.
  const meta = anchorMetadata('apps/operator/foo.ts and F-007');
  const empty = anchorMetadata('no anchors here at all');
  const okShape =
    meta !== null &&
    Array.isArray(meta.anchors) &&
    meta.anchor_count === meta.anchors.length &&
    meta.anchor_count >= 2;
  const okEmpty = empty === null;
  return check(
    okShape && okEmpty,
    'anchorMetadata returns {anchors, anchor_count} on content with anchors and null on empty.',
    `meta.anchor_count=${meta?.anchor_count}; empty=${empty === null ? 'null' : 'not-null'}.`,
    `meta=${JSON.stringify(meta)}; empty=${JSON.stringify(empty)}.`,
  );
}

async function checkExtractAddedIdsContract(): Promise<CheckResult> {
  // Wire-format guard: mem0 v3 has two return shapes (we've seen drift in
  // the past). extractAddedIds should accept both and only return ADD.
  const fromWrapped = extractAddedIds({
    results: [
      { id: '11111111-1111-4111-8111-111111111111', event: 'ADD' },
      { id: '22222222-2222-4222-8222-222222222222', event: 'UPDATE' },
      { id: '33333333-3333-4333-8333-333333333333', event: 'NONE' },
    ],
  });
  const fromBare = extractAddedIds({
    // shouldn't crash on a bare array — extractAddedIds currently only
    // accepts the wrapped shape, so this should yield [].
    results: undefined,
  });
  const onlyAdds = fromWrapped.length === 1 && fromWrapped[0].startsWith('11111111');
  return check(
    onlyAdds && fromBare.length === 0,
    'extractAddedIds returns only ADD-event ids from wrapped mem0 results.',
    `wrapped→${fromWrapped.length} id(s), bare-undefined→${fromBare.length} id(s).`,
    `wrapped=${JSON.stringify(fromWrapped)}; bare=${JSON.stringify(fromBare)}.`,
  );
}

/* ──────────────────────────────────────────────────────────────────────── */

async function checkFeedbackRecordedOnEdit(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const original = `${PREFIX_BASE}/feedback-edit-orig ${_state.runId} ${Date.now()}`;
  const added = await client.add(original, {
    userId: _state.userAId,
    metadata: { kind: 'project', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  }) as { results?: Array<{ id: string }> };
  const id = (added.results ?? [])[0]?.id ?? '';
  const { recordFeedback } = await import('../feedback');
  await recordFeedback({
    memId: id || 'unknown',
    userId: _state.userAId,
    action: 'edit',
    kind: 'project',
    priorText: original,
    newText: `${original} REVISED`,
  });
  const { sql } = getOrgPg();
  const rows = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
      FROM harness_shared.memory_feedback
     WHERE user_id = ${_state.userAId}
       AND action = 'edit'
       AND created_at > now() - interval '5 minutes'
  `;
  return check(
    rows[0].n > 0,
    'memory_feedback row inserted after edit.',
    `Found ${rows[0].n} recent edit row(s).`,
    'No edit rows surfaced in the last 5 minutes — feedback recorder broken.',
  );
}

async function checkPerformanceSearch(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  // Ensure at least one entry so search has something to do.
  await client.add(uniqueFact(_state.runId, 'perf-seed', `latency-seed-${Date.now()}`), {
    userId: _state.userAId,
    metadata: { kind: 'project', test_tag: PREFIX_BASE, workspace_id: _state.workspaceId },
  });
  const timings: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const t0 = performance.now();
    await client.search(`perf probe ${i}`, { userId: _state.userAId, limit: 3 });
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length / 2)];
  const p95 = timings[Math.floor(timings.length * 0.95) - 1] ?? timings[timings.length - 1];
  const details = [`p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms n=${timings.length}`];
  if (p50 < 200) return pass(`Search p50 ${p50.toFixed(0)}ms (budget 200ms).`, details);
  if (p50 < 500) return warn('Search p50 < 200ms (relaxed budget 500ms).', `Search p50 ${p50.toFixed(0)}ms.`, details);
  if (p50 < 2000) return warn('Search p50 < 500ms.', `Search p50 ${p50.toFixed(0)}ms — investigate.`, details);
  return fail('Search p50 < 2000ms.', `Search p50 ${p50.toFixed(0)}ms — embedder degraded.`, details);
}

async function checkPerformanceInjection(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const client = await getMemoryClient();
  if (!client) return skip('mem0 unavailable.');
  const timings: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = performance.now();
    await buildMemoryContextBlock({
      userId: _state.userAId,
      workspaceId: _state.workspaceId,
      queryContext: `perf injection probe ${i}`,
      limit: 6,
    });
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length / 2)];
  const details = [`p50=${p50.toFixed(0)}ms n=${timings.length}`];
  if (p50 < 500) return pass(`Injection p50 ${p50.toFixed(0)}ms (budget 500ms).`, details);
  if (p50 < 1500) return warn('Injection p50 < 500ms.', `Injection p50 ${p50.toFixed(0)}ms.`, details);
  return fail('Injection p50 < 1500ms.', `Injection p50 ${p50.toFixed(0)}ms.`, details);
}

async function checkLearningInstructions(): Promise<CheckResult> {
  const { buildLearningInstructions } = await import('../learning');
  const result = await buildLearningInstructions();
  // Either null (no signal yet) or a non-empty string.
  if (result === null) {
    return pass('No signal-floor breach yet — buildLearningInstructions returned null (correct default).');
  }
  return check(
    typeof result === 'string' && result.length > 0,
    'buildLearningInstructions returns null or a non-empty string.',
    `Got string of length ${result.length}.`,
    `Got an unexpected value: ${typeof result}.`,
  );
}

async function checkCleanupSweep(): Promise<CheckResult> {
  if (!_state) return fail('Suite state present.', 'Setup did not run.');
  const purged = await deleteSuiteEntries(PREFIX_BASE);
  return pass(`Cleaned up ${purged} __memtest__ entries.`);
}

// ─── Entry point ──────────────────────────────────────────────────────

export interface MemorySuiteCheck {
  id: string;
  label: string;
  run: () => Promise<CheckResult>;
}

/**
 * Preflight: refuse to run when the embedder can't resolve. Returns the
 * gating message; null means OK to proceed.
 */
export async function memoryPreflight(): Promise<string | null> {
  // Force a build attempt so resolveEmbedder runs.
  invalidateMemoryClient();
  const client = await getMemoryClient();
  if (!client) {
    const mode = getResolvedMode();
    if (mode === null || mode === 'disabled') {
      return 'Embedder unavailable: set an OpenAI key at /settings/api-keys, or install @huggingface/transformers, then retry.';
    }
    return 'mem0 client could not be constructed. Check PG and credentials.';
  }
  return null;
}

export function buildMemoryCoreChecks(runId: string): MemorySuiteCheck[] {
  return [
    { id: 'setup', label: 'Suite setup', run: async () => {
      const gate = await memoryPreflight();
      if (gate) return fail('Embedder + mem0 ready.', gate);
      await setupSuite(runId);
      return pass('Synthetic users created; prior __memtest__ entries swept.');
    } },
    { id: 'connection.pgvector', label: 'pgvector extension', run: checkPgvectorExtension },
    { id: 'connection.mem0-client', label: 'mem0 client constructs', run: checkMem0Client },
    { id: 'connection.embedder-resolution', label: 'Embedder resolution', run: checkEmbedderResolution },
    { id: 'connection.anthropic-key', label: 'Anthropic/OpenAI extractor key', run: checkAnthropicKey },
    { id: 'roundtrip.remember-then-list', label: 'Round-trip: remember → list', run: checkRoundtripRememberList },
    { id: 'roundtrip.semantic-search', label: 'Round-trip: remember → semantic search', run: checkRoundtripSemanticSearch },
    { id: 'roundtrip.update', label: 'Round-trip: update content', run: checkRoundtripUpdate },
    { id: 'roundtrip.forget', label: 'Round-trip: forget removes entry', run: checkRoundtripForget },
    { id: 'anchors.extraction', label: 'Anchors: file/feature/plan/migration extracted', run: checkAnchorExtraction },
    { id: 'anchors.metadata-shape', label: 'Anchors: anchorMetadata wrapper shape', run: checkAnchorMetadataShape },
    { id: 'anchors.extract-added-ids', label: 'Anchors: extractAddedIds returns only ADD events', run: checkExtractAddedIdsContract },
    { id: 'anchors.persisted-on-write', label: 'Anchors: rows persisted to memory_anchors table', run: checkAnchorsPersistedOnWrite },
    { id: 'anchors.layer1-audit', label: 'Anchors: Layer-1 audit flips state on broken file', run: checkLayer1AuditFlipsState },
    { id: 'tenancy.per-user-isolation', label: 'Tenancy: per-user isolation', run: checkTenancyPerUserIsolation },
    { id: 'tenancy.harness-scoped', label: 'Tenancy: per-harness scoped bucket', run: checkTenancyHarnessScoped },
    { id: 'injection.relevant', label: 'Injection: relevant fact included', run: checkInjectionRelevant },
    { id: 'injection.empty-context', label: 'Injection: empty queryContext → null', run: checkInjectionEmpty },
    { id: 'injection.harness-scoped', label: 'Injection: per-harness memory surfaced', run: checkInjectionHarnessScoped },
    { id: 'injection.dedup-watermark', label: 'Injection: recently-surfaced fact deduped', run: checkInjectionDedup },
    { id: 'extraction.from-turn', label: 'Extraction: fact extracted from turn', run: checkExtractionFromTurn },
    { id: 'feedback.edit-recorded', label: 'Feedback: edit row recorded', run: checkFeedbackRecordedOnEdit },
    { id: 'feedback.learning-instructions', label: 'Feedback: learning instructions stable', run: checkLearningInstructions },
    { id: 'perf.search-p50', label: 'Performance: search p50 latency', run: checkPerformanceSearch },
    { id: 'perf.injection-p50', label: 'Performance: injection p50 latency', run: checkPerformanceInjection },
    { id: 'cleanup', label: 'Cleanup: sweep __memtest__ + drop synthetic users', run: async () => {
      const r = await checkCleanupSweep();
      await teardownSuite();
      return r;
    } },
  ];
}
