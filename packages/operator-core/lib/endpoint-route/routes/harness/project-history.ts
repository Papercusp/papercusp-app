/** GET /api/harness/:slug/project-history — one page of the portable History document. */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { generateProjectHistory, type ProjectHistoryDocument } from '@papercusp/plan-parser/project-history';
import { resolveHarnessRepoRoot } from '../../../harness/docs/harness-repo';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  createOperatorProjectHistorySource,
  PROJECT_HISTORY_MAX_PAGE_SIZE,
  PROJECT_HISTORY_PAGE_SIZE,
  type ProjectHistoryPage,
} from './project-history-source';

/**
 * Any text that reaches a client may have come from a child process that colours
 * its own diagnostics, and those bytes render as a literal `[31m` in the History
 * tab's error box. Strip them at this boundary rather than asking every consumer to.
 */
function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?:]*[ -/]*[@-~]/g, '');
}

/**
 * A condition no retry can clear: the project is structurally incapable of
 * producing a history document. Carries a machine-readable code so the client
 * renders its empty state instead of an alarming error box.
 */
export class ProjectHistoryUnavailableError extends Error {
  constructor(readonly code: 'not-a-git-repository', message: string) {
    super(message);
    this.name = 'ProjectHistoryUnavailableError';
  }
}

/** A git root holds a `.git` DIRECTORY — or a `.git` FILE when it is a worktree/submodule. */
async function isGitRepository(repoRoot: string): Promise<boolean> {
  try {
    await access(join(repoRoot, '.git'));
    return true;
  } catch {
    return false;
  }
}

export interface ProjectHistoryPageDocument extends ProjectHistoryDocument {
  page: ProjectHistoryPage;
}

/**
 * Clamp a caller's window into one the server will actually serve.
 *
 * A bad `?limit` is clamped rather than refused: the tab is a read surface, and
 * answering a nonsensical window with a valid page is friendlier than a 400 the
 * user cannot act on. The CEILING is the load-bearing half — `papercusp`'s full
 * archive is ~63MB of plan markdown, so an unbounded limit is the defect this
 * route exists to fix, not a power-user affordance.
 */
export function resolvePageWindow(params: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(params.get('limit') ?? '', 10);
  const rawOffset = Number.parseInt(params.get('offset') ?? '', 10);
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, PROJECT_HISTORY_MAX_PAGE_SIZE)
      : PROJECT_HISTORY_PAGE_SIZE,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
  };
}

export async function loadHarnessProjectHistoryPage(
  slug: string,
  window: { limit: number; offset: number },
): Promise<ProjectHistoryPageDocument> {
  const repoRoot = await resolveHarnessRepoRoot(slug);
  if (!repoRoot) throw new Error(`unknown project: ${slug}`);
  // Ask the filesystem directly: a pot that is not a git checkout has no commits
  // to report, which is an empty history, not a fault.
  if (!await isGitRepository(repoRoot)) {
    throw new ProjectHistoryUnavailableError(
      'not-a-git-repository',
      `${slug} is not a git repository, so it has no commit history to report.`,
    );
  }

  const workspaceId = activeWorkspaceId();
  const source = createOperatorProjectHistorySource({
    workspaceId,
    harness: slug,
    repoRoot,
    limit: window.limit,
    offset: window.offset,
  });
  const [total, repository] = await Promise.all([source.countPlans(), source.detectRepository()]);
  const document = await generateProjectHistory({
    project: { id: slug, name: slug, repository },
    source: {
      kind: 'papercusp-plan-export',
      workspace: workspaceId,
      harness: slug,
      planPrefix: null,
      generatedAt: new Date().toISOString(),
      generator: 'operator-route/project-history',
    },
    provider: source.provider,
  });
  return {
    ...document,
    page: {
      count: document.plans.length,
      total,
      offset: window.offset,
      limit: window.limit,
      hasMore: window.offset + document.plans.length < total,
    },
  };
}

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/project-history',
  auth: 'loopback',
  // One page is a bounded PG read plus a single grep-scoped `git log`, so this is
  // headroom for a loaded box rather than a budget the happy path approaches.
  timeoutSec: 60,
  async handler(req, ctx) {
    const slug = String(ctx.params.slug ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(slug)) {
      return Response.json({ error: 'invalid project slug' }, { status: 400 });
    }
    try {
      const window = resolvePageWindow(new URL(req.url).searchParams);
      return Response.json(await loadHarnessProjectHistoryPage(slug, window));
    } catch (error) {
      if (error instanceof ProjectHistoryUnavailableError) {
        // 422, not 503: the request is well-formed and the server is healthy —
        // this project simply cannot produce the document, and no retry helps.
        return Response.json({ error: error.message, code: error.code }, { status: 422 });
      }
      const message = stripAnsi(error instanceof Error ? error.message : String(error));
      const status = message.startsWith('unknown project:') ? 404 : 503;
      return Response.json({ error: message }, { status });
    }
  },
});
