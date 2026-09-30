/**
 * `papercusp project-history generate` — build a portable Project History v2
 * artifact from Papercusp plan/work-item ledgers plus the project's Git repo.
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  ProjectHistoryCommitInput,
  ProjectHistoryDocument,
  ProjectHistoryPlanInput,
  ProjectHistoryProject,
  ProjectHistoryProvider,
  ProjectHistoryRepository,
  ProjectHistoryWorkItemInput,
} from '@papercusp/plan-parser/project-history';
import {
  redactProjectHistoryText,
  resolveProjectHistoryIdentityEntries,
  type ProjectHistoryIdentityEntry,
} from './project-history-redaction.ts';

type OutputFormat = 'json' | 'typescript';

export interface ProjectHistoryGenerateOptions {
  workspace: string;
  harness: string;
  planPrefix: string | null;
  projectId: string;
  projectName: string;
  repoRoot: string;
  /**
   * Additional repositories whose commits also belong to this product's history
   * (`--extra-repo`, repeatable). A product can span repos — SideStage's iOS/Android
   * work lives in `sidestage-mobile` — and a work item completed there otherwise shows
   * zero commits, which reads as "the GitHub links are gone" (WI-39898). Each extra
   * repo resolves its OWN remote, so its commits link to the right GitHub project.
   * The primary `repoRoot` remains the one published as `project.repository`.
   */
  extraRepoRoots: readonly string[];
  output: string;
  format: OutputFormat;
  exportName: string;
  generatedAt: string;
  check: boolean;
  repositoryUrl: string | null;
  repositoryWebUrl: string | null;
  defaultBranch: string | null;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface CommandRunner {
  run(command: string, args: readonly string[], options: { cwd: string; input?: string }): CommandResult;
}

const defaultRunner: CommandRunner = {
  run(command, args, options) {
    const result = spawnSync(command, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      input: options.input,
      maxBuffer: 128 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
    };
  },
};

function takeOption(
  args: string[],
  index: number,
  name: string,
  allowEmpty = false,
): { value: string; consumed: number } | null {
  const argument = args[index];
  if (argument === name) {
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') || (!allowEmpty && value.length === 0)) {
      throw new Error(`${name} requires a value`);
    }
    return { value, consumed: 2 };
  }
  if (argument?.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!allowEmpty && value.length === 0) throw new Error(`${name} requires a value`);
    return { value, consumed: 1 };
  }
  return null;
}

export function parseProjectHistoryGenerateArgs(
  argv: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): ProjectHistoryGenerateOptions {
  const args = [...argv];
  const values = new Map<string, string>();
  // --extra-repo is REPEATABLE, so it cannot live in the single-value map above:
  // a second occurrence would silently overwrite the first and drop a whole repo's
  // commits with nothing to show for it.
  const extraRepoRoots: string[] = [];
  let check = false;
  for (let index = 0; index < args.length;) {
    if (args[index] === '--check') {
      check = true;
      index += 1;
      continue;
    }
    const names = [
      '--workspace', '--harness', '--prefix', '--project-id', '--project-name',
      '--repo', '--extra-repo', '--output', '--format', '--export-name', '--generated-at',
      '--repository-url', '--repository-web-url', '--default-branch',
    ];
    const name = names.find((candidate) => args[index] === candidate || args[index]?.startsWith(`${candidate}=`));
    if (!name) throw new Error(`project-history generate: unknown argument ${args[index]}`);
    const parsed = takeOption(args, index, name, name === '--prefix');
    if (!parsed) throw new Error(`project-history generate: invalid argument ${args[index]}`);
    if (name === '--extra-repo') extraRepoRoots.push(parsed.value);
    else values.set(name, parsed.value);
    index += parsed.consumed;
  }

  const harness = values.get('--harness');
  if (!harness) throw new Error('project-history generate requires --harness <slug>');
  const repoRoot = resolve(cwd, values.get('--repo') ?? '.');
  const output = resolve(cwd, values.get('--output') ?? '.papercusp/project-history.v2.json');
  const rawFormat = values.get('--format') ?? (output.endsWith('.ts') ? 'typescript' : 'json');
  if (rawFormat !== 'json' && rawFormat !== 'typescript' && rawFormat !== 'ts') {
    throw new Error('--format must be json or typescript');
  }
  const exportName = values.get('--export-name') ?? 'PROJECT_HISTORY';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(exportName)) {
    throw new Error('--export-name must be a valid JavaScript identifier');
  }
  const generatedAt = values.get('--generated-at') ?? now.toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('--generated-at must be an ISO-compatible timestamp');

  return {
    workspace: values.get('--workspace') ?? env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace',
    harness,
    planPrefix: values.has('--prefix') ? values.get('--prefix') || null : `${harness}-`,
    projectId: values.get('--project-id') ?? harness,
    projectName: values.get('--project-name') ?? harness,
    repoRoot,
    extraRepoRoots: extraRepoRoots.map((root) => resolve(cwd, root)),
    output,
    format: rawFormat === 'ts' ? 'typescript' : rawFormat,
    exportName,
    generatedAt,
    check,
    repositoryUrl: values.get('--repository-url') ?? null,
    repositoryWebUrl: values.get('--repository-web-url') ?? null,
    defaultBranch: values.get('--default-branch') ?? null,
  };
}

function checked(result: CommandResult, description: string): string {
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message || 'unknown failure';
    throw new Error(`${description} failed (${result.status ?? 'signal'}): ${detail}`);
  }
  return result.stdout;
}

function ptool(
  runner: CommandRunner,
  options: ProjectHistoryGenerateOptions,
  tool: string,
  args: Record<string, unknown>,
): unknown {
  const stdout = checked(runner.run('ptool', [
    tool,
    '--json',
    '-',
    `--workspace=${options.workspace}`,
    `--harness=${options.harness}`,
  ], {
    cwd: options.repoRoot,
    input: `${JSON.stringify(args)}\n`,
  }), tool);
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(`${tool} returned invalid JSON`, { cause });
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function planRows(payload: unknown): Record<string, unknown>[] {
  const root = object(payload);
  if (Array.isArray(root?.plans)) return records(root.plans);
  const first = records(root?.results)[0];
  return records(first?.plans);
}

/**
 * A bounded-payload envelope is the shape the result projector substitutes when a
 * payload exceeds the transport budget: `results` is GONE, replaced by a `summary`
 * string and a `_projection` report. `records(root.results)` reads that as `[]`.
 *
 * That empty array is not "no work items" — it is "the answer did not fit", and the
 * two were indistinguishable for the entire life of this bug (WI-39831). Detect it
 * and THROW, so the failure can never again be silent. Kept (and exercised) even
 * though the work-item leg now reads files: it is the recurrence guard for anyone
 * who routes a bulk ledger read back through the payload.
 */
export function workItemRows(payload: unknown): Record<string, unknown>[] {
  const root = object(payload);
  if (root && !Array.isArray(root.results) && (root._projection !== undefined || typeof root.summary === 'string')) {
    const projection = object(root._projection);
    const detail = projection
      ? ` (tier=${String(projection.tier)}, ${String(projection.returnedChars)} of ${String(projection.originalChars)} chars, ${String(projection.omittedCount)} omitted)`
      : '';
    throw new Error(
      `work-item payload was TRUNCATED by the result projector${detail}: it carries no \`results\` array, `
      + 'only a bounded-payload envelope. Reading this as "no work items" is the WI-39831 defect. '
      + 'Bulk ledger reads must go through work_items:export { toDir } (files), not the result payload.',
    );
  }
  return records(root?.results)
    .map((row) => object(row.workItem))
    .filter((row): row is Record<string, unknown> => row !== null);
}

/** `work_items:export` returns counts only — the rows are on disk. */
function exportedCount(payload: unknown, leg: string): number {
  const root = object(payload);
  if (!root || root.ok !== true) {
    throw new Error(`work_items:export (${leg} leg) did not report ok: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  if (root.truncatedByLimit === true) {
    throw new Error(
      `work_items:export (${leg} leg) hit its row limit, so this export is PARTIAL. Refusing to publish a `
      + 'Project History built from a silently short ledger read — raise `limit` or narrow the harness.',
    );
  }
  return typeof root.written === 'number' ? root.written : 0;
}

type RemoveDirectory = (
  directory: string,
  options: { recursive: true; force: true; maxRetries: number; retryDelay: number },
) => Promise<void>;

/** Large file exports can transiently leave an entry behind while recursive removal walks. */
export async function removeProjectHistoryExportDirectory(
  directory: string,
  remove: RemoveDirectory = fs.rm,
): Promise<void> {
  await remove(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 20,
  });
}

/**
 * Read every `<id>.json` an export wrote and map it onto the History work-item shape.
 * Both export legs write into the same directory, so the union is deduplicated by
 * filename for free.
 */
export const PROJECT_HISTORY_FILE_READ_CONCURRENCY = 64;

type ReadFile = (file: string, encoding: 'utf8') => Promise<string>;

export async function readExportedWorkItems(
  directory: string,
  readFile: ReadFile = fs.readFile,
): Promise<{ items: ProjectHistoryWorkItemInput[]; fileEvidence: WorkItemFileEvidence[] }> {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const items: ProjectHistoryWorkItemInput[] = [];
  const fileEvidence: WorkItemFileEvidence[] = [];
  for (let offset = 0; offset < entries.length; offset += PROJECT_HISTORY_FILE_READ_CONCURRENCY) {
    const loaded = await Promise.all(
      entries.slice(offset, offset + PROJECT_HISTORY_FILE_READ_CONCURRENCY).map(async (entry) => {
        const raw = await readFile(join(directory, entry.name), 'utf8');
        // A malformed row is a real export failure, not a row to skip quietly.
        const row = object(JSON.parse(raw) as unknown);
        if (!row) throw new Error(`work_items:export wrote a non-object row at ${entry.name}`);
        const id = string(row.id);
        const title = string(row.title);
        if (!id || !title) return null;
        const evidence = object(row.terminalCompletionEvidence)
          ?? object(object(row.payload)?._completionEvidence);
        const planItem = object(object(row.payload)?.plan_item);
        const planSlug = string(planItem?.plan_slug) ?? string(row.sourcePlanSlug);
        const item: ProjectHistoryWorkItemInput = {
          id,
          kind: string(row.kind) ?? 'work-item',
          title,
          state: string(row.state) ?? 'unknown',
          completedAt: string(row.closedAt),
          completionAuthority: string(row.completionAuthority) ?? 'work-item-ledger',
          completionSummary: string(evidence?.summary),
          completionEvidence: evidence,
          planSlugs: planSlug ? [planSlug] : undefined,
        };
        const changed = Array.isArray(evidence?.filesChanged)
          ? (evidence.filesChanged as unknown[]).filter((file): file is string => typeof file === 'string')
          : [];
        const closedAt = string(row.closedAt);
        const closedAtMs = closedAt ? Date.parse(closedAt) : Number.NaN;
        const evidenceRow = changed.length > 0 && Number.isFinite(closedAtMs)
          ? { id, filesChanged: changed, closedAtMs } satisfies WorkItemFileEvidence
          : null;
        return { item, evidenceRow };
      }),
    );
    for (const result of loaded) {
      if (!result) continue;
      items.push(result.item);
      if (result.evidenceRow) fileEvidence.push(result.evidenceRow);
    }
  }
  return { items, fileEvidence };
}

/** Public `work_items:export.ids` schema ceiling. Rows stay in files, never payloads. */
export const WORK_ITEMS_EXPORT_IDS_BATCH_SIZE = 2_000;

/**
 * Export marker-referenced ids without exceeding the tool argument schema.
 *
 * This is intentionally NOT the deleted 25-row `work_items:get` payload batching:
 * no row crosses the bounded result transport here. Every call writes whole rows to
 * the same directory and returns counts only, so splitting the ID argument is lossless.
 */
export function exportWorkItemsByIdBatches(
  ids: readonly string[],
  exportBatch: (batch: readonly string[]) => number,
): number {
  const unique = [...new Set(ids)];
  let written = 0;
  for (let offset = 0; offset < unique.length; offset += WORK_ITEMS_EXPORT_IDS_BATCH_SIZE) {
    written += exportBatch(unique.slice(offset, offset + WORK_ITEMS_EXPORT_IDS_BATCH_SIZE));
  }
  return written;
}

/**
 * The complete harness export already materializes every terminal row. Only
 * marker-referenced rows absent from that directory need the ID export: those
 * are typically non-terminal rows referenced by a plan's completion marker.
 * Preserve first-seen ID order and let the shared batch helper enforce the
 * public argument ceiling.
 */
export async function exportMissingWorkItemsByIdBatches(
  directory: string,
  ids: readonly string[],
  exportBatch: (batch: readonly string[]) => number,
): Promise<number> {
  if (ids.length === 0) return 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const exportedIds = new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => basename(entry.name, '.json')),
  );
  const missing = [...new Set(ids)].filter((id) => !exportedIds.has(id));
  return exportWorkItemsByIdBatches(missing, exportBatch);
}

function git(runner: CommandRunner, repoRoot: string, args: readonly string[], allowFailure = false): string {
  const result = runner.run('git', args, { cwd: repoRoot });
  if (allowFailure && result.status !== 0) return '';
  return checked(result, `git ${args.join(' ')}`);
}

export function githubWebUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '').replace(/\/$/, '');
  const scp = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scp) return `https://github.com/${scp[1]}`;
  const ssh = /^ssh:\/\/(?:git@)?github\.com\/(.+)$/i.exec(trimmed);
  if (ssh) return `https://github.com/${ssh[1]}`;
  const http = /^https?:\/\/github\.com\/(.+)$/i.exec(trimmed);
  if (http) return `https://github.com/${http[1]}`;
  return null;
}

export function repositoryFromRemote(
  remoteUrl: string | null,
  webUrl: string | null,
  defaultBranch: string | null,
): ProjectHistoryRepository | null {
  const url = remoteUrl ?? webUrl;
  if (!url) return null;
  const normalizedWebUrl = webUrl ?? githubWebUrl(url);
  return {
    provider: normalizedWebUrl?.startsWith('https://github.com/') ? 'github' : 'git',
    url,
    webUrl: normalizedWebUrl,
    defaultBranch,
  };
}

interface ParsedGitCommit {
  sha: string;
  subject: string | null;
  committedAt: string | null;
  body: string;
  files: string[];
}

export function parseGitLog(raw: string): ParsedGitCommit[] {
  const commits: ParsedGitCommit[] = [];
  for (const record of raw.split('\u001e')) {
    const fields = record.split('\0');
    const sha = fields[0]?.trim();
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha) || fields.length < 5) continue;
    commits.push({
      sha,
      subject: fields[1] || null,
      committedAt: fields[2] || null,
      body: fields[3] ?? '',
      files: [...new Set(fields.slice(4).join('\0').split(/\r?\n/).map((file) => file.trim()).filter(Boolean))].sort(),
    });
  }
  return commits;
}

export function commitsForWorkItems(
  commits: readonly ParsedGitCommit[],
  ids: readonly string[],
  remotelyKnownShas: ReadonlySet<string> | null,
): ProjectHistoryCommitInput[] {
  const requested = new Set(ids);
  const output: ProjectHistoryCommitInput[] = [];
  for (const commit of commits) {
    const authoritative = new Set(
      [...commit.body.matchAll(/^Papercusp-Work-Item:\s*((?:WI|EI|F)-\d+)\s*$/gim)]
        .map((match) => match[1])
        .filter((id): id is string => Boolean(id && requested.has(id))),
    );
    const referenced = new Set(
      [...commit.body.matchAll(/\b(?:WI|EI|F)-\d+\b/g)]
        .map((match) => match[0])
        .filter((id) => requested.has(id)),
    );
    const links: ProjectHistoryCommitInput['links'] = [
      ...[...authoritative].map((workItemId) => ({ workItemId, attribution: 'authoritative' as const })),
      ...[...referenced]
        .filter((workItemId) => !authoritative.has(workItemId))
        .map((workItemId) => ({ workItemId, attribution: 'body-reference' as const })),
    ];
    if (links.length === 0) continue;
    output.push({
      sha: commit.sha,
      subject: commit.subject,
      committedAt: commit.committedAt,
      files: commit.files,
      remoteStatus: remotelyKnownShas === null
        ? 'unknown'
        : remotelyKnownShas.has(commit.sha) ? 'confirmed' : 'local-only',
      links,
    });
  }
  return output;
}

/** What a work item's own completion record says it changed, and when it closed. */
export interface WorkItemFileEvidence {
  id: string;
  filesChanged: readonly string[];
  closedAtMs: number;
}

/**
 * How far from `closedAt` an inferred commit may sit. Deliberately TIGHT.
 *
 * Calibrated against the sidestage ledger 2026-08-18 (365 items carrying
 * filesChanged + closedAt, 1,241 commits): widening 6h → 72h moved coverage by
 * 3 items (230 → 233). The matching commit is essentially always adjacent in
 * time, so a wide window buys nothing and only widens the chance of pinning an
 * unrelated commit onto an item.
 */
export const INFERRED_COMMIT_WINDOW_MS = 6 * 60 * 60 * 1000;

/** At most this many inferred commits per item — the strongest few, not a dragnet. */
export const INFERRED_COMMITS_PER_ITEM = 3;

/**
 * Infer commit links from a work item's OWN completion evidence, for the ~85% of
 * commits that carry no `Papercusp-Work-Item:` trailer (git-sync sweeps the whole
 * tree on a schedule under one identity, so most commits are unattributable by
 * message alone — 1,239 commits / 182 trailer lines / 23 distinct ids here).
 *
 * A commit is admitted only when it covers a MAJORITY of the item's changed files
 * within the window. That is the conservative half of the trade: measured, it links
 * 63% of eligible items where a touches-any-file rule links 76%. The looser rule was
 * rejected on purpose — a confidently-wrong commit attribution is strictly worse than
 * an empty Commits section, which is the entire lesson of WI-39831. The uncertainty
 * that remains rides on `attribution: 'inferred'`, the third variant the schema has
 * always declared and nothing has ever produced.
 *
 * ⚠ Do NOT reach for `terminalCompletionEvidence.treeStamp.headSha` here (D-002): it
 * is the HEAD of the PAPERCUSP control-plane tree the completing agent ran in, not of
 * the product repo — measured, it does not even resolve as an object in the product
 * repo — and even in the right repo it is HEAD at completion, which for a scheduled
 * git-sync is typically BEFORE the work was committed.
 */
export function inferredCommitLinks(
  commits: readonly ParsedGitCommit[],
  evidence: readonly WorkItemFileEvidence[],
  remotelyKnownShas: ReadonlySet<string> | null,
): ProjectHistoryCommitInput[] {
  const output: ProjectHistoryCommitInput[] = [];
  for (const item of evidence) {
    const changed = new Set(item.filesChanged.filter((file) => typeof file === 'string' && file.length > 0));
    if (changed.size === 0 || !Number.isFinite(item.closedAtMs)) continue;
    const required = Math.ceil(changed.size / 2);

    const scored: { commit: ParsedGitCommit; overlap: number; distance: number }[] = [];
    for (const commit of commits) {
      const committedAtMs = commit.committedAt ? Date.parse(commit.committedAt) : Number.NaN;
      if (!Number.isFinite(committedAtMs)) continue;
      const distance = Math.abs(committedAtMs - item.closedAtMs);
      if (distance > INFERRED_COMMIT_WINDOW_MS) continue;
      let overlap = 0;
      for (const file of commit.files) if (changed.has(file)) overlap++;
      if (overlap < required) continue;
      scored.push({ commit, overlap, distance });
    }

    scored.sort((left, right) => (right.overlap - left.overlap) || (left.distance - right.distance));
    for (const { commit } of scored.slice(0, INFERRED_COMMITS_PER_ITEM)) {
      output.push({
        sha: commit.sha,
        subject: commit.subject,
        committedAt: commit.committedAt,
        files: commit.files,
        remoteStatus: remotelyKnownShas === null
          ? 'unknown'
          : remotelyKnownShas.has(commit.sha) ? 'confirmed' : 'local-only',
        links: [{ workItemId: item.id, attribution: 'inferred' as const }],
      });
    }
  }
  return output;
}

export function renderProjectHistory(
  document: ProjectHistoryDocument,
  format: OutputFormat,
  exportName: string,
  identityEntries?: readonly ProjectHistoryIdentityEntry[],
): string {
  // Ledger prose is internal and may contain real identities. Scrub only this disposable
  // rendered copy; callers still retain the authoritative document untouched in memory/storage.
  const json = redactProjectHistoryText(JSON.stringify(document, null, 2), identityEntries);
  if (format === 'json') return `${json}\n`;
  return [
    '/* Generated by `papercusp project-history generate`. Do not edit by hand. */',
    `export const ${exportName} = ${json} as const;`,
    '',
  ].join('\n');
}

function parseRenderedProjectHistory(rendered: string, format: OutputFormat): ProjectHistoryDocument {
  if (format === 'json') return JSON.parse(rendered) as ProjectHistoryDocument;
  const match = rendered.trim().match(
    /export\s+const\s+[A-Za-z_$][\w$]*\s*=\s*([\s\S]+)\s+as\s+const;?$/,
  );
  if (!match?.[1]) throw new Error('generated TypeScript Project History has an unsupported shape');
  return JSON.parse(match[1]) as ProjectHistoryDocument;
}

/** Check semantic freshness while treating generatedAt as provenance, not content. */
export function projectHistoryOutputIsCurrent(
  current: string,
  generated: string,
  format: OutputFormat,
): boolean {
  try {
    const left = parseRenderedProjectHistory(current, format);
    const right = parseRenderedProjectHistory(generated, format);
    if (left.source && right.source) left.source.generatedAt = right.source.generatedAt;
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

class PtoolGitProjectHistoryProvider implements ProjectHistoryProvider {
  private readonly options: ProjectHistoryGenerateOptions;
  private readonly runner: CommandRunner;
  /** Populated by loadWorkItems; consumed by loadCommits for `inferred` attribution. */
  private fileEvidence: WorkItemFileEvidence[] = [];

  constructor(
    options: ProjectHistoryGenerateOptions,
    runner: CommandRunner,
  ) {
    this.options = options;
    this.runner = runner;
  }

  async loadPlans(): Promise<readonly ProjectHistoryPlanInput[]> {
    const listed = planRows(ptool(this.runner, this.options, 'plans:list', {
      harness: this.options.harness,
      compact: true,
      limit: 500,
      order: 'updated',
      // The export includes archived plans (they stay product history — see
      // loadProjectHistoryPlansFromExport), so the metadata list must too, or every archived
      // plan silently loses its `updated` timestamp.
      includeArchived: true,
    }));

    const exportDirectory = await fs.mkdtemp(join(tmpdir(), 'papercusp-project-history-'));
    try {
      ptool(this.runner, this.options, 'plans:export', {
        harness: this.options.harness,
        toDir: exportDirectory,
      });
      return await loadProjectHistoryPlansFromExport(
        exportDirectory,
        listed,
        this.options.planPrefix,
      );
    } finally {
      await removeProjectHistoryExportDirectory(exportDirectory);
    }
  }

  /**
   * Work items come out through `work_items:export { toDir }` — FILES — never
   * through the result payload.
   *
   * This used to batch 25 ids through `tools:invoke { work_items:get }` and read
   * `payload.results`. The result payload is a bounded transport (~3.5KB after
   * projection), so every batch came back as `{ summary, _projection }` with no
   * `results` at all, and this method returned `[]` on every call — silently,
   * with a zero exit. `generateProjectHistory` then fell through to the
   * `completedWorkItemsFromPlan` compatibility stub, and the published History
   * showed 327 of 327 items as evidence-free `plan-ledger` records while 505
   * fully-evidenced completions sat in the ledger (WI-39831, plan
   * project-history-real-completion-evidence-2026-08-18 D-003).
   *
   * Batch size is NOT the fix and must not be reintroduced as one: a single fat
   * row can exceed the budget alone, so no fixed N is safe.
   *
   * TWO exports land in one directory and the union is read back:
   *   1. by HARNESS — every terminal row, which is what admits work by its own
   *      ledger linkage (`payload.plan_item.plan_slug`) rather than only by a
   *      `← WI-NNN completed` marker someone remembered to write (P-005).
   *   2. by ID — only marker-referenced ids that are not already materialized by
   *      the harness enumeration, which picks up anything that enumeration misses
   *      (a referenced row that is not terminal) without rewriting every terminal
   *      row a second time.
   */
  async loadWorkItems(ids: readonly string[]): Promise<readonly ProjectHistoryWorkItemInput[]> {
    const exportDirectory = await fs.mkdtemp(join(tmpdir(), 'papercusp-project-history-items-'));
    try {
      const harnessExport = exportedCount(ptool(this.runner, this.options, 'work_items:export', {
        harness: this.options.harness,
        toDir: exportDirectory,
      }), 'harness');

      const idExport = await exportMissingWorkItemsByIdBatches(
        exportDirectory,
        ids,
        (batch) => exportedCount(
          ptool(this.runner, this.options, 'work_items:export', {
            ids: [...batch],
            harness: this.options.harness,
            toDir: exportDirectory,
          }),
          'ids',
        ),
      );

      const { items, fileEvidence } = await readExportedWorkItems(exportDirectory);
      // generateProjectHistory calls loadWorkItems before loadCommits, so the file
      // evidence each item published about ITSELF is available to attribute commits
      // that carry no work-item trailer.
      this.fileEvidence = fileEvidence;

      // The silent zero is what shipped this bug, so it is now the loud case.
      // Both legs resolving nothing while the plans clearly reference work is a
      // broken export door, never a project with no completed work.
      if (ids.length > 0 && items.length === 0) {
        throw new Error(
          `work_items:export resolved 0 work items for harness "${this.options.harness}" `
          + `while the plan ledger references ${ids.length}. Refusing to emit a Project `
          + 'History document built entirely from plan-completion markers — that is the '
          + 'evidence-free output this export exists to prevent (WI-39831). '
          + `Reported written: harness=${harnessExport}, ids=${idExport}.`,
        );
      }
      return items;
    } finally {
      await removeProjectHistoryExportDirectory(exportDirectory);
    }
  }

  /**
   * Commits from ONE repo. `repository` is stamped onto every returned commit only for
   * a SECONDARY repo — the primary repo's commits leave it undefined and resolve against
   * `project.repository`, keeping existing single-repo output byte-identical.
   */
  private commitsFromRepo(
    repoRoot: string,
    ids: readonly string[],
    repository: ProjectHistoryRepository | null,
  ): readonly ProjectHistoryCommitInput[] {
    const log = git(this.runner, repoRoot, [
      'log', '--all', '--no-renames',
      '--format=%x1e%H%x00%s%x00%cI%x00%B%x00',
      '--name-only',
    ]);
    const remoteOutput = git(this.runner, repoRoot, ['rev-list', '--remotes'], true).trim();
    const remoteShas = remoteOutput.length > 0 ? new Set(remoteOutput.split(/\r?\n/).filter(Boolean)) : null;
    const parsed = parseGitLog(log);
    // Message-derived links FIRST: an explicit trailer or body reference is stronger
    // evidence than file-overlap inference, and commitsByWorkItem keeps the first
    // link it sees for a given (sha, work-item) pair.
    const commits = [
      ...commitsForWorkItems(parsed, ids, remoteShas),
      ...inferredCommitLinks(parsed, this.fileEvidence, remoteShas),
    ];
    return repository ? commits.map((commit) => ({ ...commit, repository })) : commits;
  }

  async loadCommits(ids: readonly string[]): Promise<readonly ProjectHistoryCommitInput[]> {
    const commits = [...this.commitsFromRepo(this.options.repoRoot, ids, null)];
    for (const extraRoot of this.options.extraRepoRoots ?? []) {
      // An extra repo that is missing or unreadable must NOT take the whole document
      // down — the primary history is still correct and publishable without it. It is
      // reported loudly instead, because silently emitting a history that is missing a
      // whole repo's commits is the exact failure this option exists to fix.
      try {
        commits.push(...this.commitsFromRepo(extraRoot, ids, this.repositoryFor(extraRoot)));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `project-history generate: --extra-repo ${extraRoot} was skipped (${detail}). `
          + 'Its commits are ABSENT from this document.\n',
        );
      }
    }
    return commits;
  }

  /** Resolve a secondary repo's own origin so its commits link to the right project. */
  private repositoryFor(repoRoot: string): ProjectHistoryRepository | null {
    git(this.runner, repoRoot, ['rev-parse', '--is-inside-work-tree']);
    const remoteUrl = git(this.runner, repoRoot, ['remote', 'get-url', 'origin'], true).trim() || null;
    const branchRef = git(this.runner, repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true).trim();
    const defaultBranch = branchRef ? branchRef.replace(/^origin\//, '') : null;
    return repositoryFromRemote(remoteUrl, null, defaultBranch);
  }
}

/**
 * `plans:export` writes ARCHIVED plans into this subdirectory of `toDir` rather than
 * alongside the live ones (see plans/export.ts). A reader that enumerates only the top
 * level therefore sees a SUBSET of the export and cannot tell that from a complete one.
 */
const PLAN_EXPORT_ARCHIVE_SUBDIR = 'archive';

/** Plan slugs exported as `<slug>.md` directly under `directory`; a missing directory is empty. */
async function exportedPlanSlugs(directory: string, planPrefix: string | null): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    // ENOENT is the ordinary "this harness has no archived plans" case. Anything else is a real
    // read failure and must NOT be swallowed into a silent empty enumeration.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => basename(entry.name, '.md'))
    .filter((slug) => !planPrefix || slug.startsWith(planPrefix));
}

/**
 * `plans:list` is a bounded display surface and may replace rows beyond its
 * payload cap with a truncation marker. The export directory is the complete
 * artifact surface, so enumerate it and use listed rows only as metadata.
 *
 * "Complete" includes `archive/`: `archived` is an internal DECLUTTER flag (plans:set-archived
 * — reversible, drops a plan out of default plan lists), not a retraction of the work. Archiving
 * the implementation plan is a normal post-ship closeout step here, so enumerating only the top
 * level silently deletes SHIPPED work from a product-facing History artifact as soon as its plan
 * is tidied away — measured on SideStage, where sidestage-watch-drop-runway-implementation-2026-08-14
 * (status shipped, 2 completed items) vanished between the 08-15 and 08-17 snapshots because it had
 * been archived at 2026-08-15T05:37Z (WI-39765).
 */
export async function loadProjectHistoryPlansFromExport(
  exportDirectory: string,
  listed: readonly Record<string, unknown>[],
  planPrefix: string | null,
): Promise<ProjectHistoryPlanInput[]> {
  const listedBySlug = new Map(listed.flatMap((plan) => {
    const slug = string(plan.slug);
    return slug ? [[slug, plan] as const] : [];
  }));
  const archiveDirectory = join(exportDirectory, PLAN_EXPORT_ARCHIVE_SUBDIR);
  const [liveSlugs, archivedSlugs] = await Promise.all([
    exportedPlanSlugs(exportDirectory, planPrefix),
    exportedPlanSlugs(archiveDirectory, planPrefix),
  ]);

  const bySlug = new Map<string, { directory: string; filePath: string }>();
  for (const slug of archivedSlugs) {
    bySlug.set(slug, {
      directory: archiveDirectory,
      filePath: `${PLAN_EXPORT_ARCHIVE_SUBDIR}/${slug}.md`,
    });
  }
  // A plan is either live or archived, never both; if an export ever produces both, the LIVE copy
  // wins and the plan still appears exactly once.
  for (const slug of liveSlugs) bySlug.set(slug, { directory: exportDirectory, filePath: `${slug}.md` });

  const slugs = [...bySlug.keys()].sort((left, right) => left.localeCompare(right));

  const loaded = await Promise.all(slugs.map(async (slug) => {
    const source = bySlug.get(slug)!;
    return {
      markdown: await fs.readFile(join(source.directory, `${slug}.md`), 'utf8'),
      filePath: source.filePath,
      updatedAt: string(listedBySlug.get(slug)?.updated),
    } satisfies ProjectHistoryPlanInput;
  }));

  return loaded.filter((plan) => !isTemplateCarrierPlan(plan.markdown));
}

/**
 * A plan that conforms to a TEMPLATE (`template:` frontmatter — e.g. `rubric`) is a PROCESS
 * artifact, not product history: acceptance-rubric carriers and scheduled template instances.
 * Ordinary plans carry no `template:` key at all, which is what makes this a reliable split.
 *
 * They are excluded because a project History artifact is a product-facing record of what was
 * BUILT. Projecting rubric carriers into it publishes internal QA bookkeeping as though it were
 * shipped work — measured on SideStage, where 17 `acceptance-*` rubric plans had reached the
 * public History page (EI-20475585438015488).
 *
 * Scoped to the frontmatter block on purpose: `template:` occurring in a plan's BODY prose must
 * not silently drop a real plan from the artifact.
 */
export function isTemplateCarrierPlan(markdown: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!frontmatter) return false;
  return /^template:[ \t]*\S/m.test(frontmatter[1]);
}

function detectProject(
  options: ProjectHistoryGenerateOptions,
  runner: CommandRunner,
): ProjectHistoryProject {
  git(runner, options.repoRoot, ['rev-parse', '--is-inside-work-tree']);
  const remoteUrl = options.repositoryUrl
    ?? (git(runner, options.repoRoot, ['remote', 'get-url', 'origin'], true).trim() || null);
  const branchRef = git(runner, options.repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], true).trim();
  const defaultBranch = options.defaultBranch ?? (branchRef ? branchRef.replace(/^origin\//, '') : null);
  return {
    id: options.projectId,
    name: options.projectName,
    repository: repositoryFromRemote(remoteUrl, options.repositoryWebUrl, defaultBranch),
  };
}

async function writeAtomic(path: string, body: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, body, 'utf8');
  await fs.rename(temporary, path);
}

function help(): string {
  return `papercusp project-history — generate a portable, validated project History artifact

Usage:
  papercusp project-history generate --harness <slug> [options]

Options:
  --workspace <id>          Papercusp workspace (default: PAPERCUSP_WORKSPACE)
  --prefix <value>          Include plan slugs with this prefix (default: <harness>-)
  --project-id <id>         Stable project id (default: harness slug)
  --project-name <name>     Display name (default: harness slug)
  --repo <path>             Git repository root (default: current directory)
  --output <path>           Output artifact (default: .papercusp/project-history.v2.json)
  --format <json|typescript>  Output format (default inferred from .ts extension)
  --export-name <name>      TypeScript export name (default: PROJECT_HISTORY)
  --generated-at <iso>      Fixed generation timestamp for reproducible builds
  --repository-url <url>    Override the Git origin metadata
  --repository-web-url <url> Override the browser-safe repository URL
  --default-branch <name>   Override the detected default branch
  --check                   Fail if the generated artifact differs; do not write
`;
}

export async function cmdProjectHistory(
  argv: string[],
  runner: CommandRunner = defaultRunner,
): Promise<void> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(help());
    return;
  }
  if (subcommand !== 'generate') throw new Error(`unknown project-history subcommand: ${subcommand}`);

  const options = parseProjectHistoryGenerateArgs(argv.slice(1));
  const project = detectProject(options, runner);
  const { generateProjectHistory } = await import('@papercusp/plan-parser/project-history');
  const document = await generateProjectHistory({
    project,
    source: {
      kind: 'papercusp-plan-export',
      workspace: options.workspace,
      harness: options.harness,
      planPrefix: options.planPrefix,
      generatedAt: options.generatedAt,
      generator: 'papercusp project-history generate',
    },
    provider: new PtoolGitProjectHistoryProvider(options, runner),
  });
  const rendered = renderProjectHistory(
    document,
    options.format,
    options.exportName,
    resolveProjectHistoryIdentityEntries(options.repoRoot),
  );

  if (options.check) {
    const current = await fs.readFile(options.output, 'utf8').catch(() => null);
    if (current === null || !projectHistoryOutputIsCurrent(current, rendered, options.format)) {
      throw new Error(`Project History artifact is stale: ${options.output}`);
    }
    process.stdout.write(`Project History artifact is current: ${options.output}\n`);
    return;
  }

  await writeAtomic(options.output, rendered);
  process.stdout.write(`Wrote ${document.plans.length} plans to ${options.output}\n`);
}
