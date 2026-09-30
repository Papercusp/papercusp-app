/**
 * Bounded per-pot Git statistics.
 *
 * The split in this module is deliberate:
 *  - branch, upstream, divergence, and working-tree state are read on every call;
 *  - committed history/content statistics are cached by repository + HEAD.
 *
 * Content analysis reads blobs from HEAD through one `git cat-file --batch`
 * process. It never substitutes dirty working-tree files for committed data and
 * never recurses through gitlinks. Limits are returned as coverage metadata so a
 * partial result cannot masquerade as a complete repository measurement.
 */
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import { createTextCollector } from '../child-output.js';

let execFilePImpl: ((...args: any[]) => Promise<any>) | undefined;
const execFileP = (...args: any[]) => (execFilePImpl ??= promisify(execFile) as any)(...args);

const COMMAND_TIMEOUT_MS = 15_000;
const TREE_TIMEOUT_MS = 20_000;
const CONTENT_TIMEOUT_MS = 30_000;
const MAX_COMMAND_BUFFER = 16 * 1024 * 1024;
const MAX_TREE_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ANALYSIS_FILES = 25_000;
const MAX_ANALYSIS_BYTES = 64 * 1024 * 1024;
const MAX_SINGLE_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_SUBMODULE_DETAILS = 200;
const MAX_CONTRIBUTORS = 100;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 24;

export class NotGitRepositoryError extends Error {
  constructor() {
    super('not a Git repository');
    this.name = 'NotGitRepositoryError';
  }
}

export interface GitChangeCounts {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface GitLanguageStats {
  language: string;
  files: number;
  bytes: number;
  analyzedFiles: number;
  lines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
  testFiles: number;
  testLines: number;
}

export interface GitLineComposition {
  files: number;
  bytes: number;
  lines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

export interface GitStats {
  measuredAt: string;
  cache: {
    hit: boolean;
    head: string | null;
    generatedAt: string;
    ttlMs: number;
  };
  repository: {
    head: string | null;
    branch: string | null;
    detached: boolean;
    shallow: boolean;
    clean: boolean;
    changes: GitChangeCounts;
    refs: { localBranches: number; remoteBranches: number; tags: number };
  };
  push: {
    upstream: string | null;
    remote: string | null;
    remoteUrl: string | null;
    provider: 'github' | 'gitlab' | 'bitbucket' | 'other' | null;
    ahead: number | null;
    behind: number | null;
    status: 'up-to-date' | 'ahead' | 'behind' | 'diverged' | 'no-upstream' | 'no-remote' | 'unknown';
  };
  history: {
    commits: number;
    firstCommitAt: number | null;
    latestCommitAt: number | null;
    commitsLast7Days: number;
    commitsLast30Days: number;
    commitsLast90Days: number;
  };
  contributors: {
    identities: number;
    top: Array<{ name: string; email: string | null; commits: number }>;
    truncated: boolean;
  };
  footprint: {
    trackedFiles: number;
    trackedBytes: number;
    gitObjectBytes: number | null;
    submodules: {
      count: number;
      entries: Array<{ path: string; head: string }>;
      detailsTruncated: boolean;
    };
  };
  composition: {
    total: GitLineComposition;
    production: GitLineComposition;
    testsAndFixtures: GitLineComposition;
    languages: GitLanguageStats[];
  };
  coverage: {
    treeComplete: boolean;
    analyzedFiles: number;
    analyzedBytes: number;
    binaryFiles: number;
    skippedLargeFiles: number;
    unclassifiedFiles: number;
    truncated: boolean;
    reasons: string[];
    limits: {
      maxTreeOutputBytes: number;
      maxAnalysisFiles: number;
      maxAnalysisBytes: number;
      maxSingleBlobBytes: number;
    };
  };
}

interface LanguageSpec {
  name: string;
  text: boolean;
  composition: boolean;
  lineComments: string[];
  blockComments: Array<[string, string]>;
}

const C_STYLE = { lineComments: ['//'], blockComments: [['/*', '*/']] as Array<[string, string]> };
const HASH_STYLE = { lineComments: ['#'], blockComments: [] as Array<[string, string]> };
const LANGUAGE_BY_EXTENSION = new Map<string, LanguageSpec>([
  ['.ts', { name: 'TypeScript', text: true, composition: true, ...C_STYLE }],
  ['.tsx', { name: 'TypeScript', text: true, composition: true, ...C_STYLE }],
  ['.mts', { name: 'TypeScript', text: true, composition: true, ...C_STYLE }],
  ['.cts', { name: 'TypeScript', text: true, composition: true, ...C_STYLE }],
  ['.js', { name: 'JavaScript', text: true, composition: true, ...C_STYLE }],
  ['.jsx', { name: 'JavaScript', text: true, composition: true, ...C_STYLE }],
  ['.mjs', { name: 'JavaScript', text: true, composition: true, ...C_STYLE }],
  ['.cjs', { name: 'JavaScript', text: true, composition: true, ...C_STYLE }],
  ['.rs', { name: 'Rust', text: true, composition: true, ...C_STYLE }],
  ['.go', { name: 'Go', text: true, composition: true, ...C_STYLE }],
  ['.java', { name: 'Java', text: true, composition: true, ...C_STYLE }],
  ['.kt', { name: 'Kotlin', text: true, composition: true, ...C_STYLE }],
  ['.kts', { name: 'Kotlin', text: true, composition: true, ...C_STYLE }],
  ['.swift', { name: 'Swift', text: true, composition: true, ...C_STYLE }],
  ['.c', { name: 'C', text: true, composition: true, ...C_STYLE }],
  ['.h', { name: 'C/C++ Header', text: true, composition: true, ...C_STYLE }],
  ['.cc', { name: 'C++', text: true, composition: true, ...C_STYLE }],
  ['.cpp', { name: 'C++', text: true, composition: true, ...C_STYLE }],
  ['.cxx', { name: 'C++', text: true, composition: true, ...C_STYLE }],
  ['.hpp', { name: 'C/C++ Header', text: true, composition: true, ...C_STYLE }],
  ['.cs', { name: 'C#', text: true, composition: true, ...C_STYLE }],
  ['.dart', { name: 'Dart', text: true, composition: true, ...C_STYLE }],
  ['.scala', { name: 'Scala', text: true, composition: true, ...C_STYLE }],
  ['.php', { name: 'PHP', text: true, composition: true, lineComments: ['//', '#'], blockComments: C_STYLE.blockComments }],
  ['.py', { name: 'Python', text: true, composition: true, ...HASH_STYLE }],
  ['.rb', { name: 'Ruby', text: true, composition: true, ...HASH_STYLE }],
  ['.sh', { name: 'Shell', text: true, composition: true, ...HASH_STYLE }],
  ['.bash', { name: 'Shell', text: true, composition: true, ...HASH_STYLE }],
  ['.zsh', { name: 'Shell', text: true, composition: true, ...HASH_STYLE }],
  ['.fish', { name: 'Shell', text: true, composition: true, ...HASH_STYLE }],
  ['.ps1', { name: 'PowerShell', text: true, composition: true, ...HASH_STYLE }],
  ['.r', { name: 'R', text: true, composition: true, ...HASH_STYLE }],
  ['.pl', { name: 'Perl', text: true, composition: true, ...HASH_STYLE }],
  ['.lua', { name: 'Lua', text: true, composition: true, lineComments: ['--'], blockComments: [['--[[', ']]']] }],
  ['.sql', { name: 'SQL', text: true, composition: true, lineComments: ['--'], blockComments: [['/*', '*/']] }],
  ['.css', { name: 'CSS', text: true, composition: true, lineComments: [], blockComments: [['/*', '*/']] }],
  ['.scss', { name: 'SCSS', text: true, composition: true, ...C_STYLE }],
  ['.less', { name: 'Less', text: true, composition: true, ...C_STYLE }],
  ['.html', { name: 'HTML', text: true, composition: true, lineComments: [], blockComments: [['<!--', '-->']] }],
  ['.htm', { name: 'HTML', text: true, composition: true, lineComments: [], blockComments: [['<!--', '-->']] }],
  ['.vue', { name: 'Vue', text: true, composition: true, ...C_STYLE }],
  ['.svelte', { name: 'Svelte', text: true, composition: true, ...C_STYLE }],
  ['.json', { name: 'JSON', text: true, composition: true, lineComments: [], blockComments: [] }],
  ['.jsonc', { name: 'JSON', text: true, composition: true, ...C_STYLE }],
  ['.yaml', { name: 'YAML', text: true, composition: true, ...HASH_STYLE }],
  ['.yml', { name: 'YAML', text: true, composition: true, ...HASH_STYLE }],
  ['.toml', { name: 'TOML', text: true, composition: true, ...HASH_STYLE }],
  ['.xml', { name: 'XML', text: true, composition: true, lineComments: [], blockComments: [['<!--', '-->']] }],
  ['.md', { name: 'Markdown', text: true, composition: false, lineComments: [], blockComments: [['<!--', '-->']] }],
  ['.mdx', { name: 'MDX', text: true, composition: false, ...C_STYLE }],
  ['.txt', { name: 'Text', text: true, composition: false, lineComments: [], blockComments: [] }],
]);

const SPECIAL_LANGUAGES = new Map<string, LanguageSpec>([
  ['dockerfile', { name: 'Dockerfile', text: true, composition: true, ...HASH_STYLE }],
  ['makefile', { name: 'Makefile', text: true, composition: true, ...HASH_STYLE }],
  ['cmakelists.txt', { name: 'CMake', text: true, composition: true, ...HASH_STYLE }],
]);

const OTHER_LANGUAGE: LanguageSpec = {
  name: 'Other',
  text: false,
  composition: false,
  lineComments: [],
  blockComments: [],
};

function languageForPath(path: string): LanguageSpec {
  return SPECIAL_LANGUAGES.get(basename(path).toLowerCase())
    ?? LANGUAGE_BY_EXTENSION.get(extname(path).toLowerCase())
    ?? OTHER_LANGUAGE;
}

function isTestOrFixture(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /(^|\/)(__tests__|tests?|specs?|fixtures?|mocks?|testdata)(\/|$)/i.test(normalized)
    || /(^|[._-])(test|spec|fixture|mock)([._-]|$)/i.test(basename(normalized));
}

function emptyComposition(): GitLineComposition {
  return { files: 0, bytes: 0, lines: 0, codeLines: 0, commentLines: 0, blankLines: 0 };
}

function addComposition(target: GitLineComposition, source: GitLineComposition): void {
  target.files += source.files;
  target.bytes += source.bytes;
  target.lines += source.lines;
  target.codeLines += source.codeLines;
  target.commentLines += source.commentLines;
  target.blankLines += source.blankLines;
}

function physicalLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (/(?:\r\n|\n|\r)$/.test(text)) lines.pop();
  return lines;
}

function classifyText(text: string, spec: LanguageSpec): Omit<GitLineComposition, 'files' | 'bytes'> {
  let lines = 0;
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let blockEnd: string | null = null;

  for (const rawLine of physicalLines(text)) {
    lines += 1;
    let rest = rawLine.trimStart();
    let commentOnly = false;

    if (blockEnd === null && rest.length === 0) {
      blankLines += 1;
      continue;
    }

    while (true) {
      if (blockEnd !== null) {
        commentOnly = true;
        const endAt = rest.indexOf(blockEnd);
        if (endAt < 0) break;
        rest = rest.slice(endAt + blockEnd.length).trimStart();
        blockEnd = null;
        if (rest.length === 0) break;
        continue;
      }

      if (rest.startsWith('#!')) {
        commentOnly = false;
        break;
      }
      if (spec.lineComments.some((prefix) => rest.startsWith(prefix))) {
        commentOnly = true;
        break;
      }

      const pair = spec.blockComments.find(([start]) => rest.startsWith(start));
      if (!pair) break;
      commentOnly = true;
      const [start, end] = pair;
      const endAt = rest.indexOf(end, start.length);
      if (endAt < 0) {
        blockEnd = end;
        break;
      }
      rest = rest.slice(endAt + end.length).trimStart();
      if (rest.length === 0) break;
    }

    if (blockEnd !== null || (commentOnly && rest.length === 0)
      || spec.lineComments.some((prefix) => rest.startsWith(prefix))) {
      commentLines += 1;
    } else {
      codeLines += 1;
    }
  }

  return { lines, codeLines, commentLines, blankLines };
}

async function runGit(repoPath: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await execFileP(
    'git',
    ['-C', repoPath, ...args],
    {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? MAX_COMMAND_BUFFER,
    },
  );
  return String(stdout);
}

async function runGitOrNull(repoPath: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(repoPath, args)).trim();
  } catch {
    return null;
  }
}

function parseStatus(stdout: string): GitChangeCounts {
  const result: GitChangeCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const records = stdout.split('\0');
  const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const xy = record.slice(0, 2);
    if (xy === '??') {
      result.untracked += 1;
      continue;
    }
    if (conflicts.has(xy)) {
      result.conflicted += 1;
      continue;
    }
    if (xy[0] !== ' ' && xy[0] !== '?') result.staged += 1;
    if (xy[1] !== ' ' && xy[1] !== '?') result.unstaged += 1;
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the old path is the next NUL record
  }
  return result;
}

function providerForUrl(url: string | null): GitStats['push']['provider'] {
  if (!url) return null;
  if (/(?:^|[.@/:])github\.com(?:[/:]|$)/i.test(url)) return 'github';
  if (/(?:^|[.@/:])gitlab\.com(?:[/:]|$)/i.test(url)) return 'gitlab';
  if (/(?:^|[.@/:])bitbucket\.org(?:[/:]|$)/i.test(url)) return 'bitbucket';
  return 'other';
}

function pushStatus(
  upstream: string | null,
  remoteUrl: string | null,
  ahead: number | null,
  behind: number | null,
): GitStats['push']['status'] {
  if (!remoteUrl) return 'no-remote';
  if (!upstream) return 'no-upstream';
  if (ahead === null || behind === null) return 'unknown';
  if (ahead > 0 && behind > 0) return 'diverged';
  if (ahead > 0) return 'ahead';
  if (behind > 0) return 'behind';
  return 'up-to-date';
}

interface LiveState {
  head: string | null;
  branch: string | null;
  shallow: boolean;
  changes: GitChangeCounts;
  upstream: string | null;
  remote: string | null;
  remoteUrl: string | null;
  ahead: number | null;
  behind: number | null;
  refs: GitStats['repository']['refs'];
}

async function readLiveState(repoPath: string): Promise<LiveState> {
  const inside = await runGitOrNull(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') throw new NotGitRepositoryError();

  const [head, branch, shallowRaw, statusRaw, upstream, refsRaw] = await Promise.all([
    runGitOrNull(repoPath, ['rev-parse', '--verify', 'HEAD']),
    runGitOrNull(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGitOrNull(repoPath, ['rev-parse', '--is-shallow-repository']),
    runGit(repoPath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
    runGitOrNull(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    runGit(repoPath, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']),
  ]);

  const remote = upstream?.split('/')[0] ?? null;
  const [remoteUrl, divergenceRaw] = await Promise.all([
    remote ? runGitOrNull(repoPath, ['remote', 'get-url', '--push', remote]) : Promise.resolve(null),
    upstream && head
      ? runGitOrNull(repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
      : Promise.resolve(null),
  ]);
  const divergence = divergenceRaw?.split(/\s+/).map(Number) ?? [];
  const ahead = divergence.length === 2 && Number.isFinite(divergence[0]) ? divergence[0] : null;
  const behind = divergence.length === 2 && Number.isFinite(divergence[1]) ? divergence[1] : null;

  const refs = { localBranches: 0, remoteBranches: 0, tags: 0 };
  for (const ref of refsRaw.split('\n').filter(Boolean)) {
    if (ref.startsWith('refs/heads/')) refs.localBranches += 1;
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) refs.remoteBranches += 1;
    else if (ref.startsWith('refs/tags/')) refs.tags += 1;
  }

  return {
    head,
    branch,
    shallow: shallowRaw === 'true',
    changes: parseStatus(statusRaw),
    upstream,
    remote,
    remoteUrl,
    ahead,
    behind,
    refs,
  };
}

interface TreeBlob {
  path: string;
  oid: string;
  size: number;
  language: LanguageSpec;
  test: boolean;
}

interface TreeSnapshot {
  trackedFiles: number;
  trackedBytes: number;
  submoduleCount: number;
  submodules: Array<{ path: string; head: string }>;
  blobsForAnalysis: TreeBlob[];
  unclassifiedFiles: number;
  languages: Map<string, GitLanguageStats>;
  complete: boolean;
  reason: string | null;
}

function languageRow(map: Map<string, GitLanguageStats>, name: string): GitLanguageStats {
  let row = map.get(name);
  if (!row) {
    row = {
      language: name,
      files: 0,
      bytes: 0,
      analyzedFiles: 0,
      lines: 0,
      codeLines: 0,
      commentLines: 0,
      blankLines: 0,
      testFiles: 0,
      testLines: 0,
    };
    map.set(name, row);
  }
  return row;
}

function readHeadTree(repoPath: string, head: string | null): Promise<TreeSnapshot> {
  if (!head) {
    return Promise.resolve({
      trackedFiles: 0,
      trackedBytes: 0,
      submoduleCount: 0,
      submodules: [],
      blobsForAnalysis: [],
      unclassifiedFiles: 0,
      languages: new Map(),
      complete: true,
      reason: null,
    });
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, 'ls-tree', '-r', '-z', '-l', head], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const snapshot: TreeSnapshot = {
      trackedFiles: 0,
      trackedBytes: 0,
      submoduleCount: 0,
      submodules: [],
      blobsForAnalysis: [],
      unclassifiedFiles: 0,
      languages: new Map(),
      complete: true,
      reason: null,
    };
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputBytes = 0;
    const stderr = createTextCollector(child.stderr);
    let intentionallyKilled = false;

    const consumeRecord = (record: string) => {
      const match = /^(\d{6})\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)\t([\s\S]+)$/.exec(record);
      if (!match) return;
      const [, mode, type, oid, sizeRaw, path] = match;
      if (mode === '160000' || type === 'commit') {
        snapshot.submoduleCount += 1;
        if (snapshot.submodules.length < MAX_SUBMODULE_DETAILS) snapshot.submodules.push({ path, head: oid });
        return;
      }
      if (type !== 'blob' || sizeRaw === '-') return;
      const size = Number(sizeRaw);
      if (!Number.isFinite(size) || size < 0) return;
      const language = languageForPath(path);
      const test = isTestOrFixture(path);
      snapshot.trackedFiles += 1;
      snapshot.trackedBytes += size;
      const row = languageRow(snapshot.languages, language.name);
      row.files += 1;
      row.bytes += size;
      if (test) row.testFiles += 1;
      if (!language.text) {
        snapshot.unclassifiedFiles += 1;
      } else if (snapshot.blobsForAnalysis.length < MAX_ANALYSIS_FILES) {
        snapshot.blobsForAnalysis.push({ path, oid, size, language, test });
      }
    };

    const consume = (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let separator = pending.indexOf(0);
      while (separator >= 0) {
        consumeRecord(pending.subarray(0, separator).toString('utf8'));
        pending = pending.subarray(separator + 1);
        separator = pending.indexOf(0);
      }
    };

    const timer = setTimeout(() => {
      snapshot.complete = false;
      snapshot.reason = 'tree-timeout';
      intentionallyKilled = true;
      child.kill('SIGTERM');
    }, TREE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (intentionallyKilled) return;
      const remaining = MAX_TREE_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) return;
      const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      outputBytes += accepted.length;
      consume(accepted);
      if (chunk.length > remaining || outputBytes >= MAX_TREE_OUTPUT_BYTES) {
        snapshot.complete = false;
        snapshot.reason = 'tree-output-limit';
        intentionallyKilled = true;
        child.kill('SIGTERM');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && !intentionallyKilled && signal !== 'SIGTERM') {
        reject(new Error(`git ls-tree exited ${code}: ${stderr.text().slice(0, 400)}`));
        return;
      }
      resolve(snapshot);
    });
  });
}

class AsyncBufferReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer<ArrayBufferLike>>;

  constructor(stream: NodeJS.ReadableStream) {
    this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer<ArrayBufferLike>>;
  }

  private async fill(size: number): Promise<void> {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done) throw new Error('git cat-file ended before its declared payload');
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }
  }

  async line(): Promise<string> {
    let newline = this.buffer.indexOf(0x0a);
    while (newline < 0) {
      const next = await this.iterator.next();
      if (next.done) throw new Error('git cat-file ended before its header newline');
      const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      newline = this.buffer.indexOf(0x0a);
    }
    const line = this.buffer.subarray(0, newline).toString('utf8');
    this.buffer = this.buffer.subarray(newline + 1);
    return line;
  }

  async bytes(size: number): Promise<Buffer<ArrayBufferLike>> {
    await this.fill(size);
    const value = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return value;
  }
}

interface ScanResult {
  total: GitLineComposition;
  production: GitLineComposition;
  testsAndFixtures: GitLineComposition;
  analyzedFiles: number;
  analyzedBytes: number;
  binaryFiles: number;
  skippedLargeFiles: number;
  complete: boolean;
  reason: string | null;
}

async function scanHeadBlobs(repoPath: string, tree: TreeSnapshot): Promise<ScanResult> {
  const result: ScanResult = {
    total: emptyComposition(),
    production: emptyComposition(),
    testsAndFixtures: emptyComposition(),
    analyzedFiles: 0,
    analyzedBytes: 0,
    binaryFiles: 0,
    skippedLargeFiles: 0,
    complete: true,
    reason: null,
  };
  if (tree.blobsForAnalysis.length === 0) return result;

  const child = spawn('git', ['-C', repoPath, 'cat-file', '--batch'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const reader = new AsyncBufferReader(child.stdout);
  const stderr = createTextCollector(child.stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    result.complete = false;
    result.reason = 'content-timeout';
    child.kill('SIGTERM');
  }, CONTENT_TIMEOUT_MS);

  try {
    for (const blob of tree.blobsForAnalysis) {
      if (blob.size > MAX_SINGLE_BLOB_BYTES) {
        result.skippedLargeFiles += 1;
        result.complete = false;
        result.reason ??= 'single-blob-limit';
        continue;
      }
      if (result.analyzedBytes + blob.size > MAX_ANALYSIS_BYTES) {
        result.complete = false;
        result.reason ??= 'analysis-byte-limit';
        break;
      }

      if (!child.stdin.write(`${blob.oid}\n`)) await once(child.stdin, 'drain');
      const header = await reader.line();
      const match = /^([0-9a-f]+)\s+(\w+)\s+(\d+)$/.exec(header);
      if (!match || match[2] !== 'blob') throw new Error(`unexpected git cat-file header: ${header.slice(0, 160)}`);
      const actualSize = Number(match[3]);
      const content = await reader.bytes(actualSize);
      await reader.bytes(1); // protocol newline after the blob payload

      if (content.includes(0)) {
        result.binaryFiles += 1;
        continue;
      }
      const counts = classifyText(content.toString('utf8'), blob.language);
      const fileCounts: GitLineComposition = { files: 1, bytes: actualSize, ...counts };
      result.analyzedFiles += 1;
      result.analyzedBytes += actualSize;
      if (blob.language.composition) {
        addComposition(result.total, fileCounts);
        addComposition(blob.test ? result.testsAndFixtures : result.production, fileCounts);
      }

      const language = languageRow(tree.languages, blob.language.name);
      language.analyzedFiles += 1;
      language.lines += counts.lines;
      language.codeLines += counts.codeLines;
      language.commentLines += counts.commentLines;
      language.blankLines += counts.blankLines;
      if (blob.test) language.testLines += counts.lines;
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
      if (!timedOut && code !== 0 && signal !== 'SIGTERM') {
        throw new Error(`git cat-file exited ${code}: ${stderr.text().slice(0, 400)}`);
      }
    }
  }

  return result;
}

function parseContributor(line: string): { name: string; email: string | null; commits: number } | null {
  const match = /^\s*(\d+)\s+(.+?)(?:\s+<([^>]+)>)?\s*$/.exec(line);
  if (!match) return null;
  return { commits: Number(match[1]), name: match[2].trim(), email: match[3]?.trim() ?? null };
}

function parseGitObjectBytes(raw: string): number | null {
  const values = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const [key, value] = line.split(':').map((part) => part.trim());
    const parsed = Number(value);
    if (key && Number.isFinite(parsed)) values.set(key, parsed);
  }
  if (!values.has('size') && !values.has('size-pack')) return null;
  return ((values.get('size') ?? 0) + (values.get('size-pack') ?? 0)) * 1024;
}

interface ExpensiveStats {
  generatedAt: string;
  history: GitStats['history'];
  contributors: GitStats['contributors'];
  footprint: GitStats['footprint'];
  composition: GitStats['composition'];
  coverage: GitStats['coverage'];
}

async function readExpensiveStats(repoPath: string, head: string | null): Promise<ExpensiveStats> {
  const treePromise = readHeadTree(repoPath, head);
  const zero = head ? null : '0';
  const [commitCountRaw, firstRaw, latestRaw, weekRaw, monthRaw, quarterRaw, contributorsRaw, objectsRaw] = await Promise.all([
    zero ?? runGit(repoPath, ['rev-list', '--count', head!]).then((s) => s.trim()),
    zero ?? runGit(repoPath, ['log', '--reverse', '--max-parents=0', '--format=%at', head!]).then((s) => s.trim()),
    zero ?? runGit(repoPath, ['log', '-1', '--format=%at', head!]).then((s) => s.trim()),
    zero ?? runGit(repoPath, ['rev-list', '--count', '--since=7.days', head!]).then((s) => s.trim()),
    zero ?? runGit(repoPath, ['rev-list', '--count', '--since=30.days', head!]).then((s) => s.trim()),
    zero ?? runGit(repoPath, ['rev-list', '--count', '--since=90.days', head!]).then((s) => s.trim()),
    head ? runGit(repoPath, ['shortlog', '-sne', head]) : Promise.resolve(''),
    runGit(repoPath, ['count-objects', '-v']),
  ]);
  const tree = await treePromise;
  const scan = await scanHeadBlobs(repoPath, tree);
  const contributorRows = contributorsRaw.split('\n').map(parseContributor).filter((row): row is NonNullable<typeof row> => row !== null);
  const reasons = [tree.reason, scan.reason].filter((reason): reason is string => Boolean(reason));
  if (tree.trackedFiles > tree.blobsForAnalysis.length + tree.unclassifiedFiles) reasons.push('analysis-file-limit');
  if (tree.submoduleCount > tree.submodules.length) reasons.push('submodule-detail-limit');
  const uniqueReasons = [...new Set(reasons)];

  const asTimestamp = (raw: string): number | null => {
    const first = raw.split('\n')[0]?.trim();
    const value = Number(first);
    return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  };

  return {
    generatedAt: new Date().toISOString(),
    history: {
      commits: Number(commitCountRaw) || 0,
      firstCommitAt: asTimestamp(firstRaw),
      latestCommitAt: asTimestamp(latestRaw),
      commitsLast7Days: Number(weekRaw) || 0,
      commitsLast30Days: Number(monthRaw) || 0,
      commitsLast90Days: Number(quarterRaw) || 0,
    },
    contributors: {
      identities: contributorRows.length,
      top: contributorRows.slice(0, MAX_CONTRIBUTORS),
      truncated: contributorRows.length > MAX_CONTRIBUTORS,
    },
    footprint: {
      trackedFiles: tree.trackedFiles,
      trackedBytes: tree.trackedBytes,
      gitObjectBytes: parseGitObjectBytes(objectsRaw),
      submodules: {
        count: tree.submoduleCount,
        entries: tree.submodules,
        detailsTruncated: tree.submoduleCount > tree.submodules.length,
      },
    },
    composition: {
      total: scan.total,
      production: scan.production,
      testsAndFixtures: scan.testsAndFixtures,
      languages: [...tree.languages.values()].sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language)),
    },
    coverage: {
      treeComplete: tree.complete,
      analyzedFiles: scan.analyzedFiles,
      analyzedBytes: scan.analyzedBytes,
      binaryFiles: scan.binaryFiles,
      skippedLargeFiles: scan.skippedLargeFiles,
      unclassifiedFiles: tree.unclassifiedFiles,
      truncated: !tree.complete || !scan.complete || uniqueReasons.length > 0,
      reasons: uniqueReasons,
      limits: {
        maxTreeOutputBytes: MAX_TREE_OUTPUT_BYTES,
        maxAnalysisFiles: MAX_ANALYSIS_FILES,
        maxAnalysisBytes: MAX_ANALYSIS_BYTES,
        maxSingleBlobBytes: MAX_SINGLE_BLOB_BYTES,
      },
    },
  };
}

const expensiveCache = new Map<string, { createdAt: number; value: Promise<ExpensiveStats> }>();

function cacheKey(repoPath: string, head: string | null): string {
  return `${repoPath}\0${head ?? '(empty)'}`;
}

function pruneCache(): void {
  while (expensiveCache.size > MAX_CACHE_ENTRIES) {
    const oldest = expensiveCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    expensiveCache.delete(oldest);
  }
}

async function cachedExpensiveStats(
  repoPath: string,
  head: string | null,
  refresh: boolean,
): Promise<{ hit: boolean; value: ExpensiveStats }> {
  const key = cacheKey(repoPath, head);
  const now = Date.now();
  const existing = expensiveCache.get(key);
  if (!refresh && existing && now - existing.createdAt < CACHE_TTL_MS) {
    expensiveCache.delete(key);
    expensiveCache.set(key, existing);
    return { hit: true, value: await existing.value };
  }

  const value = readExpensiveStats(repoPath, head);
  expensiveCache.set(key, { createdAt: now, value });
  pruneCache();
  try {
    return { hit: false, value: await value };
  } catch (error) {
    if (expensiveCache.get(key)?.value === value) expensiveCache.delete(key);
    throw error;
  }
}

export async function readGitStats(repoPath: string, opts: { refresh?: boolean } = {}): Promise<GitStats> {
  const live = await readLiveState(repoPath);
  const expensive = await cachedExpensiveStats(repoPath, live.head, opts.refresh === true);
  const dirtyCount = live.changes.staged + live.changes.unstaged + live.changes.untracked + live.changes.conflicted;

  return {
    measuredAt: new Date().toISOString(),
    cache: {
      hit: expensive.hit,
      head: live.head,
      generatedAt: expensive.value.generatedAt,
      ttlMs: CACHE_TTL_MS,
    },
    repository: {
      head: live.head,
      branch: live.branch,
      detached: live.branch === null && live.head !== null,
      shallow: live.shallow,
      clean: dirtyCount === 0,
      changes: live.changes,
      refs: live.refs,
    },
    push: {
      upstream: live.upstream,
      remote: live.remote,
      remoteUrl: live.remoteUrl,
      provider: providerForUrl(live.remoteUrl),
      ahead: live.ahead,
      behind: live.behind,
      status: pushStatus(live.upstream, live.remoteUrl, live.ahead, live.behind),
    },
    history: expensive.value.history,
    contributors: expensive.value.contributors,
    footprint: expensive.value.footprint,
    composition: expensive.value.composition,
    coverage: expensive.value.coverage,
  };
}

/** Test isolation only; production invalidation is HEAD + TTL + manual refresh. */
export function clearGitStatsCacheForTests(): void {
  expensiveCache.clear();
}
