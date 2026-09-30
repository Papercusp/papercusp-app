/**
 * Sync-with-main routes (Phase 9 P-055).
 *
 *   GET  /api/harness/:slug/sync-status
 *        body: { github_user_id: number }
 *        → SyncStatusSnapshot
 *
 *   POST /api/harness/:slug/sync-with-main
 *        body: { github_user_id: number }
 *        → { outcome: 'clean' | 'conflict' | 'fetch_failed'; conflicted_files?: string[] }
 *
 *   POST /api/harness/:slug/sync-with-main/abort
 *        body: { github_user_id: number }
 *        → { ok: true }
 *
 * All operations run git in the user's worktree at
 * <harness-root>/.papercusp/user-trees/<github_user_id>/.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveProject } from '../../../harness-core';
import {
  userTreeAbsPath,
  userBranchRef,
} from '../../../harness/user-tree-types';
import {
  snapshotFromBehindCount,
  snapshotFromPollError,
  type SyncStatusSnapshot,
} from '../../../harness/sync-with-main-types';

const execFileAsync = promisify(execFile);

// ─── GET /harness/:slug/sync-status ──────────────────────────────

const syncStatus = defineTool({
  method: 'GET',
  path: '/harness/:slug/sync-status',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const url = new URL(req.url);
    const githubUserIdParam = url.searchParams.get('github_user_id');
    const githubUserId = githubUserIdParam ? parseInt(githubUserIdParam, 10) : 0;

    if (!Number.isFinite(githubUserId) || githubUserId <= 0) {
      return Response.json({ error: 'github_user_id required' }, { status: 400 });
    }

    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const treePath = userTreeAbsPath({ harnessRoot: project.path, githubUserId });
    const now = Date.now();

    if (!existsSync(treePath)) {
      const snap: SyncStatusSnapshot = snapshotFromPollError({
        harness_slug: slug,
        github_user_id: githubUserId,
        error_message: 'user worktree not provisioned',
        now,
      });
      return Response.json(snap);
    }

    // Fetch origin/main silently, then count commits behind.
    try {
      await execFileAsync('git', ['-C', treePath, 'fetch', 'origin', 'main', '--quiet'], {
        timeout: 15_000,
      });
    } catch (err) {
      const snap = snapshotFromPollError({
        harness_slug: slug,
        github_user_id: githubUserId,
        error_message: String(err).slice(0, 200),
        now,
      });
      return Response.json(snap);
    }

    let behindCount = 0;
    try {
      const branchRef = userBranchRef(githubUserId);
      const { stdout } = await execFileAsync(
        'git',
        ['-C', treePath, 'rev-list', '--count', `${branchRef}..origin/main`],
        { timeout: 5_000 },
      );
      behindCount = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(behindCount) || behindCount < 0) behindCount = 0;
    } catch (err) {
      const snap = snapshotFromPollError({
        harness_slug: slug,
        github_user_id: githubUserId,
        error_message: String(err).slice(0, 200),
        now,
      });
      return Response.json(snap);
    }

    const snap = snapshotFromBehindCount({
      harness_slug: slug,
      github_user_id: githubUserId,
      behind_count: behindCount,
      now,
    });
    return Response.json(snap);
  },
});

// ─── POST /harness/:slug/sync-with-main ──────────────────────────

const syncWithMain = defineTool({
  method: 'POST',
  path: '/harness/:slug/sync-with-main',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = (await req.json().catch(() => ({}))) as { github_user_id?: number };
    const githubUserId = body.github_user_id ?? 0;

    if (!Number.isFinite(githubUserId) || githubUserId <= 0) {
      return Response.json({ error: 'github_user_id required' }, { status: 400 });
    }

    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const treePath = userTreeAbsPath({ harnessRoot: project.path, githubUserId });
    if (!existsSync(treePath)) {
      return Response.json({ error: 'user worktree not provisioned' }, { status: 422 });
    }

    // Fetch first.
    try {
      await execFileAsync('git', ['-C', treePath, 'fetch', 'origin', 'main', '--quiet'], {
        timeout: 15_000,
      });
    } catch (err) {
      return Response.json({ outcome: 'fetch_failed', error: String(err).slice(0, 200) });
    }

    // Rebase onto origin/main.
    try {
      await execFileAsync('git', ['-C', treePath, 'rebase', 'origin/main'], {
        timeout: 30_000,
      });
      return Response.json({ outcome: 'clean' });
    } catch {
      // Rebase produced a conflict. List conflicted files.
      let conflicted: string[] = [];
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', treePath, 'diff', '--name-only', '--diff-filter=U'],
          { timeout: 5_000 },
        );
        conflicted = stdout.trim().split('\n').filter(Boolean);
      } catch {
        // Best-effort — return empty list if we can't enumerate.
      }
      return Response.json({ outcome: 'conflict', conflicted_files: conflicted });
    }
  },
});

// ─── POST /harness/:slug/sync-with-main/abort ────────────────────

const abortRebase = defineTool({
  method: 'POST',
  path: '/harness/:slug/sync-with-main/abort',
  auth: 'loopback',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    const body = (await req.json().catch(() => ({}))) as { github_user_id?: number };
    const githubUserId = body.github_user_id ?? 0;

    if (!Number.isFinite(githubUserId) || githubUserId <= 0) {
      return Response.json({ error: 'github_user_id required' }, { status: 400 });
    }

    const project = await resolveProject(slug);
    if (!project) {
      return Response.json({ error: 'unknown project' }, { status: 404 });
    }

    const treePath = userTreeAbsPath({ harnessRoot: project.path, githubUserId });
    if (!existsSync(treePath)) {
      return Response.json({ error: 'user worktree not provisioned' }, { status: 422 });
    }

    try {
      await execFileAsync('git', ['-C', treePath, 'rebase', '--abort'], { timeout: 10_000 });
    } catch {
      // --abort fails if no rebase is in progress — that's fine.
    }
    return Response.json({ ok: true });
  },
});

export default [syncStatus, syncWithMain, abortRebase];
