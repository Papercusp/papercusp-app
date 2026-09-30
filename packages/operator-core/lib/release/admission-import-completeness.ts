/**
 * P-004 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03): admission COMPLETENESS.
 *
 * An admission lands EXACTLY the paths the caller named onto the frozen lineage (P-001) and
 * nothing else from the tip. That exactness has one predictable failure: a fix that spans two
 * files admitted one at a time, or a new sibling the caller forgot to name. The admitted file
 * then imports a path that does not exist at repairHead, and the gate only finds out a full
 * verification round later, when lint:tsc at repairHead fails on an unresolved module — after
 * the fixer has already exited.
 *
 * This is the cheap, synchronous DOOR check that names that sibling before publish. For every
 * admitted TS/JS blob at the proved admission commit, each RELATIVE import specifier
 * (`./x`, `../y`) is resolved the way TypeScript's bundler / node16 resolution would —
 * extension probe, `.js` → `.ts` rewrite, `/index.*` — against the commit's tree, in ONE
 * `git cat-file --batch-check` call. Anything unresolved comes back with the path to admit.
 *
 * It is deliberately NOT a typechecker. Bare specifiers (packages, `@/` aliases), type errors,
 * a file at repairHead that imports something this admission DELETES, and everything else
 * `lint:tsc` sees remain the gate's verification round (P-005 `verifyRepairHead` runs the lint
 * legs at repairHead). And it never widens the admission on the caller's behalf: "admit this
 * too" is the caller's explicit second call, which is the whole point of P-004's last clause.
 *
 * The scanner skips comments, string and template literals and only reads a specifier from a
 * string sitting in import position (`from`, `import`, `import(`, `require(`), so a test file
 * that QUOTES import statements — this module's own test does — is not misread as importing.
 */
import { posix } from 'node:path';

import {
  realAdmissionGit,
  type AdmissionGitRunner,
  type AdmissionMissingImport,
  type AdmissionPreflightRefusal,
  type AdmitPathsInput,
} from './repair-head-admission';

/** Files whose imports are scanned. Anything else admitted (docs, sql, json, assets) is skipped. */
const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);

/** Extensions probed, in order, for an extensionless (or unknown-extension) specifier. */
const PROBE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.d.ts'];

/** TS ESM convention: `./x.js` in source means `./x.ts` (or `.tsx`) on disk; the emitted `.js` may also exist. */
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx'],
};

/** A specifier ending in one of these names exactly one file; no probe. */
const EXPLICIT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SCANNED_EXTENSIONS,
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.wasm',
  '.md',
  '.mdx',
  '.txt',
  '.html',
  '.yaml',
  '.yml',
  '.sql',
  '.node',
  '.woff',
  '.woff2',
  '.ttf',
]);

const IMPORT_POSITION_RE = /(?:^|[^.\w$])(?:from|import)\s*$|(?:^|[^.\w$])(?:import|require)\s*\(\s*$/;

function scanQuoted(source: string, start: number, quote: string): number {
  // Returns the index just past the closing quote; an unterminated string ends at the newline.
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n') return i;
    i++;
  }
  return source.length;
}

function skipTemplate(source: string, start: number): number {
  // Returns the index just past the closing backtick, honouring `${ … }` nesting (which may
  // itself hold strings and templates). The contents are never scanned for specifiers.
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const c = source[i]!;
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '`') {
          i = skipTemplate(source, i);
          continue;
        } else if (c === "'" || c === '"') {
          i = scanQuoted(source, i, c);
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return source.length;
}

/**
 * Every RELATIVE module specifier (`./…`, `../…`) that `source` imports, in first-seen order,
 * deduplicated. Comments, string and template literals are skipped; a quoted path counts only
 * when it sits in import position — `from '…'`, `import '…'`, `import('…')`, `require('…')`.
 * A regex literal containing a quote character can desynchronise the scanner for the rest of
 * that statement (rare; the failure is a missed or spurious specifier, never a crash).
 */
export function extractRelativeImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let code = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === '`') {
      i = skipTemplate(source, i);
      code += ' `` ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(source, i, ch);
      const closed = source[end - 1] === ch && end - 1 > i;
      const value = closed ? source.slice(i + 1, end - 1) : '';
      if (closed && /^\.\.?\//.test(value) && IMPORT_POSITION_RE.test(code.slice(-48))) {
        if (!seen.has(value)) {
          seen.add(value);
          out.push(value);
        }
      }
      code += ' "" ';
      i = end;
      continue;
    }
    code += ch;
    if (code.length > 256) code = code.slice(-96);
    i++;
  }
  return out;
}

/**
 * The repo-relative paths a relative specifier from `fromPath` may name, in probe order, or
 * null when it escapes the repository root (nothing in the tree can satisfy it; the gate's
 * typecheck owns that error). `?raw` / `?url` / `#…` suffixes are stripped first.
 */
export function resolveImportCandidates(fromPath: string, specifier: string): string[] | null {
  const bare = specifier.replace(/[?#].*$/, '');
  const joined = posix.normalize(posix.join(posix.dirname(fromPath), bare));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  const ext = posix.extname(joined);
  const candidates: string[] = [];
  const push = (p: string) => {
    if (!candidates.includes(p)) candidates.push(p);
  };
  const rewrites = ext ? JS_TO_TS[ext] : undefined;
  if (rewrites) {
    for (const t of rewrites) push(joined.slice(0, -ext.length) + t);
    push(joined);
    return candidates;
  }
  if (ext && EXPLICIT_EXTENSIONS.has(ext)) {
    push(joined);
    return candidates;
  }
  // Extensionless, or an unknown "extension" that is really part of the name (`./foo.service`).
  if (ext) push(joined);
  for (const e of PROBE_EXTENSIONS) push(joined + e);
  for (const e of PROBE_EXTENSIONS) push(posix.join(joined, 'index' + e));
  return candidates;
}

export interface ImportCompletenessInput {
  /** Repository root holding `commit` (and `probeRef`). */
  root: string;
  /** The proved admission commit whose tree the imports must resolve against. */
  commit: string;
  /** The admitted paths (the proved name set); non-scannable ones are reported in `skipped`. */
  paths: readonly string[];
  /**
   * A ref to consult for the MISSING paths only — the shared staging tip — so `wanted` names
   * the candidate that actually exists there and `atProbeRef` says whether admitting it closes
   * the gap. Omit and every missing import reports `atProbeRef: 'unknown'`.
   */
  probeRef?: string;
  git?: AdmissionGitRunner;
}

export interface ImportCompletenessSkip {
  path: string;
  reason: 'not-scanned-extension' | 'not-a-blob' | 'escapes-repo' | 'inside-submodule' | 'generated-by-tracked-builder';
  /** Import-specific skips: the specifier this refers to. */
  specifier?: string;
}

export type ImportCompletenessOutcome =
  | { ok: true; checked: string[]; imports: number; skipped: ImportCompletenessSkip[] }
  | {
      ok: false;
      code: 'admission-incomplete';
      missing: AdmissionMissingImport[];
      checked: string[];
      imports: number;
      skipped: ImportCompletenessSkip[];
    }
  | { ok: false; code: 'git-failed'; step: string; detail: string };

type ObjectKind = 'blob' | 'tree' | 'commit' | 'tag' | 'missing';

/** ONE `git cat-file --batch-check` over every `<rev>:<path>` question, answered positionally. */
function batchKinds(
  git: AdmissionGitRunner,
  root: string,
  questions: readonly string[],
): { ok: true; kinds: Map<string, ObjectKind> } | { ok: false; step: string; detail: string } {
  const kinds = new Map<string, ObjectKind>();
  if (questions.length === 0) return { ok: true, kinds };
  const unique = [...new Set(questions)];
  const r = git(['cat-file', '--batch-check=%(objecttype)'], { cwd: root, input: unique.join('\n') + '\n' });
  if (r.status !== 0) {
    return {
      ok: false,
      step: 'cat-file --batch-check',
      detail: `exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    };
  }
  const lines = r.stdout.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== unique.length) {
    return {
      ok: false,
      step: 'cat-file --batch-check',
      detail: `asked ${unique.length} question(s), got ${lines.length} answer(s)`,
    };
  }
  unique.forEach((q, idx) => {
    const line = lines[idx]!.trim();
    if (line.endsWith(' missing') || line.endsWith(' ambiguous')) kinds.set(q, 'missing');
    else if (line === 'blob' || line === 'tree' || line === 'commit' || line === 'tag') kinds.set(q, line);
    else kinds.set(q, 'missing');
  });
  return { ok: true, kinds };
}

function ancestors(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * A package-local `dist/*.js` file may intentionally be absent from git when a tracked builder
 * emits it before execution. Accept that source closure only when the proved commit contains a
 * conventionally named builder whose own source names the exact output path. Merely living under
 * `dist/`, being gitignored on the shared checkout, or having an unrelated builder is not enough.
 */
function trackedGeneratedPackageBuilder(
  ask: { candidates: string[] },
  input: ImportCompletenessInput,
  git: AdmissionGitRunner,
): string | null {
  const output = ask.candidates.find((candidate) => /^packages\/[^/]+\/dist\/[^/]+\.(?:cjs|mjs|js)$/.test(candidate));
  if (!output) return null;
  const parts = output.split('/');
  const packageRoot = parts.slice(0, 2).join('/');
  const outputBase = posix.basename(output);
  const topic = outputBase.replace(/\.(?:cjs|mjs|js)$/, '').split('-')[0];
  const builders = [...new Set([`${packageRoot}/build-${topic}.mjs`, `${packageRoot}/build.mjs`])];
  for (const builder of builders) {
    const blob = git(['cat-file', 'blob', `${input.commit}:${builder}`], { cwd: input.root });
    if (blob.status === 0 && (blob.stdout.includes(output) || blob.stdout.includes(`dist/${outputBase}`))) {
      return builder;
    }
  }
  return null;
}

/**
 * ONE `git ls-tree -d` over the named directories at `commit`: which of them are GITLINKS
 * (mode 160000, a submodule pin). `-d` lists each named entry itself rather than its children,
 * and `--full-tree` keeps every path repo-relative regardless of cwd. Reading the tree entry is
 * the only probe that can see a gitlink — see the caller for why `cat-file` cannot.
 */
function batchGitlinks(
  git: AdmissionGitRunner,
  root: string,
  commit: string,
  dirs: readonly string[],
): { ok: true; dirs: Set<string> } | { ok: false; step: string; detail: string } {
  const found = new Set<string>();
  if (dirs.length === 0) return { ok: true, dirs: found };
  const r = git(['ls-tree', '-d', '-z', '--full-tree', commit, '--', ...dirs], { cwd: root });
  if (r.status !== 0) {
    return {
      ok: false,
      step: 'ls-tree -d',
      detail: `exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`,
    };
  }
  for (const entry of r.stdout.split('\0')) {
    // `<mode> <type> <oid>\t<path>` per entry; a gitlink is `160000 commit <sha>`.
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const mode = entry.slice(0, tab).split(' ')[0];
    if (mode === '160000') found.add(entry.slice(tab + 1));
  }
  return { ok: true, dirs: found };
}

/**
 * Resolve every relative import of every admitted TS/JS blob at `commit`. Synchronous and
 * bounded: one `cat-file blob` per admitted file, one batch-check for all candidates, one
 * `ls-tree -d` over the ancestors of anything unresolved (to tell a submodule path from a
 * missing file), and one batch-check against `probeRef` for the missing set.
 */
export function checkAdmissionImportCompleteness(input: ImportCompletenessInput): ImportCompletenessOutcome {
  const git = input.git ?? realAdmissionGit;
  const skipped: ImportCompletenessSkip[] = [];
  const checked: string[] = [];
  type Ask = { from: string; specifier: string; candidates: string[] };
  const asks: Ask[] = [];

  for (const path of input.paths) {
    const ext = posix.extname(path);
    if (!SCANNED_EXTENSIONS.has(ext)) {
      skipped.push({ path, reason: 'not-scanned-extension' });
      continue;
    }
    const blob = git(['cat-file', 'blob', `${input.commit}:${path}`], { cwd: input.root });
    if (blob.status !== 0) {
      // Deleted by this admission, a symlink/gitlink, or otherwise not a blob at the commit.
      skipped.push({ path, reason: 'not-a-blob' });
      continue;
    }
    checked.push(path);
    for (const specifier of extractRelativeImportSpecifiers(blob.stdout)) {
      const candidates = resolveImportCandidates(path, specifier);
      if (!candidates) {
        skipped.push({ path, reason: 'escapes-repo', specifier });
        continue;
      }
      asks.push({ from: path, specifier, candidates });
    }
  }

  const at = (rev: string, p: string) => `${rev}:${p}`;
  const first = batchKinds(
    git,
    input.root,
    asks.flatMap((a) => a.candidates.map((c) => at(input.commit, c))),
  );
  if (!first.ok) return { ok: false, code: 'git-failed', step: first.step, detail: first.detail };

  const unresolved: Ask[] = [];
  for (const ask of asks) {
    const hit = ask.candidates.some((c) => first.kinds.get(at(input.commit, c)) === 'blob');
    if (!hit) unresolved.push(ask);
  }
  if (unresolved.length === 0) return { ok: true, checked, imports: asks.length, skipped };

  // A path under a SUBMODULE cannot be read through the superproject's tree: the candidate
  // pins a gitlink there. That is not a missing sibling, so it is skipped, not refused.
  //
  // ⚠ This MUST be an `ls-tree` question, never a `cat-file --batch-check` one. For
  // `<commit>:<gitlink dir>` git resolves the path to the SUBMODULE's commit oid and then looks
  // that oid up in the SUPERPROJECT's object store — where it is correctly absent — so the
  // answer is `<oid> missing`, byte-for-byte the answer a deleted path gives. Measured
  // 2026-09-06: `apps/operator/bin/host-spa.ts` → `libs/generic/desktop-ipc/src/csp-policy`
  // was refused `admission-incomplete` ("does not exist on the shared tip either") while the
  // pinned desktop-ipc commit carried the file in both the candidate and the tip. `ls-tree -d`
  // reads the tree ENTRY (mode 160000) and needs no object lookup, so it cannot be fooled.
  const ancestorDirs = [...new Set(unresolved.flatMap((a) => ancestors(a.candidates[0]!)))];
  const gitlinks = batchGitlinks(git, input.root, input.commit, ancestorDirs);
  if (!gitlinks.ok) return { ok: false, code: 'git-failed', step: gitlinks.step, detail: gitlinks.detail };
  const reallyMissing: Ask[] = [];
  for (const ask of unresolved) {
    const underGitlink = ancestors(ask.candidates[0]!).some((d) => gitlinks.dirs.has(d));
    if (underGitlink) skipped.push({ path: ask.from, reason: 'inside-submodule', specifier: ask.specifier });
    else if (trackedGeneratedPackageBuilder(ask, input, git)) {
      skipped.push({ path: ask.from, reason: 'generated-by-tracked-builder', specifier: ask.specifier });
    } else reallyMissing.push(ask);
  }
  if (reallyMissing.length === 0) return { ok: true, checked, imports: asks.length, skipped };

  let probe: Map<string, ObjectKind> | null = null;
  if (input.probeRef) {
    const third = batchKinds(
      git,
      input.root,
      reallyMissing.flatMap((a) => a.candidates.map((c) => at(input.probeRef!, c))),
    );
    if (third.ok) probe = third.kinds;
  }
  const missing: AdmissionMissingImport[] = reallyMissing.map((ask) => {
    const present = probe ? ask.candidates.find((c) => probe!.get(at(input.probeRef!, c)) === 'blob') : undefined;
    return {
      from: ask.from,
      specifier: ask.specifier,
      wanted: present ?? ask.candidates[0]!,
      tried: ask.candidates,
      atProbeRef: probe ? (present ? 'present' : 'absent') : 'unknown',
    };
  });
  return { ok: false, code: 'admission-incomplete', missing, checked, imports: asks.length, skipped };
}

/**
 * D-045: a whole-blob admission must carry differing tests that import an admitted file,
 * plus differing modules imported by an admitted test, from the SAME resolved source commit.
 * Only paths differing from the pre-admission repair head can be owed. This check runs before
 * publication and never widens the caller's allowlist on its behalf.
 */
function checkWholeBlobSourceCohort(input: {
  root: string;
  sourceCommit: string;
  repairHead: string;
  admitted: readonly string[];
  git?: AdmissionGitRunner;
}):
  | { ok: true }
  | { ok: false; code: 'git-failed'; step: string; detail: string }
  | { ok: false; code: 'admission-incomplete'; missing: AdmissionMissingImport[] } {
  const git = input.git ?? realAdmissionGit;
  const diff = git(['diff', '--no-ext-diff', '--name-only', '-z', input.repairHead, input.sourceCommit, '--'],
    { cwd: input.root });
  if (diff.status !== 0) return {
    ok: false,
    code: 'git-failed',
    step: 'source cohort diff',
    detail: `exited ${diff.status}: ${(diff.stderr || diff.stdout).trim().slice(0, 400)}`,
  };
  const differing = new Set(diff.stdout.split('\0').filter(Boolean));
  const admitted = new Set(input.admitted);
  const testFile = (path: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
  const tests = [...new Set([...differing, ...admitted].filter(testFile))];
  if (tests.length === 0) return { ok: true };

  // EI-24383095185523946: resolving every extension candidate through rev:path
  // re-walked the same immutable tree thousands of times. Together with one
  // process per test blob this blocked the host until its watchdog killed it.
  // Read tree entries once, then fetch test contents by object id in one batch.
  const tree = git(['ls-tree', '-r', '-z', '--full-tree', input.sourceCommit], { cwd: input.root });
  const failed = (step: string, detail: string) => ({ ok: false as const, code: 'git-failed' as const, step, detail });
  if (tree.status !== 0) return failed('source cohort tree', (tree.stderr || tree.stdout).slice(0, 400));
  const blobs = new Map<string, string>();
  for (const entry of tree.stdout.split('\0').filter(Boolean)) {
    const parsed = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (!parsed) return failed('source cohort tree', 'malformed ls-tree entry');
    if (parsed[2] === 'blob') blobs.set(parsed[4]!, parsed[3]!);
  }
  const objectIds = [...new Set(tests.flatMap((test) => blobs.has(test) ? [blobs.get(test)!] : []))];
  const contents = new Map<string, string>();
  if (objectIds.length > 0) {
    const batch = git(['cat-file', '--batch'], { cwd: input.root, input: objectIds.join('\n') + '\n' });
    if (batch.status !== 0) return failed('source cohort blobs', (batch.stderr || batch.stdout).slice(0, 400));
    // Git frames contents by BYTES, including when source contains non-ASCII text.
    const bytes = Buffer.from(batch.stdout, 'utf8');
    let offset = 0;
    for (const oid of objectIds) {
      const end = bytes.indexOf(10, offset);
      const header = end < 0 ? null : /^([0-9a-f]{40,64}) blob (\d+)$/.exec(bytes.subarray(offset, end).toString('utf8'));
      if (!header || header[1] !== oid) return failed('source cohort blobs', 'missing or mismatched blob header');
      const size = Number(header[2]);
      const next = end + 1 + size;
      if (!Number.isSafeInteger(size) || next >= bytes.length || bytes[next] !== 10)
        return failed('source cohort blobs', 'truncated or malformed blob content');
      contents.set(oid, bytes.subarray(end + 1, next).toString('utf8'));
      offset = next + 1;
    }
    if (offset !== bytes.length) return failed('source cohort blobs', 'unexpected trailing blob data');
  }
  type ImportAsk = { test: string; specifier: string; candidates: string[] };
  const asks: ImportAsk[] = [];
  for (const test of tests) {
    // A test deleted at the pinned source cannot be imported from that source.
    const oid = blobs.get(test);
    if (!oid) continue;
    for (const specifier of extractRelativeImportSpecifiers(contents.get(oid)!)) {
      const candidates = resolveImportCandidates(test, specifier);
      if (candidates) asks.push({ test, specifier, candidates });
    }
  }

  const missing = new Map<string, AdmissionMissingImport>();
  for (const ask of asks) {
    const imported = ask.candidates.find((candidate) => blobs.has(candidate));
    if (!imported) continue;
    if (!admitted.has(ask.test) && admitted.has(imported) && differing.has(ask.test)) {
      missing.set(ask.test, {
        from: imported,
        specifier: ask.specifier,
        wanted: ask.test,
        tried: [ask.test],
        atProbeRef: 'present',
        relation: 'reverse-importer',
      });
    }
    if (admitted.has(ask.test) && differing.has(imported) && !admitted.has(imported)) {
      missing.set(imported, {
        from: ask.test,
        specifier: ask.specifier,
        wanted: imported,
        tried: ask.candidates,
        atProbeRef: 'present',
        relation: 'imported-module',
      });
    }
  }
  return missing.size === 0
    ? { ok: true }
    : { ok: false, code: 'admission-incomplete', missing: [...missing.values()] };
}

/** One line per missing import, for a refusal `detail`. */
export function renderMissingImports(missing: readonly AdmissionMissingImport[]): string {
  return missing
    .map((m) => {
      const where =
        m.atProbeRef === 'present'
          ? 'exists on the shared tip — admit it too'
          : m.atProbeRef === 'absent'
            ? 'does not exist on the shared tip either — write it, let git-sync commit it, then admit it'
            : 'admit it too';
      return `${m.from} imports ${JSON.stringify(m.specifier)} → ${m.wanted} (${where})`;
    })
    .join('; ');
}

/**
 * The `preflight` the admit door wires into `admitPathsOntoRepairHead` (P-004). Refuses an
 * admission whose files import paths that do not exist at the proved commit, naming them;
 * an instrument failure refuses too (fail closed).
 */
export function importCompletenessPreflight(opts: {
  root: string;
  probeRef?: string;
  git?: AdmissionGitRunner;
  /** D-045 whole-blob source-cohort closure; other admission modes retain the forward check. */
  enforceSourceCohort?: boolean;
}): NonNullable<AdmitPathsInput['preflight']> {
  return (built): AdmissionPreflightRefusal | null => {
    const r = checkAdmissionImportCompleteness({
      root: opts.root,
      commit: built.commit,
      paths: built.admitted,
      probeRef: opts.probeRef,
      git: opts.git,
    });
    if (!r.ok) {
      if (r.code === 'git-failed')
        return { code: 'git-failed', step: `completeness preflight: ${r.step}`, detail: r.detail };
      return {
        code: 'admission-incomplete',
        missing: r.missing,
        detail:
          `REFUSED: admission ${built.commit.slice(0, 12)} is incomplete — ${r.missing.length} import(s) resolve to nothing at ` +
          `the proved commit (${renderMissingImports(r.missing)}). It was NOT published and repairHead did not move; ` +
          'the tip is never widened for you — admit the named path(s) alongside yours.',
      };
    }
    if (!opts.enforceSourceCohort) return null;
    const cohort = checkWholeBlobSourceCohort({
      root: opts.root,
      sourceCommit: built.sourceCommit,
      repairHead: built.repairHead,
      admitted: built.admitted,
      git: opts.git,
    });
    if (cohort.ok) return null;
    if (cohort.code === 'git-failed') return {
      code: 'git-failed',
      step: `source cohort preflight: ${cohort.step}`,
      detail: cohort.detail,
    };
    const listed = cohort.missing.map((m) => m.relation === 'reverse-importer'
      ? `${m.wanted} imports admitted ${m.from} via ${JSON.stringify(m.specifier)}`
      : `${m.wanted} is imported by admitted test ${m.from} via ${JSON.stringify(m.specifier)}`);
    return {
      code: 'admission-incomplete',
      missing: cohort.missing,
      detail:
        `REFUSED: whole-blob admission ${built.commit.slice(0, 12)} omits ${cohort.missing.length} differing ` +
        `same-source cohort path(s) from ${built.sourceCommit.slice(0, 12)} (${listed.join('; ')}). ` +
        'It was NOT published and repairHead did not move; admit the named paths from the same source commit.',
    };
  };
}
