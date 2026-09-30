/**
 * spawn-child — the promote-time child-harness spawn branch
 * (promote-spawn-child-harness-2026-05-31 P-003, decisions D-001…D-005).
 *
 * When a `## Promote` wave declares `spawn_child`, `plans:promote { apply:true }`
 * routes the wave's features into a NEWLY CREATED child harness instead of
 * `target_harness`:
 *
 *   1. **Scaffold** the child via the existing execute-action path
 *      (`dispatchAction → doScaffoldHarness`) — the parent is SEALED from the
 *      promote caller's identity, never from YAML, and `detectCycleOrTooDeep`
 *      runs inside that path. D-003: own-repo-via-template only for v1
 *      (`spawn_child.template`; the `repo` URL override is surfaced as a
 *      warning until scaffold supports it).
 *   2. **Synthesize the child seed plan** (D-002): slug `<child>-seed-<date>`,
 *      goal + one item per feature + acceptance→inline VAL-* assertions, written
 *      to the CHILD's plans scope. This is what makes the features eligible —
 *      the dispatcher's frontier read gates plan-sourced features on a
 *      `op_status='started'` plan row (orchestrator-loop.ts readFrontierFeatures).
 *   3. **Import** the wave's features into the child with
 *      `source_plan_slug = <seed-slug>` and DETERMINISTIC ids
 *      (`F-<CHILD>-SEED-NNN`) so a retried promote upserts instead of
 *      duplicating (D-004 idempotency).
 *   4. **Start** the seed plan (`op_status='started'` — same write as
 *      plans:start). ⚠ RETIRED (P-071/D-063): the operational axis retires with
 *      the Mug/Kettle tier, so this step is gated by `mugKettleSystemEnabled()`
 *      and normally reports `start: 'axis_retired'` without writing.
 *
 *      That is a SUCCESS, not a partial failure. The write's live consumer is
 *      the DBOS frontier — `readFrontierFeatures` makes a plan-sourced feature
 *      dispatchable only while `COALESCE(source_plan_slug, metadata->>'source_plan')`
 *      names a plan at `op_status='started'` — i.e. exactly the dispatcher tier
 *      that retires. su SELF-SELECTION does not read that axis at all
 *      (`claimFloorsWhereSql` imposes no started-plan requirement), so the
 *      child's imported features stay claimable without the write.
 *
 * Failure model (D-004): idempotent + best-effort. Every step failure lands in
 * `warnings[]` — this module NEVER throws — and aborts the remaining steps for
 * that child, leaving it "scaffolded-but-unseeded" for a re-promote retry (the
 * scaffold is idempotent on slug; the seed write, import, and start are all
 * upserts/no-ops on retry). No hard schema deletes mid-flight.
 *
 * Side-effect seams are injected (`SpawnChildDeps`) so the orchestration is
 * unit-testable; `buildDefaultSpawnChildDeps` wires the real implementations.
 */

import { dispatchAction } from '../../execute-action';
import { resolveProject } from '../../harness-core';
import { mugKettleSystemEnabled } from '../../pot/started';
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { withPlanLock } from '../plans/with-plan-lock';
import { resolvePlanScope } from '../plans/source';
import { extractAssertions, type PlanAssertion } from '../plans/val-assertions';
import type { SpawnChild, BuiltFeature } from '../plans/promote-policy';

// ── Pure synthesis ──────────────────────────────────────────────────────────

/** D-002: the child seed plan slug — `<child-slug>-seed-<YYYY-MM-DD>`. */
export function childSeedSlug(childSlug: string, date: string): string {
  return `${childSlug}-seed-${date}`;
}

/**
 * Deterministic child feature ids: `F-<CHILD-SLUG-UPPERCASED>-SEED-NNN`.
 * Deterministic (not server-allocated F-AUTO-*) so a D-004 retry of a partially
 * failed spawn UPSERTS the same rows via /features/import instead of minting
 * duplicates. Matches the import route's FEATURE_ID_RE
 * (`^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$` — kebab slugs uppercase cleanly).
 */
export function mintChildFeatureIds(childSlug: string, count: number): string[] {
  const stem = childSlug.toUpperCase();
  return Array.from({ length: count }, (_, i) => `F-${stem}-SEED-${String(i + 1).padStart(3, '0')}`);
}

/** One markdown-safe line: collapse newlines/whitespace runs. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export interface SeedPlanItem {
  /** Seed-plan item id (P-001, P-002, … — 1:1 with the wave features). */
  itemId: string;
  /** Index into the wave's feature array this item was synthesized from. */
  featureIndex: number;
  /** Inline VAL-* ids synthesized from the feature's acceptance entries. */
  valIds: string[];
}

export interface SynthesizeSeedPlanInput {
  childSlug: string;
  seedSlug: string;
  /** `spawn_child.goal`, when declared (≤280 per schema). */
  goal?: string | undefined;
  parentPlanSlug: string;
  parentHarnessSlug: string;
  waveId: string;
  features: ReadonlyArray<BuiltFeature>;
  /** YYYY-MM-DD (injected for determinism in tests). */
  date: string;
}

export interface SynthesizedSeedPlan {
  seedSlug: string;
  title: string;
  body: string;
  items: SeedPlanItem[];
}

/**
 * Synthesize the child's minimal seed plan (D-002): frontmatter + `## Now` +
 * one `P-NNN` item per feature, each carrying its acceptance entries as inline
 * `VAL-<seed-slug>-NNN` assertion sub-bullets in the canonical
 * validation-assertion format (so `extractAssertions` round-trips them and the
 * child's validator gate sees real acceptance contracts), + a provenance note.
 *
 * Pure — same input always yields the same body/ids (the D-004 retry
 * idempotency hinges on this determinism).
 */
export function synthesizeChildSeedPlan(input: SynthesizeSeedPlanInput): SynthesizedSeedPlan {
  const title = input.goal
    ? oneLine(input.goal)
    : `Seed plan for child harness ${input.childSlug} (from ${input.parentPlanSlug} wave ${input.waveId})`;

  const items: SeedPlanItem[] = [];
  const itemLines: string[] = [];
  let valCounter = 0;
  input.features.forEach((f, i) => {
    const itemId = `P-${String(i + 1).padStart(3, '0')}`;
    const valIds: string[] = [];
    itemLines.push(`- **${itemId}** \`todo\` ${oneLine(f.title)}`);
    for (const acceptance of f.acceptance ?? []) {
      valCounter += 1;
      const valId = `VAL-${input.seedSlug}-${String(valCounter).padStart(3, '0')}`;
      valIds.push(valId);
      itemLines.push(`  - **[${valId}]**`);
      itemLines.push(`    - **Verify:** ${oneLine(acceptance)}`);
      itemLines.push(`    - **Status:** \`todo\``);
    }
    items.push({ itemId, featureIndex: i, valIds });
  });

  const body = `---
title: ${title}
slug: ${input.seedSlug}
status: active
created: ${input.date}
updated: ${input.date}
---

# ${title}

## Now

**State:** Seed plan auto-synthesized by \`plans:promote\` (spawn_child) from plan \`${input.parentPlanSlug}\` wave \`${input.waveId}\` in harness \`${input.parentHarnessSlug}\`. The wave's ${input.features.length} feature(s) were imported into this harness with this plan as their source.

**Next:** The pipeline works the imported features; items flip done as their features pass.

## Phase 1 — Seeded features

${itemLines.join('\n')}

## Provenance

Spawned by \`plans:promote\` from plan \`${input.parentPlanSlug}\` (harness \`${input.parentHarnessSlug}\`), wave \`${input.waveId}\`, on ${input.date}. The parent plan's \`## Promoted\` block records the spawn; the parent harness is sealed server-side as this harness's \`parent_slug\`.
`;

  return { seedSlug: input.seedSlug, title, body, items };
}

/**
 * The `spec` text handed to `scaffold_harness` for the child — a short
 * human-readable statement of what the child is for (goal + feature list).
 */
export function synthesizeScaffoldSpec(input: {
  goal?: string | undefined;
  parentPlanSlug: string;
  waveId: string;
  features: ReadonlyArray<BuiltFeature>;
}): string {
  const head = input.goal
    ? oneLine(input.goal)
    : `Child harness spawned from plan ${input.parentPlanSlug} wave ${input.waveId}.`;
  const bullets = input.features.map((f) => `- ${oneLine(f.title)}`).join('\n');
  return `${head}\n\n## Seeded features\n\n${bullets}\n`;
}

/** The /features/import payload row shape the child import sends. */
export interface ChildImportFeature {
  id: string;
  title: string;
  summary?: string;
  metadata: Record<string, unknown>;
  claims?: string[];
  source_plan_slug: string;
  source_plan_item_ids: string[];
  blocked_by?: string[];
  order?: number;
}

/**
 * Build the child-side /features/import payload: deterministic ids,
 * `source_plan_slug = <seed-slug>` + `metadata.source_plan = <seed-slug>` (the
 * dispatcher eligibility key), claims = the seed plan's synthesized VAL ids,
 * and `metadata.spawned_from` provenance back to the parent plan/wave.
 */
export function buildChildImportPayload(opts: {
  features: ReadonlyArray<BuiltFeature>;
  seed: SynthesizedSeedPlan;
  childFeatureIds: ReadonlyArray<string>;
  parentPlanSlug: string;
  parentHarnessSlug: string;
  waveId: string;
}): ChildImportFeature[] {
  return opts.features.map((f, i) => {
    const item = opts.seed.items[i];
    const metadata: Record<string, unknown> = {
      source_plan: opts.seed.seedSlug,
      from_plan_items: [item.itemId],
      spawned_from: {
        plan: opts.parentPlanSlug,
        wave: opts.waveId,
        parent_harness: opts.parentHarnessSlug,
      },
    };
    if (f.assigned_role) metadata.assigned_role = f.assigned_role;
    const out: ChildImportFeature = {
      id: opts.childFeatureIds[i],
      title: f.title,
      metadata,
      source_plan_slug: opts.seed.seedSlug,
      source_plan_item_ids: [item.itemId],
      ...(item.valIds.length > 0 && { claims: item.valIds }),
      ...(f.blocked_by && f.blocked_by.length > 0 && { blocked_by: f.blocked_by }),
      ...(f.order != null && { order: f.order }),
    };
    if (f.body) out.summary = f.body;
    return out;
  });
}

// ── Orchestration (injectable side-effect seams) ────────────────────────────

export interface SpawnChildOpts {
  child: SpawnChild;
  waveId: string;
  /** SEALED parent harness slug (derived server-side from the promote caller /
   *  the plan's home harness — never from YAML). */
  parentSlug: string;
  parentPlanSlug: string;
  /** The wave's features, destined for the child. */
  features: BuiltFeature[];
  /** YYYY-MM-DD; defaults to today. Injectable for deterministic tests. */
  date?: string;
}

export interface SpawnChildResult {
  child_slug: string;
  seed_plan_slug: string;
  scaffold: 'created' | 'already_existed' | 'failed' | 'skipped';
  seed_plan: 'created' | 'already_existed' | 'failed' | 'skipped';
  /** Deterministic child feature ids actually imported ([] when import skipped/failed). */
  feature_ids: string[];
  assertions_written: number;
  started: boolean;
  /**
   * P-071/D-063 — WHY `started` is what it is, so a false reading is never
   * ambiguous. `axis_retired` is the normal outcome now (the op_status axis
   * retired with the Mug/Kettle tier) and is NOT a partial failure: unlike
   * `plan_not_found`/`failed` it produces no warning and re-promoting cannot
   * change it. `skipped` means step 5 never ran (an earlier step aborted).
   */
  start: SpawnStartOutcome;
  warnings: string[];
}

/** Outcome of step 5 (start the seed plan). See `SpawnChildResult.start`. */
export type SpawnStartOutcome =
  | 'started'
  | 'plan_not_found'
  | 'axis_retired'
  | 'failed'
  | 'skipped';

/**
 * Human-facing clause for a promote report / plan_event detail — the reason
 * `start` exists. It reads as a trailing clause: `child (plan p, 3 feature(s)<here>)`.
 * `axis_retired` says what happened AND that nothing is owed, because the
 * report's other falsy states all mean "re-promote to retry".
 */
export function describeSpawnStart(start: SpawnStartOutcome): string {
  switch (start) {
    case 'started':
      return ', started';
    case 'axis_retired':
      return ', not started — the plan operational axis is retired (features are claimable as-is)';
    case 'plan_not_found':
      return ', NOT started — no seed-plan row matched';
    case 'failed':
      return ', NOT started — the start call failed';
    case 'skipped':
      return '';
  }
}

export interface SpawnChildDeps {
  /** Is the child slug already a registered harness? */
  resolveChild(slug: string): Promise<boolean>;
  /** Scaffold the child via the execute-action path (sealed parent + cycle check inside). */
  scaffold(
    parentSlug: string,
    child: SpawnChild,
    spec: string,
  ): Promise<{ ok: true } | { ok: false; error: string; detail?: string }>;
  /** Create the seed plan in the CHILD's plans scope (no-op when it already exists). */
  writeSeedPlan(
    childSlug: string,
    seedSlug: string,
    body: string,
  ): Promise<'created' | 'already_existed' | 'busy'>;
  /** POST the payload to the child's /features/import. */
  importFeatures(
    childSlug: string,
    payload: ChildImportFeature[],
  ): Promise<{ ids: string[]; inserted: number; updated: number }>;
  /** Upsert the seed plan's VAL-* rows into harness_plan_assertions (child scope). */
  writeAssertions(
    childSlug: string,
    seedSlug: string,
    assertions: PlanAssertion[],
  ): Promise<{ written: number; errors: string[] }>;
  /**
   * plans:start equivalent — op_status='started' on the seed plan row.
   *
   * P-071/D-063: returns an OUTCOME, not a boolean, because the three falsy
   * cases mean different things to the caller — `plan_not_found` is a real
   * partial failure worth a re-promote, `axis_retired` is the expected steady
   * state and must NOT be reported as one.
   */
  startPlan(childSlug: string, seedSlug: string): Promise<Exclude<SpawnStartOutcome, 'failed' | 'skipped'>>;
}

/**
 * Run the spawn sequence for ONE child wave: scaffold → synth+write seed plan →
 * import features → write assertions → start. Never throws (D-004) — every
 * failure is a `warnings[]` entry, and a step failure aborts the LATER steps so
 * a re-promote can resume from the partial state.
 */
export async function executeSpawnChild(
  opts: SpawnChildOpts,
  deps: SpawnChildDeps,
): Promise<SpawnChildResult> {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const seedSlug = childSeedSlug(opts.child.slug, date);
  const result: SpawnChildResult = {
    child_slug: opts.child.slug,
    seed_plan_slug: seedSlug,
    scaffold: 'skipped',
    seed_plan: 'skipped',
    feature_ids: [],
    assertions_written: 0,
    started: false,
    start: 'skipped',
    warnings: [],
  };
  const warn = (m: string) => result.warnings.push(`spawn_child ${opts.child.slug}: ${m}`);

  // D-003 v1 is templates-only: a `repo` URL override is declared in the schema
  // but the scaffold path can't honor it yet — surface, don't silently drop.
  if (opts.child.repo) {
    warn(`repo override '${opts.child.repo}' is not yet supported by scaffold_harness (D-003 v1 is template-only); the template's repo is used`);
  }

  // ── 1. Scaffold (idempotent on slug) ──────────────────────────────────────
  try {
    const exists = await deps.resolveChild(opts.child.slug);
    if (exists) {
      result.scaffold = 'already_existed';
    } else if (!opts.child.template) {
      warn('no spawn_child.template declared and the harness does not exist — D-003 v1 scaffolds from a spawnable template only. Add `template:` (or scaffold the harness yourself) and re-promote.');
      return result;
    } else {
      const spec = synthesizeScaffoldSpec({
        goal: opts.child.goal,
        parentPlanSlug: opts.parentPlanSlug,
        waveId: opts.waveId,
        features: opts.features,
      });
      const r = await deps.scaffold(opts.parentSlug, opts.child, spec);
      if (r.ok) {
        result.scaffold = 'created';
      } else if (r.error === 'slug_already_in_use' && (await deps.resolveChild(opts.child.slug))) {
        // Lost a race / D-004 retry of a partially-spawned child — proceed.
        result.scaffold = 'already_existed';
        warn('harness already existed (idempotent retry); proceeding to seed it');
      } else {
        result.scaffold = 'failed';
        warn(`scaffold failed (${r.error}${r.detail ? `: ${r.detail}` : ''}) — nothing was seeded; fix and re-promote`);
        return result;
      }
    }
  } catch (e) {
    result.scaffold = 'failed';
    warn(`scaffold threw: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // ── 2. Synthesize + write the seed plan into the CHILD's plans scope ─────
  const seed = synthesizeChildSeedPlan({
    childSlug: opts.child.slug,
    seedSlug,
    goal: opts.child.goal,
    parentPlanSlug: opts.parentPlanSlug,
    parentHarnessSlug: opts.parentSlug,
    waveId: opts.waveId,
    features: opts.features,
    date,
  });
  try {
    const w = await deps.writeSeedPlan(opts.child.slug, seedSlug, seed.body);
    if (w === 'busy') {
      result.seed_plan = 'failed';
      warn('seed plan write was locked by another writer — child left scaffolded-but-unseeded; re-promote to retry');
      return result;
    }
    result.seed_plan = w;
  } catch (e) {
    result.seed_plan = 'failed';
    warn(`seed plan write failed: ${e instanceof Error ? e.message : String(e)} — child left scaffolded-but-unseeded; re-promote to retry`);
    return result;
  }

  // ── 3. Assertions, BEFORE the import (P-003, D-002/D-005) ────────────────
  // The child's features carry the seed plan's synthesized VAL-* ids as `claims`
  // (buildChildImportPayload), and a claim is only resolvable through
  // harness_shared.harness_plan_assertions — a DIFFERENT datastore from the child
  // harness DB that `importFeatures` writes. No transaction spans both, so step
  // ORDER is the only integrity boundary available. Running this AFTER the import
  // (the previous order, explicitly best-effort) left the child durably carrying
  // claim ids with no assertion row whenever the store failed, and said so only in
  // a warning: /assertion/:valId then resolves nothing and harness-test-gate cannot
  // approve the required test those claims exist to demand.
  //
  // Persisting first makes the surviving failure mode ORPHAN ROWS — nothing
  // references them, the upsert is idempotent, and the next promote re-converges.
  const assertions = extractAssertions(seed.body);
  if (assertions.length > 0) {
    const abort = (detail: string) => {
      warn(
        `${detail} — features were NOT imported rather than carry claim ids with no assertion row; ` +
          `seed plan exists but carries no features, re-promote to retry (the assertion upsert is idempotent)`,
      );
      return result;
    };
    try {
      const a = await deps.writeAssertions(opts.child.slug, seedSlug, assertions);
      result.assertions_written = a.written;
      for (const err of a.errors) warn(`assertion write: ${err}`);
      if (a.errors.length > 0) {
        return abort(`${a.errors.length} of ${assertions.length} assertion row(s) failed to persist`);
      }
    } catch (e) {
      return abort(`assertion store threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 4. Import the wave's features into the child ──────────────────────────
  const childIds = mintChildFeatureIds(opts.child.slug, opts.features.length);
  const payload = buildChildImportPayload({
    features: opts.features,
    seed,
    childFeatureIds: childIds,
    parentPlanSlug: opts.parentPlanSlug,
    parentHarnessSlug: opts.parentSlug,
    waveId: opts.waveId,
  });
  try {
    const importRes = await deps.importFeatures(opts.child.slug, payload);
    result.feature_ids = importRes.ids.length > 0 ? importRes.ids : childIds;
  } catch (e) {
    warn(`feature import failed: ${e instanceof Error ? e.message : String(e)} — seed plan exists but carries no features; re-promote to retry`);
    return result;
  }

  // ── 5. Start the seed plan (the RETIRED dispatcher eligibility gate) ─────
  // P-071/D-063: `startPlan` is gated on mugKettleSystemEnabled and normally
  // refuses. Each falsy case gets its OWN outcome because they need opposite
  // reactions from the reader: `plan_not_found` means the seed row is missing
  // and a re-promote can fix it; `axis_retired` means nothing is wrong and a
  // re-promote would change nothing. Collapsing both into `started:false` is
  // what made the old warning below misleading.
  try {
    const outcome = await deps.startPlan(opts.child.slug, seedSlug);
    result.start = outcome;
    result.started = outcome === 'started';
    if (outcome === 'plan_not_found') {
      warn('plans:start matched no seed-plan row — features stay ineligible until the plan is started; re-promote to retry');
    }
    // 'axis_retired' is deliberately WARNING-FREE: nothing failed, the child's
    // features remain su-claimable without the write, and this module's warnings
    // are read as "re-promote to retry" — which would change nothing here.
  } catch (e) {
    result.start = 'failed';
    warn(`plans:start failed: ${e instanceof Error ? e.message : String(e)} — start the seed plan manually or re-promote`);
  }

  return result;
}

// ── Default (real) deps ─────────────────────────────────────────────────────

/**
 * Real side-effect implementations. `importFeatures` is injected by the caller
 * (plans:promote passes its own loopback /features/import poster) so this
 * module stays free of the HTTP loopback dependency.
 */
export function buildDefaultSpawnChildDeps(io: {
  importFeatures: SpawnChildDeps['importFeatures'];
}): SpawnChildDeps {
  return {
    async resolveChild(slug) {
      try {
        return Boolean(await resolveProject(slug));
      } catch {
        return false;
      }
    },

    async scaffold(parentSlug, child, spec) {
      // The existing execute-action path: doScaffoldHarness seals
      // `parent_slug` from callerSlug (server-derived — body-supplied
      // parent_slug is rejected upstream) and runs detectCycleOrTooDeep.
      const r = await dispatchAction(parentSlug, {
        op: 'scaffold_harness',
        projectSlug: child.slug,
        template: child.template ?? '',
        spec,
      });
      if (r.ok) return { ok: true };
      return { ok: false, error: r.error ?? 'internal', ...(r.detail && { detail: r.detail }) };
    },

    async writeSeedPlan(childSlug, seedSlug, body) {
      const r = await withPlanLock<'created' | 'already_existed'>(
        null,
        { slug: seedSlug, harnessSlug: childSlug, intent: `plans:promote spawn_child → seed plan ${seedSlug}` },
        async (current) => {
          if (current !== null) return { newBody: null, value: 'already_existed' as const };
          return { newBody: body, value: 'created' as const };
        },
      );
      if (r.kind === 'busy') return 'busy';
      return r.value;
    },

    importFeatures: io.importFeatures,

    async writeAssertions(childSlug, seedSlug, assertions) {
      const { workspaceId } = await resolvePlanScope({ harnessSlug: childSlug });
      const { sql } = getOrgPg();
      let written = 0;
      const errors: string[] = [];
      for (const a of assertions) {
        try {
          await sql`
            INSERT INTO harness_shared.harness_plan_assertions
              (workspace_id, harness_slug, val_id, plan_slug, item_id, verify_text, evidence_text, status, requires_test)
            VALUES
              (${workspaceId}, ${childSlug}, ${a.valId}, ${seedSlug}, ${a.itemId},
               ${a.verifyText}, ${a.evidenceText}, ${a.status}, ${a.requiresTest})
            ON CONFLICT (workspace_id, harness_slug, val_id) DO UPDATE SET
              plan_slug     = EXCLUDED.plan_slug,
              item_id       = EXCLUDED.item_id,
              verify_text   = EXCLUDED.verify_text,
              evidence_text = EXCLUDED.evidence_text,
              requires_test = EXCLUDED.requires_test,
              updated_at    = now()
          `;
          written++;
        } catch (e) {
          errors.push(`${a.valId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return { written, errors };
    },

    async startPlan(childSlug, seedSlug) {
      // P-071 / D-063: the op_status axis retires with the Mug/Kettle tier, so
      // this write is gated exactly as plans:start is (start.ts) — fail-CLOSED
      // via mugKettleSystemEnabled, because a false `true` puts a brand-new
      // child's seed plan back on the axis whose only live reader is the DBOS
      // frontier's plan gate (orchestrator-loop.ts readFrontierFeatures), the
      // dispatcher tier that is retiring. Refusing BEFORE resolvePlanScope keeps
      // the retired path free of the DB round-trip entirely.
      if (!(await mugKettleSystemEnabled())) return 'axis_retired';

      // Same write as plans:start (start.ts): op_status='started' on the seed
      // plan's harness_plans row, in the CHILD's resolved workspace (the scope
      // withPlanLock inserted the row under).
      const { workspaceId } = await resolvePlanScope({ harnessSlug: childSlug });
      const now = new Date().toISOString();
      const rows = await withWorkspace(workspaceId, async (tx) => {
        return tx<{ op_status: string }[]>`
          UPDATE harness_shared.harness_plans
             SET op_status     = 'started',
                 op_started_at = COALESCE(op_started_at, ${now}),
                 op_updated_at = ${now}
           WHERE workspace_id = ${workspaceId}
             AND harness_slug = ${childSlug}
             AND plan_slug    = ${seedSlug}
          RETURNING op_status
        `;
      });
      return rows.length > 0 ? 'started' : 'plan_not_found';
    },
  };
}
