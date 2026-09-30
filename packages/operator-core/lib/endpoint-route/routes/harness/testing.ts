/**
 * Harness-scoped testing surface — the harness Tests tab's backend.
 *
 * Phase C / P-024 of harness-tests-tab-and-tester-promotion-2026-05-26.
 * Mirrors /api/admin/testing/* but scoped to a harness's phase worktree:
 *
 *   GET  /api/harness/:slug/testing/domain-detail?domainId=…&phase=…
 *   GET  /api/harness/:slug/testing/file-status?domainId=…&phase=…
 *   GET  /api/harness/:slug/testing/health-strip?domainId=…&phase=…
 *   POST /api/harness/:slug/testing/run         (body: { runner })
 *   GET  /api/harness/:slug/testing/domains            — the harness's domains + tier labels
 *
 * The harness's test DOMAINS are harness-owned data, declared in the harness's
 * own contract surface at `<worktree>/.papercusp/testing-domains.json`
 * (`{ domains: TestDomain[], tierLabels?: Record<string,string> }`). A harness
 * that declares none falls back to the generic `harnessTestingRegistry`
 * (Built-in generalized + Acceptance). This keeps the operator from hard-wiring
 * a per-harness registry: the papercup dogfood harness ships its own
 * `.papercusp/testing-domains.json` (generated from the operator's adminRegistry),
 * the same place a harness's test data naturally lives.
 *
 * Built-in (generalized) domains are glob-walked against the worktree
 * (`expandGlobs(phasePath(...), globs)`, reused from the admin path).
 * The Acceptance (project) domain's files come from `.papercusp/tests.json`.
 *
 * NOT gated by FLAGS.HARNESS_PHASES (unlike the legacy /harness/:slug/tests
 * routes): that flag gates the staging/testing/production PHASE system, which
 * is a separate concern from surfacing a harness's tests. The Tests tab works
 * regardless of the flag. (The flag itself is unchanged — still off by default,
 * still gating PhaseTabs et al.)
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, rmSync } from 'node:fs';
import { defineTool } from '@papercusp/agent-mcp';
import { parseVitestJsonForHarnessRows, persistHarnessTestRuns, computeWorktreeDirty } from '../../../testing-run-store';
import { resolvePhasedProject, safeRead } from '../../../harness-core';
import { type ProjectEntry, loadHarnessRegistry, resolveHarnessContentPath } from '../../../harness-registry';
import { type Phase, phasePhaseLabel, phasePath } from '../../../harness-phases';
import { expandGlobs } from '../../../testing-domain-glob';
import { harnessTestingRegistry, HARNESS_TESTING_TIER_LABELS, ACCEPTANCE_DOMAIN_ID } from '../../../harness-testing-registry';
import { type TestDomain, type ChipStatus, type FileStatusEntry } from '../../../testing-domains';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { computePlanItemTestStatus } from '../../../harness-test-rollup';
import { runGovernedOperation } from '../../../resource-governor/execution';
import { startRun, getRunAsync, cancelRunAsync } from '../../../testing-run-store';

interface HarnessTestRow {
  id: string;
  summary: string;
  file: string;
  // Mirrors TestItem.framework in ./tests.ts (same on-disk .papercusp/tests.json
  // schema) — 'cargo'/'shell' added alongside it (EI-299) so a Rust-desktop-gate
  // or raw-script row here isn't miscast; this route only reads/displays status,
  // it doesn't dispatch a runner.
  framework: 'playwright' | 'vitest' | 'pytest' | 'cargo' | 'shell';
  coversVALs: string[];
  status: 'passing' | 'failing' | 'skipped' | 'not_run';
  lastRunTs: number;
  durationMs: number;
}

function readHarnessTests(project: ProjectEntry, phase: Phase): HarnessTestRow[] {
  const raw = safeRead(join(phasePath(project, phase), '.papercusp', 'tests.json'));
  if (!raw) return [];
  try {
    return (JSON.parse(raw).tests ?? []) as HarnessTestRow[];
  } catch {
    return [];
  }
}

/**
 * Load the harness's declared test domains from its own contract surface
 * (`<worktree>/.papercusp/testing-domains.json`), falling back to the generic
 * generalized+Acceptance registry. Harness-owned data, not operator-hardwired.
 */
function loadHarnessDomains(root: string): { domains: TestDomain[]; tierLabels: Record<string, string> } {
  const raw = safeRead(join(root, '.papercusp', 'testing-domains.json'));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { domains?: unknown; tierLabels?: unknown };
      if (Array.isArray(parsed.domains) && parsed.domains.length > 0) {
        return {
          domains: parsed.domains as TestDomain[],
          tierLabels:
            (parsed.tierLabels as Record<string, string> | undefined) ?? HARNESS_TESTING_TIER_LABELS,
        };
      }
    } catch {
      /* malformed → fall back */
    }
  }
  return { domains: harnessTestingRegistry, tierLabels: HARNESS_TESTING_TIER_LABELS };
}

function findDomain(id: string, root: string): TestDomain | undefined {
  return loadHarnessDomains(root).domains.find((d) => d.id === id);
}

function chipFromStatus(s: HarnessTestRow['status']): ChipStatus {
  return s === 'passing' ? 'pass' : s === 'failing' ? 'fail' : 'skip';
}

/** Resolve (project, phase, worktree root) from the request, or a 404 Response. */
async function resolveCtx(
  slug: string,
  phaseParam: string | null,
): Promise<{ project: ProjectEntry; phase: Phase; root: string } | Response> {
  const phase = phasePhaseLabel(phaseParam ?? undefined);
  const project = await resolvePhasedProject(slug, phase);
  if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
  // git-sync-any-hive: a repo-less kind:'hive' harness resolves its MEMBER repo's
  // worktree for repo-backed reads (its own `path` is the hive state dir, not a
  // code checkout). Falls back to phasePath for a normal repo harness.
  const contentBase = resolveHarnessContentPath(await loadHarnessRegistry(), slug);
  const root = contentBase && contentBase !== project.path ? contentBase : phasePath(project, phase);
  return { project, phase, root };
}

const domainDetail = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/domain-detail',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const domainId = url.searchParams.get('domainId') ?? '';

    const resolved = await resolveCtx(ctx.params.slug as string, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { project, phase, root } = resolved;

    const domain = findDomain(domainId, root);
    if (!domain) return Response.json({ error: 'unknown_domain', domainId }, { status: 404 });

    let sections;
    if (domainId === ACCEPTANCE_DOMAIN_ID) {
      // Acceptance "files" are the VAL-covering tests; dedupe by path.
      const seen = new Set<string>();
      const files = readHarnessTests(project, phase)
        .filter((t) => (seen.has(t.file) ? false : (seen.add(t.file), true)))
        .map((t) => ({ path: t.file, sizeBytes: 0, mtimeMs: (t.lastRunTs || 0) * 1000 }));
      sections = domain.sections.map((s) => ({
        id: s.id,
        label: s.label,
        description: s.description,
        files,
        runners: [],
      }));
    } else {
      sections = await Promise.all(
        domain.sections.map(async (s) => ({
          id: s.id,
          label: s.label,
          description: s.description,
          files: s.globs?.length ? await expandGlobs(root, s.globs) : [],
          runners: s.runners ?? [],
        })),
      );
    }
    const totalFiles = sections.reduce((n, s) => n + s.files.length, 0);
    return Response.json({
      id: domain.id,
      label: domain.label,
      description: domain.description,
      tier: domain.tier,
      sections,
      totalFiles,
    });
  },
});

const listDomains = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/domains',
  auth: 'public',
  async handler(req, ctx) {
    const resolved = await resolveCtx(ctx.params.slug as string, new URL(req.url).searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { domains, tierLabels } = loadHarnessDomains(resolved.root);
    return Response.json({ domains, tierLabels });
  },
});

const fileStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/file-status',
  auth: 'public',
  async handler(req, ctx) {
    const url = new URL(req.url);
    const domainId = url.searchParams.get('domainId') ?? '';
    const resolved = await resolveCtx(ctx.params.slug as string, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { project, phase } = resolved;

    const statuses: Record<string, FileStatusEntry> = {};
    // Only the Acceptance domain has persisted per-file status (tests.json).
    // Built-in (generalized) files glob-walk the worktree but the harness
    // doesn't track their run status — they render as "none" chips.
    if (domainId === ACCEPTANCE_DOMAIN_ID) {
      for (const t of readHarnessTests(project, phase)) {
        if (t.status === 'not_run') continue;
        statuses[t.file] = {
          status: chipFromStatus(t.status),
          durationMs: t.durationMs || null,
          finishedAt: t.lastRunTs ? new Date(t.lastRunTs * 1000).toISOString() : null,
          source: 'local',
          branch: null,
          stale: false,
        };
      }
    }
    return Response.json({ domainId, branch: null, commit: null, statuses });
  },
});

const healthStrip = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/health-strip',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    // Minimal strip for now — per-file run history isn't tracked in the
    // harness yet (the tester writes pass/fail, not a flake series).
    return Response.json({
      domainId: url.searchParams.get('domainId') ?? '',
      branch: null,
      lastSuiteDurationMs: null,
      lastFailureFinishedAt: null,
      flakyFileCount: 0,
      totalFilesTracked: 0,
    });
  },
});

const run = defineTool({
  method: 'POST',
  path: '/harness/:slug/testing/run',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const resolved = await resolveCtx(slug, url.searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const { project, root } = resolved;

    const body = (await req.json().catch(() => ({}))) as {
      runner?: { kind?: string; filePath?: string; filePaths?: string[] };
    };
    const runner = body.runner ?? {};
    const requested =
      runner.kind === 'vitest-multi' ? runner.filePaths ?? [] : runner.filePath ? [runner.filePath] : [];
    // Path-safety: repo-relative POSIX, no traversal.
    const files = requested.filter((f) => /^[A-Za-z0-9_./*-]+$/.test(f) && !f.includes('..'));
    if (files.length === 0) {
      return Response.json({ error: 'no runnable files in request' }, { status: 400 });
    }

    // Synchronous run in the worktree (the harness has no async run daemon;
    // matches the existing /harness/:slug/tests/:id/run route). Vitest only —
    // the panel's per-file Run always requests vitest; playwright/pytest
    // acceptance tests run via the orchestrator's tester loop, not here.
    //
    // P-007/P-020 ingestion: we run the JSON reporter ALONGSIDE the human
    // `default` reporter (the latter still drives the panel's `output`), then
    // parse the JSON file into one harness_shared.test_runs row per file so this
    // hive's Tests tab can render history. This runs INSIDE the operator, which
    // has DB access — robust, and it never loads the operator's reporter into a
    // foreign repo's vitest. The completion-gate side is the global
    // papercusp-test-completion-gate flag (P-006), so a coding hive needs no
    // separate gate wiring here.
    //
    // Resolve the HARNESS worktree's branch/commit directly (not the operator's
    // — resolveGitContext() is pinned+cached to the operator root). Best-effort:
    // null on any failure.
    const gitIn = (args: string[]): string | null => {
      try {
        return execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          timeout: 2_000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
    };
    const gitSnapshot = (): { commit: string | null; porcelain: string | null } => ({
      commit: gitIn(['rev-parse', 'HEAD']),
      porcelain: gitIn(['status', '--porcelain', '--', ...files]),
    });
    // EI-18795303393201472: this runs against the SHARED, concurrently-edited
    // working tree, not an isolated checkout — a peer's edit or a git-sync
    // commit landing DURING the run means the commit sha sampled afterward can
    // name a commit whose content never matches what vitest actually executed
    // (a torn read). Snapshot BEFORE too, so we can tell — computeWorktreeDirty
    // below flags the row instead of silently misattributing a red to an
    // innocent sha.
    const gitBefore = gitSnapshot();
    const started = Date.now();
    const runId = `h-${started}`;
    const jsonOut = join(tmpdir(), `psu-harness-vitest-${started}-${Math.random().toString(36).slice(2)}.json`);
    const executionResult = await runGovernedOperation(
      {
        workspaceId: activeWorkspaceId(),
        namespace: 'harness-testing-run',
        owner: `harness:${project.slug}:testing`,
        admissionClass: 'process',
        demand: { cpuWeight: 1, memoryBytes: 512 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `harness:${project.slug}:testing:${runId}`,
        metadata: { harness: project.slug, files: files.length },
      },
      async () => {
        try {
          return {
            exitCode: 0,
            output: execFileSync(
              'npx',
              ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${jsonOut}`, ...files],
              {
                cwd: root,
                encoding: 'utf8',
                timeout: 120_000,
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            ),
          };
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; status?: number };
          return {
            exitCode: err.status ?? 1,
            output: String(err.stdout ?? '') + String(err.stderr ?? ''),
          };
        }
      },
    );
    const { exitCode, output } = executionResult;
    const gitAfter = gitSnapshot();
    const worktreeDirty = computeWorktreeDirty(gitBefore, gitAfter);

    // Best-effort ingestion — D-007 fail-soft: a parse/DB error must NOT change
    // the run result the panel sees. A non-vitest report (no JSON file / no
    // testResults) simply yields zero rows and is skipped gracefully.
    try {
      let jsonText = '';
      try {
        jsonText = readFileSync(jsonOut, 'utf8');
      } catch {
        /* reporter wrote nothing (e.g. vitest crashed before reporting) */
      }
      if (jsonText) {
        const rows = parseVitestJsonForHarnessRows(jsonText, root);
        if (rows.length > 0) {
          const branchRaw = gitAfter.commit ? gitIn(['rev-parse', '--abbrev-ref', 'HEAD']) : null;
          const branch = branchRaw && branchRaw !== 'HEAD' ? branchRaw : null;
          await persistHarnessTestRuns({
            harnessSlug: slug,
            workspaceId: activeWorkspaceId(),
            rows,
            runGroupId: runId,
            branch,
            commit: gitAfter.commit,
            worktreeDirty,
          });
        }
      }
    } catch {
      /* swallow — D-007: ingestion never breaks the run */
    } finally {
      try {
        rmSync(jsonOut, { force: true });
      } catch {
        /* swallow */
      }
    }

    return Response.json({
      runId,
      status: exitCode === 0 ? 'pass' : 'fail',
      exitCode,
      output: output.slice(-8000),
      finishedAt: Date.now(),
    });
  },
});

// Detached run lifecycle for the TUI. The legacy synchronous route above is
// retained for API compatibility; these endpoints share the admin run store so
// callers can observe rolling output and cancel the whole process group.
const runDetached = defineTool({
  method: 'POST',
  path: '/harness/:slug/testing/run-detached',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const resolved = await resolveCtx(slug, new URL(req.url).searchParams.get('phase'));
    if (resolved instanceof Response) return resolved;
    const body = (await req.json().catch(() => ({}))) as { filePath?: unknown };
    const filePath = typeof body.filePath === 'string' ? body.filePath : '';
    if (!filePath || !/^[A-Za-z0-9_./*-]+$/.test(filePath) || filePath.includes('..')) {
      return Response.json({ error: 'filePath is required and must be repo-relative' }, { status: 400 });
    }
    const snapshot = startRun({
      kind: 'vitest',
      label: `vitest ${filePath}`,
      filePath,
      command: 'npx',
      args: ['vitest', 'run', filePath],
      cwd: resolved.root,
    });
    return Response.json(snapshot);
  },
});

const runDetachedStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/run-detached/:runId',
  auth: 'loopback',
  async handler(_req, ctx) {
    const snapshot = await getRunAsync(ctx.params.runId as string);
    return snapshot ? Response.json(snapshot) : Response.json({ error: 'unknown runId' }, { status: 404 });
  },
});

const runDetachedCancel = defineTool({
  method: 'POST',
  path: '/harness/:slug/testing/run-detached/:runId/cancel',
  auth: 'loopback',
  async handler(_req, ctx) {
    const ok = await cancelRunAsync(ctx.params.runId as string);
    return ok ? Response.json({ ok: true }) : Response.json({ ok: false, reason: 'not_running_or_unknown' }, { status: 404 });
  },
});

// ── Per-file run history (P-007/P-020) ─────────────────────────────────────
// Mirrors /admin/testing/file-history but scoped to THIS hive:
//   WHERE harness_slug = :slug AND workspace_id = activeWorkspaceId()
//        AND file_path = ?filePath
// Backs the Tests-tab status-chip history sheet (fetchHistory) for every
// managed harness — populated by the `run` route's ingestion above, so a hive
// renders its own history with no per-repo scaffolding.

interface HistoryDbRow {
  id: string;
  status: string;
  framework: string;
  duration_ms: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  output_tail: string | null;
  source: string;
  branch: string | null;
  commit_sha: string | null;
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  return null;
}

const fileHistory = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/file-history',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const filePath = url.searchParams.get('filePath');
    if (!filePath) {
      return Response.json({ error: 'missing_query_param', param: 'filePath' }, { status: 400 });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200);
    try {
      const { sql } = getOrgPg();
      const ws = activeWorkspaceId();
      const rows = await sql<HistoryDbRow[]>`
        SELECT id, status, framework, duration_ms, started_at, finished_at,
               output_tail, source, branch, commit_sha
          FROM harness_shared.test_runs
         WHERE harness_slug = ${slug} AND workspace_id = ${ws} AND file_path = ${filePath}
           AND source <> 'mutation-probe'
         ORDER BY finished_at DESC NULLS LAST, id DESC
         LIMIT ${limit}
      `;
      return Response.json({
        filePath,
        rows: rows.map((r) => ({
          id: Number(r.id),
          status: r.status,
          framework: r.framework,
          durationMs: r.duration_ms !== null ? Number(r.duration_ms) : null,
          startedAt: toIso(r.started_at),
          finishedAt: toIso(r.finished_at),
          outputTail: r.output_tail,
          source: r.source,
          branch: r.branch,
          commitSha: r.commit_sha,
        })),
      });
    } catch {
      // Table/PG absent — empty is a valid "no history yet" (e.g. a hive whose
      // tests have never been run through the Tests tab).
      return Response.json({ filePath, rows: [] });
    }
  },
});

// ── Assertions (VALs) — the Acceptance tab's data (P-062 / P-063) ──────────
// harness_plan_assertions is keyed by (workspace, harness_slug), not phase.

interface AssertionListRow {
  val_id: string;
  plan_slug: string;
  item_id: string;
  verify_text: string;
  status: string;
  requires_test: boolean;
}

const listAssertions = defineTool({
  method: 'GET',
  path: '/harness/:slug/testing/assertions',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const planSlug = new URL(req.url).searchParams.get('plan');
    try {
      const { sql } = getOrgPg();
      const ws = activeWorkspaceId();
      const rows = planSlug
        ? await sql<AssertionListRow[]>`
            SELECT val_id, plan_slug, item_id, verify_text, status, requires_test
              FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND plan_slug = ${planSlug}
             ORDER BY val_id`
        : await sql<AssertionListRow[]>`
            SELECT val_id, plan_slug, item_id, verify_text, status, requires_test
              FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug}
             ORDER BY val_id`;
      return Response.json({ assertions: rows });
    } catch {
      // Table absent / PG unreachable — empty is a valid "no assertions yet".
      return Response.json({ assertions: [] });
    }
  },
});

const patchAssertion = defineTool({
  method: 'POST',
  path: '/harness/:slug/testing/assertions/:valId',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const valId = ctx.params.valId as string;
    const body = (await req.json().catch(() => ({}))) as { requires_test?: unknown };
    if (typeof body.requires_test !== 'boolean') {
      return Response.json({ error: 'requires_test (boolean) required' }, { status: 400 });
    }
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const rows = await sql<{ val_id: string; requires_test: boolean }[]>`
      UPDATE harness_shared.harness_plan_assertions
         SET requires_test = ${body.requires_test}
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND val_id = ${valId}
       RETURNING val_id, requires_test`;
    if (rows.length === 0) return Response.json({ error: 'assertion_not_found' }, { status: 404 });
    try {
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('testing.assertionsByHarness', { harnessSlug: slug, workspaceId: ws });
    } catch { /* table bridge remains the fallback */ }
    return Response.json({ ok: true, val_id: rows[0].val_id, requires_test: rows[0].requires_test });
  },
});

// ── Plan↔test rollup (P-082) ───────────────────────────────────────────────
// Per-plan-item test coverage, joined from harness_plan_assertions ⋈
// harness_tests through the VAL. Mirrors plans-central's feature-status badge
// but for tests; consumed by the Plans-tab coverage badge (P-083).

const planItemsTestStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/plan-items-test-status',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const planSlug = new URL(req.url).searchParams.get('plan');
    try {
      const { sql } = getOrgPg();
      const ws = activeWorkspaceId();
      const assertions = planSlug
        ? await sql<{ val_id: string; item_id: string; requires_test: boolean }[]>`
            SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND plan_slug = ${planSlug}`
        : await sql<{ val_id: string; item_id: string; requires_test: boolean }[]>`
            SELECT val_id, item_id, requires_test FROM harness_shared.harness_plan_assertions
             WHERE workspace_id = ${ws} AND harness_slug = ${slug}`;
      const testRows = await sql<{ status: string; payload: { coversVALs?: unknown } }[]>`
        SELECT status, payload FROM harness_shared.harness_tests
         WHERE workspace_id = ${ws} AND harness_slug = ${slug}`;
      const tests = testRows.map((r) => ({
        status: r.status,
        coversVALs: Array.isArray(r.payload?.coversVALs)
          ? (r.payload.coversVALs as unknown[]).filter((v): v is string => typeof v === 'string')
          : [],
      }));
      const byItem = computePlanItemTestStatus(assertions, tests);
      return Response.json({ items: Object.values(byItem) });
    } catch {
      // Table/PG absent — empty is a valid "no coverage data".
      return Response.json({ items: [] });
    }
  },
});

export default [domainDetail, listDomains, fileStatus, healthStrip, run, runDetached, runDetachedStatus, runDetachedCancel, fileHistory, listAssertions, patchAssertion, planItemsTestStatus];
