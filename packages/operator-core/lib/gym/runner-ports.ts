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
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rm as rmCb, rmSync, unlinkSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Sql } from 'postgres';
import { buildSubstrateCloneCommands, isPinnedCommit } from './clone';
import type { GymOracleRun, GymRunnerPorts } from './gym-runner';
import type { TestResult } from './signals';

const execFileP = promisify(execFileCb);
const rmP = promisify(rmCb);

const SAFE_SLUG = /^[a-z0-9]+$/;

/** Parse one Vitest JSON report into the per-test evidence the gym signal core consumes. */
export function parseVitestOracleResults(jsonText: string): TestResult[] {
  let parsed: { testResults?: Array<{ name?: string; status?: string; assertionResults?: Array<{ status?: string; fullName?: string; title?: string }> }> };
  try {
    parsed = JSON.parse(jsonText) as typeof parsed;
  } catch {
    return [];
  }
  const out: TestResult[] = [];
  for (const file of Array.isArray(parsed?.testResults) ? parsed.testResults : []) {
    if (!Array.isArray(file?.assertionResults) || file.assertionResults.length === 0) {
      // Collection/setup errors are not an empty passing test population.
      out.push({ name: '', passed: false, executed: false, ...(file?.name ? { file: file.name } : {}) });
      continue;
    }
    for (const assertion of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      const name = (assertion.fullName ?? assertion.title ?? '').trim();
      const fileIdentity = file.name ? { file: file.name } : {};
      if (assertion.status === 'passed' || assertion.status === 'failed') {
        out.push({ name, passed: assertion.status === 'passed', ...fileIdentity });
      } else {
        out.push({ name, passed: false, executed: false, ...fileIdentity });
      }
    }
    // Vitest's file status includes hook/setup errors that need not correspond
    // to a failed assertion. Keep that gap even when the assertions passed.
    if (file.status === 'failed' && !file.assertionResults.some((t) => t.status === 'failed')) {
      out.push({ name: '', passed: false, executed: false, ...(file.name ? { file: file.name } : {}) });
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
    options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  rm?: (path: string) => Promise<void>;
}

export function createGymRunnerPorts(cfg: GymRunnerPortsConfig): GymRunnerPorts {
  const doFetch = cfg.fetchFn ?? fetch;
  const exec = cfg.exec ?? (async (cmd: string, args: string[]) => { await execFileP(cmd, args); });
  const execCapture =
    cfg.execCapture ??
    (async (cmd: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) =>
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

    async runOracle({ clonePath, testPath, pinCommit, implPath }) {
      // Keep the old standalone result shape when no oracle pin was requested.
      // The runner always requests a pin and requires this actual IO receipt.
      const safeRepoPath = (path: string): boolean => path.length > 0 && !isAbsolute(path) &&
        !path.split('/').some((part) => part === '..' || part === '.') && !path.includes('\\');
      const fileHash = (path: string): string | null => {
        if (!safeRepoPath(path)) return null;
        try { return createHash('sha256').update(readFileSync(join(clonePath, path))).digest('hex'); }
        catch { return null; }
      };
      const referenceHash = async (path: string): Promise<string | null> => {
        if (!pinCommit || !isPinnedCommit(pinCommit) || !safeRepoPath(path)) return null;
        try {
          const blob = await execCapture('git', ['show', `${pinCommit}:${path}`],
            { cwd: clonePath, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
          return createHash('sha256').update(blob.stdout).digest('hex');
        } catch { return null; } // unavailable immutable source stays unknown
      };
      const pinned = await referenceHash(testPath);
      const manifestPinned = await referenceHash('package.json');
      const manifestBefore = fileHash('package.json');
      const before = fileHash(testPath);
      const implementationBefore = implPath ? fileHash(implPath) : null;
      const reportPath = `${tmpdir()}/papercusp-gym-oracle-${randomBytes(12).toString('hex')}.json`;
      const sourceReportPath = `${reportPath}.sources.json`;
      const loaderReportPath = `${sourceReportPath}.committed-loads.jsonl`;
      const sourceReporter = join(clonePath, 'libs/test-config/src/executed-source-map-reporter.ts');
      const hasSourceReporter = existsSync(sourceReporter);
      const configLoadCapture = join(clonePath, 'libs/test-config/src/executed-config-load-capture.ts');
      const hasConfigLoadCapture = existsSync(configLoadCapture);
      const command = ['npm', 'run', 'test:file', '--', testPath, '--', '--reporter=json', `--outputFile=${reportPath}`];
      // Reuse framework collection-time fingerprints. A source map is diagnostic
      // even for a failing or dirty oracle; it must never create reusable passes.
      if (hasSourceReporter) command.push(`--reporter=${sourceReporter}`);
      let exitCode: number | null = null;
      let signal: string | null = null;
      try {
        await execCapture(
          command[0], command.slice(1),
          { cwd: clonePath, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, PC_EXECUTED_SOURCE_MAP_WORKSPACE: 'gym-oracle',
              // The router's existing loader emits intermediate return receipts.
              // Preserve them separately from final worker/module observations.
              PAPERCUSP_COMMITTED_SOURCE_AUDIT: loaderReportPath,
              ...(hasConfigLoadCapture ? { PC_EXECUTED_SOURCE_MAP_PRELOAD: '1',
                PC_EXECUTED_SOURCE_MAP_ROOT: clonePath,
                NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(configLoadCapture).href}` } : {}),
              PC_EXECUTED_SOURCE_MAP_OUT: sourceReportPath, PC_EXECUTED_SOURCE_MAP_NO_PERSIST: '1' } },
        );
        exitCode = 0;
      } catch (error) {
        // A failing oracle still writes a JSON report; parse it below. If it did
        // not, the caller records deterministic evidence as not measured. Keep
        // command failure separate from the assertion report's statuses.
        if (error !== null && typeof error === 'object') {
          if ('code' in error && typeof error.code === 'number' && Number.isInteger(error.code)) exitCode = error.code;
          if ('signal' in error && typeof error.signal === 'string') signal = error.signal;
        }
      }
      try {
        const report = readFileSync(reportPath, 'utf8');
        const results = parseVitestOracleResults(report).map((t) =>
          t.file ? { ...t, file: (isAbsolute(t.file) ? relative(clonePath, t.file) : t.file).split('\\').join('/') } : t);
        let sourceReport: string | null = null;
        let modules: NonNullable<NonNullable<GymOracleRun['execution']>['workerSources']>['modules'] = [];
        let configEvidence: NonNullable<NonNullable<GymOracleRun['execution']>['configSources']>['evidence'] = null;
        let configLoaded: NonNullable<NonNullable<GymOracleRun['execution']>['configSources']>['loaded'] = null;
        let mainProcessEvidence: NonNullable<NonNullable<GymOracleRun['execution']>['mainProcessSources']>['evidence'] = null;
        // Keep the raw report even if it is malformed; do not rebuild original
        // module hashes from a later checkout when the reporter is unavailable.
        try { sourceReport = readFileSync(sourceReportPath, 'utf8'); } catch { /* unknown */ }
        try {
          const parsed = sourceReport && JSON.parse(sourceReport);
          if (Array.isArray(parsed?.diagnostics)) modules = parsed.diagnostics;
          if (parsed?.configSources && typeof parsed.configSources === 'object') configEvidence = parsed.configSources;
          if (parsed?.configLoadedSources && typeof parsed.configLoadedSources === 'object') configLoaded = parsed.configLoadedSources;
          if (parsed?.mainProcessLoadedSources && typeof parsed.mainProcessLoadedSources === 'object') mainProcessEvidence = parsed.mainProcessLoadedSources;
        } catch { /* retain malformed raw source report */ }
        const sourcePaths = new Set(modules.flatMap((module) =>
          Array.isArray(module?.sourceEvidence?.sources) ? module.sourceEvidence.sources
            .filter((source) => typeof source?.path === 'string').map((source) => source.path) : []));
        const referenceSources: Array<{ path: string; sha256: string | null }> = [];
        for (const path of [...sourcePaths].sort()) {
          referenceSources.push({ path, sha256: path === testPath ? pinned : await referenceHash(path) });
        }
        const configReferenceSources: Array<{ path: string; sha256: string | null }> = [];
        const configPaths = new Set(Array.isArray(configEvidence?.sources) ? configEvidence.sources
          .filter(source => typeof source?.path === 'string').map(source => source.path) : []);
        for (const path of [...configPaths].sort()) {
          configReferenceSources.push({ path, sha256: await referenceHash(path) });
        }
        const mainProcessReferenceSources: Array<{ path: string; sha256: string | null }> = [];
        const mainProcessPaths = new Set(Array.isArray(mainProcessEvidence?.sources) ? mainProcessEvidence.sources
          .filter(source => typeof source?.path === 'string').map(source => source.path) : []);
        for (const path of [...mainProcessPaths].sort()) {
          mainProcessReferenceSources.push({ path, sha256: await referenceHash(path) });
        }
        const manifestAfter = fileHash('package.json');
        const manifestUnknown = [manifestPinned, manifestBefore, manifestAfter].some((hash) => hash === null);
        let commandProcessReport: string | null = null;
        let loaderReport: string | null = null;
        let commandProcesses: NonNullable<NonNullable<GymOracleRun['execution']>['commandProcessSources']>['processes'] = [];
        const commandProcessUnresolved = ['node-process-descendant-population-unmeasured',
          'node-preload-self-unmeasured', 'node-external-native-runtime-unmeasured',
          'committed-source-loader-chain-not-closed'];
        try { loaderReport = readFileSync(loaderReportPath, 'utf8'); } catch { /* unknown */ }
        if (!loaderReport) commandProcessUnresolved.push('oracle-committed-source-load-unmeasured');
        try {
          const raw = readdirSync(`${sourceReportPath}.processes`).sort().map(file =>
            readFileSync(join(`${sourceReportPath}.processes`, file), 'utf8'));
          commandProcessReport = raw.join('\n');
          commandProcesses = raw.map(text => JSON.parse(text));
          if (commandProcesses.length === 0) commandProcessUnresolved.push('oracle-command-process-load-unmeasured');
        } catch { commandProcessUnresolved.push('oracle-command-process-load-unmeasured'); }
        const commandProcessReferenceSources: Array<{ path: string; sha256: string | null }> = [];
        const commandPaths = new Set(commandProcesses.flatMap(process => Array.isArray(process?.sources) ?
          process.sources.filter(source => typeof source?.path === 'string').map(source => source.path) : []));
        for (const path of [...commandPaths].sort()) {
          commandProcessReferenceSources.push({ path, sha256: await referenceHash(path) });
        }
        return pinCommit ? { results, testPath, pinCommit,
          sourceHashes: { pinned, before, after: fileHash(testPath) },
          implementation: implPath ? { path: implPath, before: implementationBefore, after: fileHash(implPath) } : null,
          execution: { command, cwd: clonePath, report, exitCode, signal,
            npmManifest: { path: 'package.json', sourceHashes: {
              pinned: manifestPinned, before: manifestBefore, after: manifestAfter,
            } },
            workerSources: { report: sourceReport, modules, reference: { pinCommit, sources: referenceSources } },
            configSources: { evidence: configEvidence, loaded: configLoaded, reference: { pinCommit, sources: configReferenceSources } },
            mainProcessSources: { evidence: mainProcessEvidence, reference: { pinCommit, sources: mainProcessReferenceSources } },
            commandProcessSources: { report: commandProcessReport, loaderReport, processes: commandProcesses,
              reference: { pinCommit, sources: commandProcessReferenceSources }, unresolved: commandProcessUnresolved },
            unresolved: ['oracle-dependencies-outside-worker-vite-scope', 'test-command-runtime', 'pipeline-runtime',
              ...(!mainProcessEvidence || mainProcessEvidence.status === 'unknown' ? ['oracle-main-process-load-unmeasured'] : []),
              ...(mainProcessReferenceSources.some(source => source.sha256 === null) ? ['oracle-main-process-reference-unavailable'] : []),
              ...(!configLoaded || configLoaded.status === 'unknown' ? ['oracle-config-original-load-unmeasured'] : []),
              ...(!configEvidence || configReferenceSources.length === 0 ? ['oracle-config-snapshot-evidence-unavailable'] : []),
              ...(configReferenceSources.some(source => source.sha256 === null) ? ['oracle-config-reference-unavailable'] : []),
              ...(manifestUnknown ? ['oracle-npm-manifest-evidence-unavailable'] :
                manifestBefore !== manifestPinned || manifestAfter !== manifestPinned ? ['oracle-npm-manifest-changed'] : []),
              ...(referenceSources.some((source) => source.sha256 === null) ? ['oracle-worker-source-reference-unavailable'] : []),
              ...(!sourceReport || modules.length === 0 ? ['oracle-worker-source-evidence-unavailable'] : [])] },
        } : results;
      } catch {
        return undefined;
      } finally {
        try { unlinkSync(reportPath); } catch { /* best effort */ }
        try { unlinkSync(sourceReportPath); } catch { /* best effort */ }
        try { unlinkSync(loaderReportPath); } catch { /* best effort */ }
        try { rmSync(`${sourceReportPath}.processes`, { recursive: true, force: true }); } catch { /* best effort */ }
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
