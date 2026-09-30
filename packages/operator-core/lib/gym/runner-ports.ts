/**
 * Real GymRunnerPorts adapter (P-001 wiring) — binds the smoke-PROVEN operations into
 * the GymRunnerPorts interface that the tested runGymPipeline orchestration consumes.
 *
 *   cloneSubstrate          → git clone + checkout --detach (execFile, no shell)
 *   registerThrowawayHarness→ POST /api/harness/projects (scaffolds harness_<slug>)
 *   applyPromptOverride     → gym-PG upsert harness_shared.harness_prompt_overrides
 *   fileFeature             → gym-PG insert harness_features_consolidated (avoids the
 *                              legacy SQLite /features/import path)
 *   startPipeline           → POST /api/admin/dbos/pipeline/start?superuser=1 + bearer
 *   pollStatus              → gym-PG dbos.workflow_status + harness_features_consolidated
 *   teardownHarness         → gym-PG DROP SCHEMA + clear overrides + rm clone
 *
 * I/O is injectable (fetch/exec/rm default to real) so the HTTP + exec ports are unit-
 * testable; the gym-PG ports are validated by the boot smoke / P-014. NOTE: gym-PG
 * jsonb reads come back as strings (none read here). Slugs are gym-prefixed hyphen-free
 * → safe to splice into the DROP SCHEMA identifier.
 */
import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, rm as rmCb, unlinkSync } from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { buildSubstrateCloneCommands } from './clone';
import type { GymRunnerPorts } from './gym-runner';
import type { TestResult } from './signals';

const execFileP = promisify(execFileCb);
const rmP = promisify(rmCb);

const SAFE_SLUG = /^[a-z0-9]+$/;

/** Parse one Vitest JSON report into the per-test evidence the gym signal core consumes. */
export function parseVitestOracleResults(jsonText: string): TestResult[] {
  let parsed: { testResults?: Array<{ assertionResults?: Array<{ status?: string; fullName?: string; title?: string }> }> };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    return [];
  }
  const out: TestResult[] = [];
  for (const file of Array.isArray(parsed.testResults) ? parsed.testResults : []) {
    for (const assertion of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      const name = (assertion.fullName ?? assertion.title ?? '').trim();
      if (!name) continue;
      if (assertion.status === 'passed') out.push({ name, passed: true });
      else if (assertion.status === 'failed') out.push({ name, passed: false });
    }
  }
  return out;
}

/**
 * Capabilities the gym pipeline's spawned roles need on the EPHEMERAL gym-operator.
 *
 * Pipeline roles carry no `system_principals` row and no `BLUEPRINT_ROLE_CAPS`
 * entry, so `loadRoleCapabilities` resolves them to an EMPTY set — deliberate
 * least-privilege on the LIVE operator (role-principal-caps.ts), but fatal in the
 * gym: the worker's session runs with the native Write/Edit/Bash tools disabled,
 * so the capability-gated MCP mutation tools are its ONLY write path, and with
 * zero caps every gym run dead-ends as `escalated` with an empty diff (100% of
 * runs 2026-07-20 → 2026-07-26; the workers' own escalation reports name exactly
 * these missing caps). The gym DB is ephemeral and per-cycle, so seeding here is
 * scoped: the LIVE operator's worker principals stay empty-cap.
 */
export const GYM_PIPELINE_ROLE_CAPS: Readonly<Record<string, readonly string[]>> = {
  // The implementation agent — edits + runs tests in its throwaway clone, and must
  // be able to escalate / file an improvement when it cannot (its only failure
  // channel). code-inspect (capability:inspect = typecheck/test) and
  // artifacts:write (durable PG notes) come from the worker's own denial table
  // in the 2026-07-26 escalation transcripts.
  worker: [
    'capability:fs-read',
    'capability:fs-write',
    'capability:bash',
    'capability:git',
    'capability:code-inspect',
    'artifacts:write',
    'coord:read',
    'coord:write',
    'locks:read',
    'locks:write',
  ],
  // Runs the repo's own tests against the worker's change — execute + read, no fs-write.
  validator: [
    'capability:fs-read',
    'capability:bash',
    'capability:git',
    'capability:code-inspect',
    'coord:read',
    'coord:write',
  ],
  // Reads the clone to plan chunks (native reads suffice today); coord for escalation parity.
  scoper: ['capability:fs-read', 'coord:read', 'coord:write'],
};

/**
 * Idempotently seed the gym pipeline-role principals into the gym PG so the
 * ephemeral operator resolves them. bearer_hash is a random unmatchable value —
 * pipeline roles authenticate via signed role URLs, never bearers. Capabilities
 * reconcile to the code set on conflict (the gym DB is per-cycle; conflict only
 * occurs on same-stack replays).
 *
 * SEEDED UNDER EVERY PLAUSIBLE WORKSPACE ID, not just the ephemeral one: the
 * first fix seeded only cfg.workspaceId ('gym-loop-ws') and the workers STILL
 * dispatched with empty caps — their agent_tools:list saw the caps (catalog
 * resolves via the pinned request workspace) while the dispatch principal,
 * synthesized from the spawn URL's BAKED workspace claim, resolved a different
 * workspace_id and found nothing (2026-07-26 cycle a6a9cd21, all runs
 * escalated). The gym DB is throwaway, so blanket-seeding the handful of ids
 * the stack can bake (ephemeral + durable + the host's 'default' home) is
 * zero-blast-radius and robust to which one the claim carries.
 */
export async function ensureGymPipelinePrincipals(sql: Sql, workspaceIds: readonly string[]): Promise<void> {
  const ids = [...new Set(workspaceIds.filter((w) => w.length > 0))];
  for (const workspaceId of ids) {
    for (const [name, caps] of Object.entries(GYM_PIPELINE_ROLE_CAPS)) {
      // ⚠ sql.json, NOT `${JSON.stringify(...)}::jsonb`: postgres-js serializes a
      // JS string param as a JSON STRING value, so the stringify idiom lands a
      // double-encoded scalar ('"[...]"') — loadRoleCapabilities' Array.isArray
      // then reads it as EMPTY caps. This exact bug made seeds #1/#2 inert
      // across gym cycles 2026-07-26 (proven against cycle #4's live DB).
      await sql`
        INSERT INTO harness_shared.system_principals (workspace_id, name, bearer_hash, capabilities)
        VALUES (${workspaceId}, ${name}, ${randomBytes(32).toString('hex')}, ${sql.json([...caps])})
        ON CONFLICT (workspace_id, name) DO UPDATE SET capabilities = EXCLUDED.capabilities`;
    }
  }
}

export interface GymRunnerPortsConfig {
  /** Base URL of the dedicated gym-operator, e.g. http://127.0.0.1:3971. */
  operatorBaseUrl: string;
  /** A postgres-js client connected to the gym PG. */
  gymSql: Sql;
  /** Superuser bearer (from ~/.papercusp/superuser-token) for the admin route. */
  superuserToken: string;
  /** The gym operator's pinned workspace (used to scope filed features). */
  workspaceId: string;
  /** Extra workspace ids to seed the pipeline-role principals under (the durable
   *  workspace + 'default'), on top of workspaceId — see ensureGymPipelinePrincipals. */
  principalSeedWorkspaceIds?: readonly string[];
  fetchFn?: typeof fetch;
  exec?: (cmd: string, args: string[]) => Promise<void>;
  execCapture?: (
    cmd: string,
    args: string[],
    options: { cwd: string; timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  rm?: (path: string) => Promise<void>;
}

export function createGymRunnerPorts(cfg: GymRunnerPortsConfig): GymRunnerPorts {
  const doFetch = cfg.fetchFn ?? fetch;
  const exec = cfg.exec ?? (async (cmd: string, args: string[]) => { await execFileP(cmd, args); });
  const execCapture =
    cfg.execCapture ??
    (async (cmd: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number }) =>
      (await execFileP(cmd, args, options)) as { stdout: string; stderr: string });
  const rm = cfg.rm ?? (async (p: string) => { await rmP(p, { recursive: true, force: true }); });
  const sql = cfg.gymSql;

  return {
    async cloneSubstrate({ source, commit, destDir }) {
      const { commands } = buildSubstrateCloneCommands({ source, commit, destDir });
      for (const c of commands) await exec(c.argv[0], c.argv.slice(1));
    },

    async registerThrowawayHarness({ slug, clonePath }) {
      // Every gym entrypoint registers its throwaway harness through this port, so
      // seeding here (cheap idempotent upsert) fixes the zero-capability worker for
      // ALL gym paths — see GYM_PIPELINE_ROLE_CAPS above for why the seed exists
      // and why it spans multiple workspace ids.
      await ensureGymPipelinePrincipals(sql, [
        cfg.workspaceId,
        ...(cfg.principalSeedWorkspaceIds ?? []),
        'default',
      ]);
      const res = await doFetch(`${cfg.operatorBaseUrl}/api/harness/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, path: clonePath }),
      });
      if (res.status === 409) {
        // WI-2604 / EI-7196: gym slugs are DETERMINISTIC (run-identity.ts's gymRunIdentity
        // — same (task×variant×cycle×repeat) always resolves to the same slug, on purpose,
        // for idempotent DBOS replay). Nothing tears the throwaway harness project entry
        // down after a run COMPLETES (only a setup failure does), so a later run/replay of
        // the SAME key hits a live "slug already exists" 409 and the whole cycle fails.
        //
        // EI-7196 — the clone lives under a FRESH `mkdtemp` scratch root per fire
        // (autoloop-cycle.ts), so the absolute clonePath legitimately CHANGES every run
        // even though the slug is stable. WI-2604's original strict `existing.path ===
        // clonePath` guard therefore NEVER matched a real replay (prior run's random
        // `/tmp/gym-loop-AAA/<slug>` ≠ this run's `/tmp/gym-loop-BBB/<slug>`) and threw on
        // every subsequent fire — the CHRONIC autoloop red. Compare the path BASENAME
        // instead: the clone dir is always named after the slug (cloneDirName ===
        // harnessSlug), so a genuine same-throwaway replay matches under any scratch root,
        // while an unrelated real slug collision (a non-throwaway harness whose dir isn't
        // named after the slug) still surfaces loudly.
        const existing = await doFetch(`${cfg.operatorBaseUrl}/api/harness/projects`);
        if (existing.ok) {
          const body = (await existing.json().catch(() => ({}))) as { projects?: Array<{ slug: string; path: string }> };
          const match = body.projects?.find((p) => p.slug === slug);
          if (match && basename(match.path) === basename(clonePath)) return; // idempotent re-registration — same throwaway (clone dir named after the slug), scratch root varies per run
        }
        throw new Error(`registerThrowawayHarness ${slug} → 409: slug already exists at a path whose basename differs from ${clonePath} (real collision, not idempotent replay)`);
      }
      if (!res.ok) throw new Error(`registerThrowawayHarness ${slug} → ${res.status}: ${await res.text()}`);
      // The route returns HTTP 200 even when scaffoldHarnessSchema() throws — it
      // reports the failure as `provisioning:{ok:false,error}`. A swallowed scaffold
      // failure means the per-harness `harness_features` VIEW is never created, and
      // the worker's `UPDATE harness_features` 42P01s deep in the pipeline. Fail loud
      // HERE so the gym surfaces the real cause at registration, not as a mystery
      // mid-run error. (Missing/true `provisioning` → success: non-scaffold paths.)
      const body = (await res.json().catch(() => ({}))) as { provisioning?: { ok?: boolean; error?: string } };
      if (body.provisioning && body.provisioning.ok === false) {
        throw new Error(`registerThrowawayHarness ${slug}: schema scaffold failed: ${body.provisioning.error ?? 'unknown error'}`);
      }
    },

    async applyPromptOverride({ workspaceId, slug, role, promptMd }) {
      await sql`
        INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
        VALUES (${workspaceId}, ${slug}, ${role}, ${promptMd}, ${Date.now()})
        ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
          SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at`;
    },

    async fileFeature({ slug, featureId, spec }) {
      await sql`
        INSERT INTO harness_shared.work_items (harness_slug, feature_id, workspace_id, title, status, summary)
        VALUES (${slug}, ${featureId}, ${cfg.workspaceId}, ${featureId}, ${'todo'}, ${spec})
        ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    },

    async startPipeline({ slug, featureId }) {
      const res = await doFetch(`${cfg.operatorBaseUrl}/api/admin/dbos/pipeline/start?superuser=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.superuserToken}` },
        body: JSON.stringify({ harnessSlug: slug, featureId }),
      });
      if (!res.ok) throw new Error(`startPipeline ${slug}/${featureId} → ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { workflowID?: string };
      if (!body.workflowID) throw new Error(`startPipeline returned no workflowID`);
      return { workflowID: body.workflowID };
    },

    async pollStatus({ workflowID, slug, featureId }) {
      const wf = await sql<{ status: string }[]>`
        SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowID} LIMIT 1`;
      const feat = await sql<{ status: string }[]>`
        SELECT status FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = ${slug} AND feature_id = ${featureId} LIMIT 1`;
      return { workflowStatus: wf[0]?.status ?? 'PENDING', featureStatus: feat[0]?.status ?? null };
    },

    async runOracle({ clonePath, testPath }) {
      const reportPath = `${tmpdir()}/papercusp-gym-oracle-${randomBytes(12).toString('hex')}.json`;
      try {
        await execCapture(
          'npm',
          ['run', 'test:file', '--', testPath, '--', '--reporter=json', `--outputFile=${reportPath}`],
          { cwd: clonePath, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
        );
      } catch {
        // A failing oracle still writes a JSON report; parse it below. If it did
        // not, the caller records deterministic evidence as not measured.
      }
      try {
        return parseVitestOracleResults(readFileSync(reportPath, 'utf8'));
      } catch {
        return undefined;
      } finally {
        try { unlinkSync(reportPath); } catch { /* best effort */ }
      }
    },

    async teardownHarness({ slug, clonePath, workspaceId }) {
      if (SAFE_SLUG.test(slug)) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS harness_${slug} CASCADE`).catch(() => {});
      }
      await sql`DELETE FROM harness_shared.harness_prompt_overrides WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug}`.catch(() => {});
      await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${slug}`.catch(() => {});
      await rm(clonePath).catch(() => {});
      // EI-484: deregister the throwaway harness project entry too — without this,
      // the /api/harness/projects registration OUTLIVES the schema/clone teardown
      // above. registerThrowawayHarness's 409 idempotency check (WI-2604/EI-7196)
      // then basename-matches the STALE registration on the next replay of this
      // deterministic slug and short-circuits as "already registered", skipping
      // real re-registration — so the pipeline hits `relation ... does not exist`
      // (42P01) against the schema this very call just dropped. Best-effort +
      // fire-and-forget like the deletes above: a setup-failure teardown must
      // never itself throw and mask the original error.
      await doFetch(`${cfg.operatorBaseUrl}/api/harness/projects/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      }).catch(() => {});
    },

    now: () => Date.now(),
    sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  };
}
