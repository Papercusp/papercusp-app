/**
 * The operator's own Project History read path: a `ProjectHistoryProvider` backed
 * DIRECTLY by Postgres and one bounded `git log`.
 *
 * WHY THIS EXISTS — the route used to shell out to `papercusp project-history
 * generate`, which shells out to a bare `ptool` once per plan and work-item read
 * and then walks the ENTIRE commit graph with `--name-only`. That is the correct
 * shape for its original consumer (a hive's public repo, which must build with no
 * operator and no database), and the wrong shape here: the operator IS the process
 * that owns that database, so it was spawning hundreds of subprocesses to
 * reconstruct rows sitting in its own Postgres. Measured on `papercusp`: ~290s,
 * against a 90s child budget and a 120s route watchdog, so the History tab could
 * never load at all (WI-10001548 defect A).
 *
 * WHY PAGINATION IS PART OF THE FIX AND NOT A SEPARATE NICETY. Precomputing the
 * document out-of-band — the obvious fix — does not work here, and the numbers say
 * so rather than an opinion: `papercusp` holds 1,882 plans carrying 36MB of plan
 * markdown plus 27MB of items/decisions BEFORE work items and commits. No cache
 * makes a ~63MB JSON document parseable in a webview, so the whole-archive-in-one-
 * response contract had to go. A page of plans is a few hundred KB, assembles in
 * milliseconds, and renders.
 *
 * The assembler itself is untouched: `generateProjectHistory` stays the single
 * definition of what a v2 document IS, and this file only supplies its documented
 * I/O boundary. The CLI provider remains the right implementation for the
 * committed-artifact case it was built for.
 */
import { execFile } from 'node:child_process';
import type {
  ProjectHistoryCommitInput,
  ProjectHistoryCommitLink,
  ProjectHistoryProvider,
  ProjectHistoryPlanInput,
  ProjectHistoryRepository,
  ProjectHistoryWorkItemInput,
} from '@papercusp/plan-parser/project-history';

/** Plans per page. Sized from real bodies (~19KB mean, 969KB worst) so one page stays sub-MB. */
export const PROJECT_HISTORY_PAGE_SIZE = 20;

/** Hard ceiling on `?limit`. A caller asking for the whole archive gets a page, not 63MB. */
export const PROJECT_HISTORY_MAX_PAGE_SIZE = 100;

/** One `git log` for a page's work items. Generous for a grep over ~34k commits (measured 0.4s). */
export const PROJECT_HISTORY_GIT_TIMEOUT_MS = 20_000;

/** Commit output is bounded by the grep, but a pathological page must not buffer without limit. */
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * ASCII RS and NUL, the separators in the `--format` below.
 *
 * Built from char codes on purpose: a RAW control byte in a source file reds
 * `lint:no-control-bytes` (a green-checkpoint leg) and makes ripgrep treat the
 * file as binary, so it silently drops out of every later search.
 */
const RECORD_SEPARATOR = String.fromCharCode(0x1e);
const FIELD_SEPARATOR = String.fromCharCode(0x00);

export interface ProjectHistoryPage {
  /** Plans in THIS response. */
  count: number;
  /** Plans in the whole archive for this project, after the same filters. */
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Everything this file binds: the two scope strings, a page limit/offset, and one
 * id array for the `= ANY($3::text[])` read. Narrower than `unknown[]` on purpose —
 * it is what lets the driver boundary below carry a single cast instead of every
 * call site carrying one.
 */
export type SqlParam = string | number | readonly string[];

export type SqlQuery = (text: string, params: readonly SqlParam[]) => Promise<Record<string, unknown>[]>;
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

export interface OperatorProjectHistorySourceOptions {
  workspaceId: string;
  harness: string;
  repoRoot: string;
  limit: number;
  offset: number;
  /** Injected in tests; defaults to the operator's org pool. */
  query?: SqlQuery;
  /** Injected in tests; defaults to a real `git` child. */
  git?: GitRunner;
}

/**
 * Plans the History tab must never present as project history.
 *
 * `template = 'rubric'` rows are acceptance rubrics, which are plan-BACKED for
 * storage reasons only — they are the grading instrument, not delivered work.
 * Seventeen of them polluting a published archive is what EI-20475585438015488
 * had to clean up by hand; excluding them at the read keeps that from recurring.
 * Archived plans are excluded for the same reason: the tab is the live record.
 */
const PLAN_FILTER = `
  workspace_id = $1 AND harness_slug = $2
  AND archived IS NOT TRUE
  AND coalesce(content, '') <> ''
  AND template IS DISTINCT FROM 'rubric'`;

/** Newest first — a delivery record is read from the present backwards. */
const PLAN_ORDER = 'ORDER BY coalesce(updated_at, created_at) DESC NULLS LAST, plan_slug';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

/**
 * A git remote URL as a repository descriptor, or null when there is no remote.
 *
 * Only a recognised GitHub remote gets a `webUrl`: it is rendered as a browser
 * link for every commit, and a guessed one 404s, which is worse than no link.
 */
export function repositoryFromRemoteUrl(
  remoteUrl: string | null,
  defaultBranch: string | null,
): ProjectHistoryRepository | null {
  const url = text(remoteUrl);
  if (!url) return null;
  const github = url.match(/^(?:https?:\/\/|git@|ssh:\/\/git@)github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  return {
    provider: github ? 'github' : 'git',
    url,
    webUrl: github ? `https://github.com/${github[1]}/${github[2]}` : null,
    defaultBranch,
  };
}

/** One `work_items` row as the assembler's input shape. */
export function workItemInputFromRow(row: Record<string, unknown>): ProjectHistoryWorkItemInput | null {
  const id = text(row.feature_id);
  const title = text(row.title);
  if (!id || !title) return null;
  const payload = record(row.payload);
  const evidence = record(payload?._completionEvidence);
  // `payload.plan_item.plan_slug` is the authoritative attachment when the item was
  // minted from a plan item; `source_plan_slug` is the weaker provenance stamp. An
  // item with NEITHER attaches wherever a plan's markdown references its id, which
  // is what `planSlugs: undefined` means to the assembler.
  const planSlug = text(record(payload?.plan_item)?.plan_slug) ?? text(row.source_plan_slug);
  return {
    id,
    kind: text(row.item_kind) ?? 'work-item',
    title,
    state: text(row.status) ?? 'unknown',
    completedAt: isoOrNull(row.closed_ts),
    completionAuthority: text(row.authority) ?? 'work-item-ledger',
    completionSummary: text(evidence?.summary),
    completionEvidence: evidence,
    planSlugs: planSlug ? [planSlug] : undefined,
  };
}

/**
 * `git log` argv that returns ONLY commits mentioning one of `ids`.
 *
 * The alternation is what keeps this affordable: the unpaginated generator walked
 * every commit and diffed each one, while a grep over the same ~34k commits costs
 * ~0.4s because `--name-only` then runs on the handful that matched.
 */
export function buildCommitLogArgs(ids: readonly string[]): string[] {
  const alternation = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return [
    'log',
    '--no-color',
    '--extended-regexp',
    `--grep=(^|[^A-Za-z0-9-])(${alternation})([^0-9]|$)`,
    '--name-only',
    '--format=%x1e%H%x00%s%x00%cI%x00%B%x00',
  ];
}

interface ParsedCommit {
  sha: string;
  subject: string | null;
  committedAt: string | null;
  body: string;
  files: string[];
}

/** Parse the record-separated log above. A malformed record is skipped, never guessed at. */
export function parseCommitLog(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const chunk of raw.split(RECORD_SEPARATOR)) {
    const fields = chunk.split(FIELD_SEPARATOR);
    const sha = fields[0]?.trim();
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || fields.length < 4) continue;
    commits.push({
      sha,
      subject: fields[1] || null,
      committedAt: fields[2] || null,
      body: fields[3] ?? '',
      files: [...new Set((fields[4] ?? '').split(/\r?\n/).map((file) => file.trim()).filter(Boolean))].sort(),
    });
  }
  return commits;
}

/**
 * Link commits to the work items they name.
 *
 * A `Papercusp-Work-Item:` trailer is `authoritative` — the committer said so. A
 * bare mention in the body is `body-reference`, deliberately weaker: on this repo
 * git-sync writes the commit message, so prose that merely cites an id is common
 * and must not be presented as the same grade of evidence.
 */
export function commitLinksFor(body: string, requested: ReadonlySet<string>): ProjectHistoryCommitLink[] {
  const authoritative = new Set(
    [...body.matchAll(/^Papercusp-Work-Item:\s*((?:WI|EI|F)-\d+)\s*$/gim)]
      .map((match) => match[1])
      .filter((id): id is string => Boolean(id && requested.has(id))),
  );
  const referenced = new Set(
    [...body.matchAll(/\b(?:WI|EI|F)-\d+\b/g)]
      .map((match) => match[0])
      .filter((id) => requested.has(id) && !authoritative.has(id)),
  );
  return [
    ...[...authoritative].map((workItemId) => ({ workItemId, attribution: 'authoritative' as const })),
    ...[...referenced].map((workItemId) => ({ workItemId, attribution: 'body-reference' as const })),
  ];
}

function defaultGit(): GitRunner {
  return (args, cwd) => new Promise<string>((resolve, reject) => {
    execFile('git', [...args], { cwd, timeout: PROJECT_HISTORY_GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

async function defaultQuery(
  queryText: string,
  params: readonly SqlParam[],
): Promise<Record<string, unknown>[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  // postgres.js types `unsafe`'s bindings against a generic it cannot infer from a
  // query assembled at runtime, so it lands on `ParameterOrJSON<never>[]` and rejects
  // every concrete array. The cast sits at the driver boundary `unsafe` already
  // denotes; `SqlParam` above is what actually constrains what reaches it.
  return (await sql.unsafe(queryText, params as unknown as string[])) as unknown as Record<string, unknown>[];
}

export interface OperatorProjectHistorySource {
  provider: ProjectHistoryProvider;
  countPlans(): Promise<number>;
  detectRepository(): Promise<ProjectHistoryRepository | null>;
}

/** The provider the route assembles a page from. */
export function createOperatorProjectHistorySource(
  options: OperatorProjectHistorySourceOptions,
): OperatorProjectHistorySource {
  const query = options.query ?? defaultQuery;
  const git = options.git ?? defaultGit();
  const scope = [options.workspaceId, options.harness];

  return {
    async countPlans(): Promise<number> {
      const rows = await query(
        `SELECT count(*)::int AS total FROM harness_shared.harness_plans WHERE ${PLAN_FILTER}`,
        scope,
      );
      const total = rows[0]?.total;
      return typeof total === 'number' ? total : Number(total ?? 0);
    },

    async detectRepository(): Promise<ProjectHistoryRepository | null> {
      // A missing remote or a detached origin/HEAD is ordinary, not a failure: the
      // document is still complete, it simply carries no browser links.
      const remote = await git(['remote', 'get-url', 'origin'], options.repoRoot).catch(() => '');
      const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], options.repoRoot).catch(() => '');
      return repositoryFromRemoteUrl(remote.trim() || null, head.trim().replace(/^origin\//, '') || null);
    },

    provider: {
      async loadPlans(): Promise<readonly ProjectHistoryPlanInput[]> {
        const rows = await query(
          `SELECT plan_slug, content, coalesce(updated_at, created_at) AS updated_at
             FROM harness_shared.harness_plans
            WHERE ${PLAN_FILTER} ${PLAN_ORDER} LIMIT $3 OFFSET $4`,
          [...scope, options.limit, options.offset],
        );
        return rows.flatMap((row) => {
          const markdown = typeof row.content === 'string' ? row.content : '';
          const slug = text(row.plan_slug);
          if (!markdown || !slug) return [];
          // `filePath` is what the parser falls back to for a slug when the plan's
          // own frontmatter omits one, so it must name the canonical projection
          // path rather than any path on this box.
          return [{ markdown, filePath: `docs/plans/${slug}.md`, updatedAt: isoOrNull(row.updated_at) }];
        });
      },

      async loadWorkItems(ids: readonly string[]): Promise<readonly ProjectHistoryWorkItemInput[]> {
        if (ids.length === 0) return [];
        const rows = await query(
          `SELECT feature_id, item_kind, title, status, closed_ts, authority, payload, source_plan_slug
             FROM harness_shared.work_items
            WHERE workspace_id = $1 AND harness_slug = $2 AND feature_id = ANY($3::text[])`,
          [...scope, ids as string[]],
        );
        return rows.flatMap((row) => {
          const item = workItemInputFromRow(row);
          return item ? [item] : [];
        });
      },

      async loadCommits(ids: readonly string[]): Promise<readonly ProjectHistoryCommitInput[]> {
        if (ids.length === 0) return [];
        // Commits ENRICH the record; the plans and their completion evidence are the
        // record itself. A repo that cannot be read (permissions, a mid-sweep index
        // lock, a timeout) must degrade to a document without commit links rather
        // than fail the page — the opposite trade to `loadWorkItems`, whose empty
        // result the assembler correctly refuses because it is silently lossy.
        const raw = await git(buildCommitLogArgs(ids), options.repoRoot).catch(() => '');
        const requested = new Set(ids);
        return parseCommitLog(raw).flatMap((commit) => {
          const links = commitLinksFor(commit.body, requested);
          if (links.length === 0) return [];
          return [{
            sha: commit.sha,
            subject: commit.subject,
            committedAt: commit.committedAt,
            files: commit.files,
            // This repo's commits are pushed by git-sync on a schedule, so a local
            // commit is not yet proof of a remote one. `unknown` is the honest
            // value; claiming `confirmed` without asking the remote would not be.
            remoteStatus: 'unknown' as const,
            links,
          }];
        });
      },
    },
  };
}
