/**
 * rubrics-citation-checks — static citation checks for acceptance-rubric prose.
 *
 * Acceptance rubrics are authored after implementation and their method /
 * replication prose is the grader's map back to the code.  A path that exists
 * but points at a different module turns a healthy implementation into an
 * unmeasurable one: the grader quite correctly refuses to infer an absent
 * branch from a bounded search, and the rubric records a false `unknown`.
 *
 * This is deliberately a small, pure, propose-time guard:
 *   - repository-looking source paths are resolved against the selected tree;
 *   - an explicit symbol or named `describe()` / `it()` / `test()` case is
 *     required to occur literally in the file it accompanies.
 *
 * It does not attempt to infer every noun in free prose.  Only explicit
 * anchors (or the `symbol-level` form, which promises a named subject) are
 * checked, so ordinary explanatory text remains valid.  The caller injects
 * filesystem access in tests; no database or rubric store is imported here.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveAgentWorkspaceRoot } from './agent-tools/capability/base-dir';
import { checkoutRootForPath, normalizeTestFilePaths } from './agent-tools/testing/run';

export interface AcceptanceRubricCitationCriterion {
  key: string;
  method?: string;
  replication?: string;
}

export type AcceptanceRubricCitationSource = 'method' | 'replication';
export type AcceptanceRubricCitationAnchorKind = 'symbol' | 'test-case';

export interface AcceptanceRubricCitationAnchor {
  criterionKey: string;
  source: AcceptanceRubricCitationSource;
  path: string;
  literal: string;
  kind: AcceptanceRubricCitationAnchorKind;
}

export type AcceptanceRubricCitationFailureReason =
  | 'path_absolute'
  | 'path_escapes_repo'
  | 'path_missing'
  | 'not_a_file'
  | 'literal_missing';

export interface AcceptanceRubricCitationFailure {
  criterionKey: string;
  source: AcceptanceRubricCitationSource;
  path: string;
  reason: AcceptanceRubricCitationFailureReason;
  literal?: string;
  detail: string;
}

export interface AcceptanceRubricCitationValidation {
  ok: boolean;
  /** Number of distinct repository-looking file citations examined. */
  checkedPaths: number;
  /** Explicit anchors that were associated with a cited path and checked. */
  checkedAnchors: AcceptanceRubricCitationAnchor[];
  failures: AcceptanceRubricCitationFailure[];
  /**
   * EI-24372605712471072: citations accepted as PLANNED instead of refused — a missing
   * file or a missing named anchor, admitted only when the caller passed
   * `allowPlannedPaths` (a subject plan whose implementation has not begun). Always
   * present (empty when the allowance is off) so a caller can surface them.
   */
  planned: AcceptanceRubricCitationFailure[];
}

export interface AcceptanceRubricCitationOptions {
  root?: string;
  deps?: AcceptanceRubricCitationDeps;
  /**
   * Treat a citation to a file (or a named symbol / test case) that does not exist YET as
   * planned rather than refusing it. Only a rubric write against a subject plan whose
   * implementation has not begun may pass this; see `subjectPlanAllowsPlannedPaths`.
   * Absolute, repo-escaping, and non-file citations are still refused.
   */
  allowPlannedPaths?: boolean;
}

export interface AcceptanceRubricCitationDeps {
  /** Resolve a repo-relative path to a regular file, or null when it is absent. */
  statFile?: (root: string, path: string) => { isFile: boolean } | null;
  /** Read a repo-relative file, or null when it is unreadable. */
  readFile?: (root: string, path: string) => string | null;
}

interface PathMention {
  path: string;
  start: number;
  end: number;
}

interface TextAnchor {
  literal: string;
  kind: AcceptanceRubricCitationAnchorKind;
  start: number;
  end: number;
  /** Set when a `symbol-level` phrase names the path explicitly. */
  path?: string;
}

/**
 * Source-file extensions are intentionally conservative.  A bare directory
 * mention such as `packages/operator-core/lib/events/await` is explanatory
 * prose, not a file citation that this guard can validate.
 */
const SOURCE_FILE_PATH_RE =
  /\b((?:[A-Za-z0-9._@~+%=-]+\/)?(?:packages|apps|libs|scripts)\/[A-Za-z0-9._@~+%=-]+(?:\/[A-Za-z0-9._@~+%=-]+)*\.[A-Za-z][A-Za-z0-9]*)(?=[:#]\d+|$|[\s'"`)\]}:,. ;])/g;

const QUOTED_TEST_CASE_RE =
  /\b(?:describe|it|test)\s*\(\s*(['"`])([\s\S]*?)\1/g;

/** Phrases that explicitly promise a named case to the grader. */
const NAMED_TEST_CASE_RE =
  /\b(?:(?:named|the)\s+(?:case|block|test)|(?:case|block|test)\s+(?:named|called))\s*[:=]?\s*(['"`])([\s\S]*?)\1/gi;

/**
 * Explicit symbol syntax is intentionally narrow.  `symbol-level` without a
 * subject is handled separately below because it still promises that the
 * immediately described subject is a symbol-level citation.
 */
const EXPLICIT_SYMBOL_RE =
  /\bsymbol\s*(?::|=)\s*(['"`]?)([A-Za-z_$][A-Za-z0-9_$:.#-]*)\1/gi;

const BACKTICK_SYMBOL_RE =
  /\b(?:symbol|function|method)\s+(['"`])([A-Za-z_$][A-Za-z0-9_$:.#-]*)\1/gi;

/** `Read the lineage check in path.ts (symbol-level; …)` → `lineage check`. */
const SYMBOL_LEVEL_SUBJECT_RE =
  /\b(?:read|inspect|open|check|confirm|verify)\s+(?:the\s+)?(.+?)\s+in\s+((?:[A-Za-z0-9._@~+%=-]+\/)?(?:packages|apps|libs|scripts)\/[A-Za-z0-9._@~+%=-]+(?:\/[A-Za-z0-9._@~+%=-]+)*\.[A-Za-z0-9][A-Za-z0-9._+-]*)(?=[:#]\d+)?[^.\n]*\bsymbol[- ]level\b/gi;

/**
 * Resolve the same two portable path forms accepted by structured rubric checks:
 * a file relative to the subject checkout, or a workspace-relative path whose
 * first segment names one admitted independent sibling checkout.  The latter is
 * how a Papercusp-owned plan cites code delivered in a registered app checkout
 * (for example `portal/packages/contracts/src/index.ts`).
 *
 * Reuse the testing router's existing sibling normalizer rather than growing a
 * third workspace scanner here.  An absolute result is accepted only when the
 * router can prove the file belongs to a real workspace checkout; arbitrary
 * absolute paths and release/checkpoint worktrees remain outside the admission
 * rule.
 */
function resolveCitationFile(root: string, path: string): string | null {
  const normalized = normalizeTestFilePaths([path], root);
  if (!normalized.ok || normalized.files.length !== 1) return null;
  const selected = normalized.files[0]!;
  const absolute = isAbsolute(selected) ? resolve(selected) : resolve(root, selected);
  const admittedRoot = isAbsolute(selected) ? checkoutRootForPath(absolute) : root;
  if (!admittedRoot || !isInsideRoot(admittedRoot, absolute)) return null;
  return absolute;
}

function defaultStatFile(root: string, path: string): { isFile: boolean } | null {
  const absolute = resolveCitationFile(root, path);
  if (!absolute) return null;
  try {
    return { isFile: statSync(absolute).isFile() };
  } catch {
    return null;
  }
}

function defaultReadFile(root: string, path: string): string | null {
  const absolute = resolveCitationFile(root, path);
  if (!absolute) return null;
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function isInsideRoot(root: string, absolute: string): boolean {
  const rootReal = realpathSoft(root);
  const absoluteReal = realpathSoft(absolute);
  const rel = relative(rootReal, absoluteReal);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realpathSoft(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function normalizeLiteral(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pathMentions(text: string): PathMention[] {
  SOURCE_FILE_PATH_RE.lastIndex = 0;
  return [...text.matchAll(SOURCE_FILE_PATH_RE)].map((match) => ({
    path: match[1]!,
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function explicitAnchors(text: string): TextAnchor[] {
  const anchors: TextAnchor[] = [];
  const addQuoted = (
    re: RegExp,
    kind: AcceptanceRubricCitationAnchorKind,
  ): void => {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const literal = normalizeLiteral(match[2] ?? '');
      if (!literal || literal.includes('${')) continue;
      const start = match.index ?? 0;
      anchors.push({
        literal,
        kind,
        start,
        end: start + match[0].length,
      });
    }
  };

  addQuoted(QUOTED_TEST_CASE_RE, 'test-case');
  addQuoted(NAMED_TEST_CASE_RE, 'test-case');

  EXPLICIT_SYMBOL_RE.lastIndex = 0;
  for (const match of text.matchAll(EXPLICIT_SYMBOL_RE)) {
    const literal = normalizeLiteral(match[2] ?? '');
    if (!literal) continue;
    const start = match.index ?? 0;
    anchors.push({
      literal,
      kind: 'symbol',
      start,
      end: start + match[0].length,
    });
  }

  addQuoted(BACKTICK_SYMBOL_RE, 'symbol');

  // This is the one semantic-looking form we accept: `symbol-level` is an
  // explicit promise that the subject immediately before `in <path>` is the
  // symbol-level anchor.  Without that marker, ordinary prose such as
  // "read the delivery path in ..." remains path-only validation.
  SYMBOL_LEVEL_SUBJECT_RE.lastIndex = 0;
  for (const match of text.matchAll(SYMBOL_LEVEL_SUBJECT_RE)) {
    const literal = normalizeLiteral(match[1] ?? '');
    const path = match[2];
    if (!literal || !path) continue;
    const pathOffset = (match.index ?? 0) + match[0].indexOf(path);
    const subjectStart = (match.index ?? 0) + match[0].indexOf(match[1] ?? '');
    anchors.push({
      literal,
      kind: 'symbol',
      start: subjectStart,
      end: pathOffset,
      path,
    });
  }

  return anchors.sort((a, b) => a.start - b.start);
}

function sameCitationClause(text: string, left: number, right: number): string {
  const start = text.lastIndexOf('\n', left);
  const end = text.indexOf('\n', right);
  return text.slice(start + 1, end === -1 ? text.length : end);
}

/**
 * Pick an anchor for a path only when they share a short citation clause.
 * Nearest-path association is deterministic and avoids attributing a named
 * test in one `testing:run` call to an unrelated file in the next sentence.
 */
function anchorsForPath(text: string, path: PathMention, anchors: TextAnchor[]): TextAnchor[] {
  const candidates = anchors.filter((anchor) => {
    if (anchor.path && anchor.path !== path.path) return false;
    // A named describe()/it()/test() case is a test-file anchor.  Do not let
    // a later optional probe script inherit the nearest case name merely
    // because both appear in one long replication paragraph.
    if (
      anchor.kind === 'test-case' &&
      !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path.path)
    ) {
      return false;
    }
    const clause = sameCitationClause(text, Math.min(path.start, anchor.start), Math.max(path.end, anchor.end));
    return clause.includes(path.path);
  });
  if (candidates.length === 0) return [];
  const nearest = Math.min(...candidates.map((anchor) => Math.abs(anchor.start - path.start)));
  const nearestAnchors = candidates.filter((anchor) => Math.abs(anchor.start - path.start) === nearest);
  if (nearestAnchors.length > 1) return [];
  return nearestAnchors;
}

function failure(
  criterionKey: string,
  source: AcceptanceRubricCitationSource,
  path: string,
  reason: AcceptanceRubricCitationFailureReason,
  detail: string,
  literal?: string,
): AcceptanceRubricCitationFailure {
  return { criterionKey, source, path, reason, detail, ...(literal ? { literal } : {}) };
}

/**
 * Pure propose-time validation for acceptance-rubric method/replication
 * citations.  A result with `ok:false` is suitable for a caller error; the
 * refusing wrapper below supplies the standard `invalid_args:` prefix.
 */
export function validateAcceptanceRubricCitationPaths(
  criteria: ReadonlyArray<AcceptanceRubricCitationCriterion>,
  opts: AcceptanceRubricCitationOptions = {},
): AcceptanceRubricCitationValidation {
  const root = opts.root ?? resolveAgentWorkspaceRoot({});
  const statFile = opts.deps?.statFile ?? defaultStatFile;
  const readFile = opts.deps?.readFile ?? defaultReadFile;
  const failures: AcceptanceRubricCitationFailure[] = [];
  const planned: AcceptanceRubricCitationFailure[] = [];
  // Only the "does not exist yet" reasons can be planned. A path that is absolute,
  // escapes the repository, or names a directory is wrong now and will stay wrong.
  const refuseOrPlan = (item: AcceptanceRubricCitationFailure): void => {
    if (opts.allowPlannedPaths && (item.reason === 'path_missing' || item.reason === 'literal_missing')) {
      planned.push(item);
    } else {
      failures.push(item);
    }
  };
  const checkedAnchors: AcceptanceRubricCitationAnchor[] = [];
  const seenPaths = new Set<string>();
  let checkedPaths = 0;

  for (const criterion of criteria) {
    for (const source of ['method', 'replication'] as const) {
      const text = criterion[source];
      if (!text) continue;
      const mentions = pathMentions(text);
      const anchors = explicitAnchors(text);
      for (const mention of mentions) {
        const path = mention.path;
        const pathKey = `${source}\u0000${path}`;
        if (!seenPaths.has(`${criterion.key}\u0000${pathKey}`)) {
          seenPaths.add(`${criterion.key}\u0000${pathKey}`);
          checkedPaths++;
        }

        if (isAbsolute(path)) {
          failures.push(
            failure(
              criterion.key,
              source,
              path,
              'path_absolute',
              'citation paths must be repository-relative; absolute paths are machine-specific',
            ),
          );
          continue;
        }
        if (path.split('/').some((segment) => segment === '..')) {
          failures.push(
            failure(
              criterion.key,
              source,
              path,
              'path_escapes_repo',
              'citation path contains a `..` segment and escapes the claimed repository root',
            ),
          );
          continue;
        }

        const stat = statFile(root, path);
        if (!stat) {
          refuseOrPlan(
            failure(
              criterion.key,
              source,
              path,
              'path_missing',
              `does not resolve against the live tree rooted at '${root}'`,
            ),
          );
          continue;
        }
        if (!stat.isFile) {
          failures.push(
            failure(criterion.key, source, path, 'not_a_file', 'resolves, but not to a regular file'),
          );
          continue;
        }

        const body = readFile(root, path);
        for (const anchor of anchorsForPath(text, mention, anchors)) {
          const record: AcceptanceRubricCitationAnchor = {
            criterionKey: criterion.key,
            source,
            path,
            literal: anchor.literal,
            kind: anchor.kind,
          };
          checkedAnchors.push(record);
          if (body == null || !body.includes(anchor.literal)) {
            refuseOrPlan(
              failure(
                criterion.key,
                source,
                path,
                'literal_missing',
                `${anchor.kind} literal ${JSON.stringify(anchor.literal)} does not appear in the cited file`,
                anchor.literal,
              ),
            );
          }
        }
      }
    }
  }

  return { ok: failures.length === 0, checkedPaths, checkedAnchors, failures, planned };
}

/**
 * Throw the standard caller-facing refusal used by rubrics:propose. Returns the
 * validation when it passes, so a caller can surface citations accepted as planned.
 */
export function assertAcceptanceRubricCitationPathsResolve(
  criteria: ReadonlyArray<AcceptanceRubricCitationCriterion>,
  opts: AcceptanceRubricCitationOptions = {},
): AcceptanceRubricCitationValidation {
  const result = validateAcceptanceRubricCitationPaths(criteria, opts);
  if (result.ok) return result;

  const lines = result.failures.map((item) => {
    const anchor = item.literal ? ` — literal ${JSON.stringify(item.literal)}` : '';
    return `  • criterion '${item.criterionKey}' (${item.source}): ${item.path} — ${item.detail}${anchor}`;
  });
  throw new Error(
    `invalid_args: proposeRubric: acceptance-rubric citation(s) do not resolve to the cited source ` +
      `or named symbol/test case:\n${lines.join('\n')}\n` +
      'Fix the path or named anchor, or remove the citation from the criterion prose.',
  );
}
