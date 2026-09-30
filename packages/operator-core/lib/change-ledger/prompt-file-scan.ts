/**
 * prompt-file-scan.ts — the repo-edit leg of the behavior-change ledger
 * (self-learning-frontier-2026-06-12 P-004 / FB-02).
 *
 * Playbook/persona/spawn-prompt sources are FILES (apps/operator/prompts/*,
 * libs/papercusp/packages/harness/prompts/*) edited by agents and humans with
 * ordinary file writes — there is no code write-path to hook. The mutations
 * are recovered from git history instead: `system:change-ledger-scan`
 * (change-ledger-scan-action.ts) re-reads a trailing `git log` window every
 * tick and offers one ledger row per (commit, file). Idempotency is the
 * ledger's dedupe index — re-offered (sha, file) pairs no-op — so the scan
 * needs no watermark state.
 *
 * Rows backfill `recorded_at` with the COMMIT time (not scan time): the
 * mutation-calendar's liveness window must read true mutation times, or the
 * first scan would make two weeks of history look like a live mutation burst.
 *
 * Parsing is PURE over the git-log text (unit-testable without git);
 * `scanRepoPromptEdits` takes injected deps (runGitLog + record), mirroring
 * the collector style in harness/improvements/.
 */

import type { RecordBehaviorChangeInput } from './change-ledger';

/** Repo-relative prompt-source roots whose file edits are behavior-affecting.
 *  (CLAUDE.md § prompts: chat-surface roles + psu playbooks live in
 *  apps/operator/prompts; harness spawn personas in the blueprint role libraries
 *  libs/papercusp/packages/harness/blueprints/<id>/prompts — the global prompts/
 *  dir was deleted in blueprint-role-bundling Phase 5.) */
export const PROMPT_SOURCE_PATHS = [
  'apps/operator/prompts',
  'libs/papercusp/packages/harness/blueprints',
] as const;

/** The git-log invocation contract `parsePromptEditLog` expects:
 *  one `%H\t%ct\t%an\t%s` header line per commit followed by its file list
 *  (--name-only), blank-line separated. */
export const PROMPT_SCAN_GIT_ARGS = (paths: readonly string[], sinceDays: number): string[] => [
  'log',
  `--since=${sinceDays}.days`,
  '--no-merges',
  '--name-only',
  '--pretty=format:%H%x09%ct%x09%an%x09%s',
  '--',
  ...paths,
];

export interface PromptFileEdit {
  sha: string;
  /** Commit time, ms. */
  tsMs: number;
  author: string;
  subject: string;
  /** Repo-relative path of one edited prompt-source file. */
  file: string;
}

/** Pure parse of `git log --name-only --pretty=format:%H%x09%ct%x09%an%x09%s`
 *  output into one entry per (commit, file). Tolerates blank separators and
 *  ignores malformed lines. */
export function parsePromptEditLog(raw: string): PromptFileEdit[] {
  const edits: PromptFileEdit[] = [];
  let header: Omit<PromptFileEdit, 'file'> | null = null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') {
      header = null;
      continue;
    }
    const parts = trimmed.split('\t');
    if (parts.length >= 4 && /^[0-9a-f]{40}$/i.test(parts[0])) {
      const tsSec = Number.parseInt(parts[1], 10);
      header = Number.isFinite(tsSec)
        ? { sha: parts[0], tsMs: tsSec * 1000, author: parts[2], subject: parts.slice(3).join('\t') }
        : null;
      continue;
    }
    if (header) edits.push({ ...header, file: trimmed });
  }
  return edits;
}

export interface PromptScanDeps {
  /** Run git log with PROMPT_SCAN_GIT_ARGS against the serving tree; return raw stdout. */
  runGitLog: (paths: readonly string[], sinceDays: number) => Promise<string>;
  /** recordBehaviorChange (injected for tests). */
  record: (input: RecordBehaviorChangeInput) => Promise<string | null>;
  workspaceId: string;
}

export interface PromptScanResult {
  /** (commit, file) pairs the log window yielded. */
  edits: number;
  /** Rows actually inserted (the rest deduped, flag-off, or failed — all best-effort). */
  recorded: number;
}

/** One scan pass: read the trailing window, offer every (commit, file) pair to
 *  the ledger. Dedupe makes re-runs free; sinceDays only bounds the window. */
export async function scanRepoPromptEdits(
  deps: PromptScanDeps,
  opts: { sinceDays?: number } = {},
): Promise<PromptScanResult> {
  const sinceDays = Math.min(Math.max(1, opts.sinceDays ?? 14), 90);
  const raw = await deps.runGitLog(PROMPT_SOURCE_PATHS, sinceDays);
  const edits = parsePromptEditLog(raw);
  let recorded = 0;
  for (const e of edits) {
    const id = await deps.record({
      workspaceId: deps.workspaceId,
      source: 'repo-scan',
      action: 'edit',
      targetKind: 'prompt-file',
      target: e.file,
      diffRef: e.sha,
      actor: e.author,
      summary: e.subject.slice(0, 300),
      recordedAtMs: e.tsMs,
    });
    if (id) recorded += 1;
  }
  return { edits: edits.length, recorded };
}
