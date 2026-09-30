/**
 * Read-only git views over a harness project's repo:
 *
 *   GET /api/harness/:slug/git/show/:sha   — commit metadata + (bounded) patch
 *   GET /api/harness/:slug/git/worktrees   — `git worktree list` parsed
 *   GET /api/harness/:slug/git/log         — `git log` (cached, 3s TTL)
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 20).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { resolvePhasedProject } from '../../../harness-core';
import { phasePhaseLabel } from '../../../harness-phases';
import { NotGitRepositoryError, readGitStats } from '../../../harness/git-stats';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { runGovernedOperation } from '../../../resource-governor/execution';

const execFileP = promisify(execFile);

function runGitProcess(
  projectPath: string,
  args: string[],
  options: { maxBuffer: number; timeout: number },
  purpose: string,
) {
  return runGovernedOperation(
    {
      workspaceId: activeWorkspaceId(),
      namespace: 'harness-git-view',
      owner: `harness-git:${purpose}`,
      admissionClass: 'process',
      demand: { cpuWeight: 0.25, memoryBytes: 64 * 1024 * 1024, fileDescriptors: 3 },
      payloadRef: `harness-git:${purpose}:${projectPath}`,
      metadata: { purpose },
    },
    async () => execFileP('git', args, options),
  );
}

function phaseFromReq(req: Request) {
  return phasePhaseLabel(new URL(req.url).searchParams.get('phase') ?? undefined);
}

/* ─── git log (cached) ──────────────────────────────────────────────── */

interface GitCommit {
  sha: string; parents: string[]; subject: string; author: string; ts: number; refs: string[];
}

const __gitLogCache = new Map<string, { headSig: string; expires: number; commits: GitCommit[] }>();

async function cachedGitLog(
  projectPath: string,
  limit: number,
  ref: string | null,
  ttlMs = 3000,
): Promise<GitCommit[]> {
  const key = `${projectPath}:${limit}:${ref ?? '*'}`;
  const now = Date.now();
  let headSig = '';
  try {
    const headPath = join(projectPath, '.git', 'HEAD');
    const st = statSync(headPath);
    headSig = `${st.mtimeMs}:${st.size}`;
    // Follow `ref: refs/heads/<branch>` indirection so a commit on the
    // current branch (which doesn't touch HEAD itself) still busts cache.
    try {
      const refContent = readFileSync(headPath, 'utf8').trim();
      if (refContent.startsWith('ref: ')) {
        const refPath = join(projectPath, '.git', refContent.slice(5).trim());
        if (existsSync(refPath)) {
          const rs = statSync(refPath);
          headSig += `|${rs.mtimeMs}`;
        }
      }
    } catch {}
  } catch {}
  const cached = __gitLogCache.get(key);
  if (cached && cached.headSig === headSig && cached.expires > now) return cached.commits;

  const SEP = '\x1f';
  // ref === null means "all worktrees" → --all
  const refArgs = ref ? [ref] : ['--all'];
  const { stdout } = await runGitProcess(
    projectPath,
    [
      '-C', projectPath,
      'log', ...refArgs, '--date-order',
      `--format=%H${SEP}%P${SEP}%s${SEP}%an${SEP}%at${SEP}%D`,
      '-n', String(limit),
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
    'log',
  );
  const commits: GitCommit[] = stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, subject, author, ts, refs] = line.split(SEP);
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        subject: subject ?? '',
        author: author ?? '',
        ts: Number(ts) * 1000,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
      };
    });
  __gitLogCache.set(key, { headSig, expires: now + ttlMs, commits });
  return commits;
}

/* ─── git show (bounded patch streaming) ────────────────────────────── */

/**
 * Path patterns excluded from /git/show patches by default. Generated /
 * agent-written files that produce massive diffs but carry no review
 * value. Opt back in with `?full=1`.
 */
const PATCH_DEFAULT_EXCLUDES = [
  ':(exclude,glob).papercusp/**',
  ':(exclude,glob)**/pnpm-lock.yaml',
  ':(exclude,glob)**/package-lock.json',
  ':(exclude,glob)**/yarn.lock',
  ':(exclude,glob)**/Cargo.lock',
  ':(exclude,glob)**/*.snap',
];

function streamGitPatch(
  cwd: string,
  sha: string,
  byteLimit: number,
  excludePathspecs: string[] = [],
): Promise<{ patch: string; truncated: boolean; totalBytes: number }> {
  return runGovernedOperation({
    workspaceId: activeWorkspaceId(),
    namespace: 'harness-git-patch',
    owner: 'harness-git:show-patch',
    admissionClass: 'process',
    demand: { cpuWeight: 0.5, memoryBytes: byteLimit, fileDescriptors: 3 },
    payloadRef: `harness-git:show:${sha}`,
    metadata: { purpose: 'show-patch' },
  }, async () => new Promise((resolve, reject) => {
    const args = ['-C', cwd, 'show', '--format=', '--patch', '--stat', '-M', sha];
    if (excludePathspecs.length > 0) args.push('--', '.', ...excludePathspecs);
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let collected = 0;
    let totalBytes = 0;
    let truncated = false;
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`git show timed out after 30s (sha=${sha})`));
    }, 30_000);

    child.stdout!.on('data', (buf: Buffer) => {
      totalBytes += buf.length;
      if (collected >= byteLimit) {
        if (!truncated) {
          truncated = true;
          // Kill the git process — for multi-GB diffs draining stdout to
          // completion takes minutes. We have enough; stop the producer.
          try { child.kill('SIGTERM'); } catch {}
        }
        return;
      }
      const remaining = byteLimit - collected;
      if (buf.length <= remaining) {
        chunks.push(buf);
        collected += buf.length;
      } else {
        chunks.push(buf.subarray(0, remaining));
        collected += remaining;
        truncated = true;
        try { child.kill('SIGTERM'); } catch {}
      }
    });
    child.stderr!.on('data', (buf: Buffer) => { stderr += buf.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // SIGTERM is our own truncation kill; treat as success.
      if (code !== 0 && signal !== 'SIGTERM' && !truncated) {
        reject(new Error(`git show exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      const patch = Buffer.concat(chunks).toString('utf8');
      const display = truncated
        ? patch + `\n\n[…truncated at ${byteLimit.toLocaleString()} bytes — full diff exceeds limit; open the commit externally to see all changes]\n`
        : patch;
      resolve({ patch: display, truncated, totalBytes: truncated ? -1 : totalBytes });
    });
  }));
}

/* ─── git worktrees ─────────────────────────────────────────────────── */

interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMain: boolean;
  lastCommitTs: number | null;
}

function parseWorktreePorcelain(stdout: string): WorktreeEntry[] {
  const blocks = stdout.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block, idx) => {
    const wt: WorktreeEntry = {
      path: '',
      head: '',
      branch: null,
      bare: false,
      detached: false,
      locked: false,
      lockedReason: null,
      prunable: false,
      prunableReason: null,
      isMain: idx === 0,
      lastCommitTs: null,
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) wt.path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) wt.head = line.slice('HEAD '.length);
      else if (line === 'bare') wt.bare = true;
      else if (line === 'detached') wt.detached = true;
      else if (line.startsWith('branch ')) {
        wt.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'locked' || line.startsWith('locked ')) {
        wt.locked = true;
        wt.lockedReason = line === 'locked' ? null : line.slice('locked '.length);
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        wt.prunable = true;
        wt.prunableReason = line === 'prunable' ? null : line.slice('prunable '.length);
      }
    }
    return wt;
  }).filter((w) => w.path);
}

/* ─── routes ────────────────────────────────────────────────────────── */

const gitShow = defineTool({
  method: 'GET',
  path: '/harness/:slug/git/show/:sha',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const sha = ctx.params.sha as string;
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) return Response.json({ error: 'bad sha' }, { status: 400 });
    const includeAll = new URL(req.url).searchParams.get('full') === '1';
    try {
      const PATCH_LIMIT = 8 * 1024 * 1024; // 8 MB — bounded so multi-GB diffs don't OOM the operator.
      const excludes = includeAll ? [] : PATCH_DEFAULT_EXCLUDES;
      const [meta, { patch, truncated, totalBytes }] = await Promise.all([
        runGitProcess(
          project.path,
          ['-C', project.path, 'show', '--no-patch', '--format=%H%n%an%n%ae%n%at%n%P%n%s%n%n%b', sha],
          { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
          'show-metadata',
        ).then((r) => r.stdout),
        streamGitPatch(project.path, sha, PATCH_LIMIT, excludes),
      ]);
      const [hash, author, email, ts, parents, subject, ...bodyLines] = meta.split('\n');
      return Response.json({
        sha: hash,
        author,
        email,
        ts: Number(ts) * 1000,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        subject,
        body: bodyLines.join('\n').trim(),
        patch,
        patchTruncated: truncated,
        patchTotalBytes: totalBytes,
      });
    } catch (err: any) {
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 });
    }
  },
});

const gitWorktrees = defineTool({
  method: 'GET',
  path: '/harness/:slug/git/worktrees',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    if (!existsSync(join(project.path, '.git'))) {
      return Response.json({ worktrees: [], notAGitRepo: true });
    }
    try {
      const { stdout } = await runGitProcess(
        project.path,
        ['-C', project.path, 'worktree', 'list', '--porcelain'],
        { maxBuffer: 1024 * 1024, timeout: 10_000 },
        'worktree-list',
      );
      const worktrees = parseWorktreePorcelain(stdout);
      await Promise.all(
        worktrees.map(async (wt) => {
          if (!existsSync(wt.path)) return;
          try {
            const { stdout: ts } = await runGitProcess(
              wt.path,
              ['-C', wt.path, 'log', '-1', '--format=%ct', 'HEAD'],
              { maxBuffer: 4096, timeout: 5_000 },
              'worktree-last-commit',
            );
            const n = Number(ts.trim());
            if (Number.isFinite(n) && n > 0) wt.lastCommitTs = n * 1000;
          } catch {
            // worktree may be locked, prunable, or unreadable — leave null
          }
        }),
      );
      return Response.json({ worktrees });
    } catch (err: any) {
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 });
    }
  },
});

const gitLog = defineTool({
  method: 'GET',
  path: '/harness/:slug/git/log',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });

    // Org-kind harnesses (and any harness whose root isn't a git checkout)
    // legitimately have no git history. Return [] instead of 500ing.
    if (!existsSync(join(project.path, '.git'))) {
      return Response.json({ commits: [], notAGitRepo: true });
    }

    const url = new URL(req.url);
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit') ?? 300)));
    const branch = (url.searchParams.get('branch') ?? '').trim();
    const sha = (url.searchParams.get('sha') ?? '').trim();
    let ref: string | null = null;
    if (branch) {
      if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith('-')) {
        return Response.json({ error: 'bad branch' }, { status: 400 });
      }
      ref = branch;
    } else if (sha) {
      if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
        return Response.json({ error: 'bad sha' }, { status: 400 });
      }
      ref = sha;
    }
    try {
      const commits = await cachedGitLog(project.path, limit, ref);
      return Response.json({ commits });
    } catch (err: any) {
      return Response.json({ error: err?.message ?? String(err) }, { status: 500 });
    }
  },
});

const gitStats = defineTool({
  method: 'GET',
  path: '/harness/:slug/git/stats',
  auth: 'public',
  async handler(req, ctx) {
    const project = await resolvePhasedProject(ctx.params.slug as string, phaseFromReq(req));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    try {
      const stats = await readGitStats(project.path, { refresh });
      return Response.json({ stats });
    } catch (error) {
      if (error instanceof NotGitRepositoryError) {
        return Response.json({ stats: null, notAGitRepo: true });
      }
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
});

export default [gitShow, gitWorktrees, gitLog, gitStats];
