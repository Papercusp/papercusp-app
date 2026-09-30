/**
 * Scanner for the INVERTED form of the block-3b guard (EI-19374654827980571).
 *
 * ## What this answers
 *
 * `setup-release-checkout.sh` block 3b provisions gitignored runtime assets
 * into the gate's checkout, but it provisions exactly ONE root:
 * `apps/operator/public`. The sibling guard
 * (`setup-release-checkout-runtime-assets.test.ts`) locks the REGRESSION
 * direction — deleting the block, narrowing its root, breaking its pipeline.
 *
 * It cannot see the EXTENSION direction: a NEW test that hard-requires a
 * gitignored artifact under any OTHER root reproduces the original failure in
 * full, with none of that guard firing. That failure is maximally deceptive —
 * PERMANENT (no re-fire can materialise a gitignored file), fleet-wide (it
 * red-pins `main`), and impossible for its author to reproduce locally BY
 * CONSTRUCTION, because it passes on every machine where postinstall ran.
 *
 * So this module inverts the question: enumerate the roots 3b WOULD copy, then
 * assert that every gitignored path a test HARD-REQUIRES falls inside that set.
 * The guard therefore fails toward "3b's coverage is too narrow", which is the
 * actionable direction — widening 3b's roots turns it green again.
 *
 * ## Why an AST rather than a text scan
 *
 * The obvious scan — "flag tests mentioning gitignored paths" — is too noisy to
 * survive. Measured on this repo (EI-19373637173456393): of 15 ignored paths
 * implicated by a literal-prefix text scan, only 2 genuinely required the
 * artifact; the other 13 were `.next` / `dist` / `tsbuildinfo` / `.astro` paths
 * tests merely MENTION. A guard with a 13/15 false-positive rate gets ignored,
 * then disabled.
 *
 * Discriminating "REQUIRES this path exists" from "mentions this path" is the
 * whole problem, and it needs two things a text scan cannot do:
 *
 *   1. the path must flow into a call whose failure mode IS "file missing"
 *      (`existsSync`, `readFile`, `statSync`, ...), and
 *   2. that call must not be in a position that TOLERATES absence (a skip
 *      guard, a ternary, a try/catch) — tolerating absence is the correct
 *      pattern and must never be flagged.
 *
 * Measured after this change: 0 violations and 0 false positives across the
 * repo's test corpus, versus 13 false positives for the text scan.
 *
 * ## Why `git check-ignore` rather than `git status --ignored`
 *
 * `git status --porcelain --ignored` only reports paths that EXIST ON DISK. Its
 * answer therefore differs between a dev box (assets present, postinstall ran)
 * and the gate's checkout (assets absent — the very condition being guarded),
 * which would make this guard's verdict depend on where it runs.
 * `git check-ignore` evaluates the ignore RULES against a path string, so it
 * answers identically in both places, including for paths that do not exist.
 * It also consults the index, so a TRACKED file is correctly reported as not
 * ignored — tracked content survives `git clean -fdqx` and is never at risk.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

import {
  type IgnoredRuntimeEntryWorkspace,
  runtimeBuildProvisionedRoots,
} from './runtime-workspace-build-coverage';

/**
 * fs entry points whose failure mode when the path is absent IS the red we are
 * guarding against. Both the sync and the promise-based spellings are listed
 * DELIBERATELY: the first draft of this scanner covered only the `*Sync` forms
 * and silently missed `porcupine-cdn.test.ts`, which is one of the two known
 * real instances (it does `await readFile(VENDORED_MODEL)`). A scanner that
 * cannot detect an instance you already know about certifies nothing.
 */
const FS_REQUIRE_FNS = new Set([
  'existsSync', 'readFileSync', 'statSync', 'lstatSync', 'readdirSync',
  'openSync', 'accessSync', 'realpathSync', 'copyFileSync', 'createReadStream',
  'readFile', 'stat', 'lstat', 'readdir', 'open', 'access', 'realpath', 'copyFile',
]);

/** Cheap source prefilter derived from the authoritative call set above. */
const FS_REQUIRE_PREFILTER = new RegExp(
  `\\b(?:${[...FS_REQUIRE_FNS].sort((a, b) => b.length - a.length).join('|')})\\b`,
);

/** Path-composition helpers whose arguments are path FRAGMENTS. */
const PATH_JOIN_FNS = new Set(['resolve', 'join', 'normalize', 'relative']);

/** Constructors that make a path private to a test fixture, not the checkout. */
const TEMP_ROOT_FNS = new Set(['mkdtemp', 'mkdtempSync', 'tmpdir']);

/** A literal that looks like a repo-relative path into this monorepo. */
const REPO_RELATIVE = /^(apps|packages|libs|scripts|docs|bin|papercusp-desktop|e2e)\//;

export interface RequiredAssetSite {
  /** repo-relative path of the test file making the requirement */
  file: string;
  line: number;
  /** the fs function through which the requirement is expressed */
  fn: string;
  /** the repo-relative path the test requires to exist */
  path: string;
}

export interface UndecidablePath {
  path: string;
  reason: string;
}

export interface AssetCoverageResult {
  /** every hard-required path that is gitignored, covered or not */
  required: RequiredAssetSite[];
  /** required + gitignored + inside a root 3b provisions */
  covered: RequiredAssetSite[];
  /** required + gitignored + OUTSIDE every root 3b provisions — the red-pin risk */
  violations: RequiredAssetSite[];
  /** paths git could not decide on; surfaced rather than silently passed */
  undecidable: UndecidablePath[];
  /** diagnostics so a green result can be shown to be non-vacuous */
  stats: { testFilesScanned: number; parsed: number; sites: number; candidates: number };
}

/**
 * Resolve identifiers the way the language does: innermost binding wins.
 *
 * A FLAT file-wide name->initializer map (what this used to be) conflates
 * DISTINCT bindings that merely share a name, and the failure is silent and
 * expensive. Measured on `setup-release-checkout-deps.test.ts`: an outer
 * `let rel: string` assigned `mkdtempSync(join(tmpdir(), 'nm-rel-'))` in a
 * `beforeEach`, and — in an unrelated `describe` 280 lines away — a block-local
 * `const rel = 'packages/example/node_modules'`. Only the second is a
 * VariableDeclaration WITH an initializer, so the flat map bound `rel` to that
 * literal FILE-WIDE and reported three violations against paths that only ever
 * exist under a temp dir. `derivesFromTemporaryFixture` could not rescue it:
 * it follows the same map, so it never saw the `mkdtempSync` provenance.
 *
 * Two things are therefore required, and neither alone is enough:
 *   1. SCOPE the bindings, so the sibling `describe`'s `rel` is not visible
 *      from this one; and
 *   2. record ASSIGNMENTS (`rel = mkdtempSync(...)`), attributing them to the
 *      scope that DECLARED the name — a `let` declared without an initializer
 *      and assigned in a `beforeEach` is the single most common fixture shape
 *      in this repo, and it was previously invisible.
 *
 * `var` hoisting is deliberately not modelled: treating every declaration as
 * block-scoped is strictly closer to the truth than one file-wide bucket, and
 * the residual error direction is a name resolving to nothing (a missed
 * candidate) rather than to some other binding's literal (a false red).
 */
function buildScopedConstResolver(sf: ts.SourceFile): (node: ts.Node) => Map<string, ts.Expression> {
  const isScope = (n: ts.Node): boolean =>
    ts.isSourceFile(n) ||
    ts.isBlock(n) ||
    ts.isCaseBlock(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n);

  const scopeOf = (n: ts.Node): ts.Node => {
    let cur: ts.Node | undefined = n.parent;
    while (cur && !isScope(cur)) cur = cur.parent;
    return cur ?? sf;
  };

  /** name -> initializer, per scope. First binding wins, as before. */
  const bindings = new Map<ts.Node, Map<string, ts.Expression>>();
  /** every name DECLARED in a scope, initializer or not — lets an assignment find its declarer. */
  const declared = new Map<ts.Node, Set<string>>();

  const bind = (scope: ts.Node, name: string, init: ts.Expression): void => {
    let m = bindings.get(scope);
    if (!m) bindings.set(scope, (m = new Map()));
    if (!m.has(name)) m.set(name, init);
  };

  // Pass 1 — declarations. Record the name even without an initializer.
  const collectDecls = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const scope = scopeOf(n);
      let names = declared.get(scope);
      if (!names) declared.set(scope, (names = new Set()));
      names.add(n.name.text);
      if (n.initializer) bind(scope, n.name.text, n.initializer);
    }
    ts.forEachChild(n, collectDecls);
  };
  collectDecls(sf);

  // Pass 2 — plain assignments, attributed to the scope that declared the name.
  const collectAssignments = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      const name = n.left.text;
      let scope: ts.Node | undefined = scopeOf(n);
      while (scope && !declared.get(scope)?.has(name)) {
        scope = scope === sf ? undefined : scopeOf(scope);
      }
      bind(scope ?? scopeOf(n), name, n.right);
    }
    ts.forEachChild(n, collectAssignments);
  };
  collectAssignments(sf);

  const cache = new Map<ts.Node, Map<string, ts.Expression>>();
  return (node: ts.Node): Map<string, ts.Expression> => {
    const scope = scopeOf(node);
    const hit = cache.get(scope);
    if (hit) return hit;
    // Outermost first, so an inner binding OVERWRITES the outer one it shadows.
    const chain: ts.Node[] = [];
    for (let cur: ts.Node | undefined = scope; cur; cur = cur === sf ? undefined : scopeOf(cur)) {
      chain.unshift(cur);
    }
    const merged = new Map<string, ts.Expression>();
    for (const s of chain) {
      const m = bindings.get(s);
      if (m) for (const [k, v] of m) merged.set(k, v);
    }
    cache.set(scope, merged);
    return merged;
  };
}

/** Collect string literals reachable from a path expression, following local consts. */
function literalsOf(
  node: ts.Node | undefined,
  consts: Map<string, ts.Expression>,
  depth = 0,
  seen: Set<string> = new Set(),
): string[] {
  if (!node || depth > 8) return [];

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];

  if (ts.isTemplateExpression(node)) {
    const out: string[] = node.head.text ? [node.head.text] : [];
    for (const span of node.templateSpans) {
      out.push(...literalsOf(span.expression, consts, depth + 1, seen));
      if (span.literal.text) out.push(span.literal.text);
    }
    return out;
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [
      ...literalsOf(node.left, consts, depth + 1, seen),
      ...literalsOf(node.right, consts, depth + 1, seen),
    ];
  }

  if (ts.isCallExpression(node)) {
    const fn = calleeName(node);
    // Only descend through path-composition calls; the vditor case is
    // `resolve(REPO_ROOT, 'apps/operator/public', base, 'dist/js/lute/lute.min.js')`,
    // i.e. the interesting literals are arguments of a join, not the callee.
    return PATH_JOIN_FNS.has(fn)
      ? node.arguments.flatMap((a) => literalsOf(a, consts, depth + 1, seen))
      : [];
  }

  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return [];
    const next = new Set(seen);
    next.add(node.text);
    const init = consts.get(node.text);
    return init ? literalsOf(init, consts, depth + 1, next) : [];
  }

  if (ts.isParenthesizedExpression(node)) return literalsOf(node.expression, consts, depth + 1, seen);

  return [];
}

function calleeName(node: ts.CallExpression): string {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return '';
}

/**
 * Does this call sit somewhere that TOLERATES the path being absent?
 *
 * `if (!existsSync(p)) return;`, `existsSync(p) ? a : b`, `it.skipIf(!existsSync(p))`
 * and try/catch are all the CORRECT pattern for an optional artifact — a test
 * that degrades to a skip cannot red-pin the gate, so flagging it would be a
 * false positive and would push authors toward disabling this guard.
 */
function toleratesAbsence(call: ts.CallExpression): boolean {
  let n: ts.Node | undefined = call.parent;
  for (let hops = 0; n && hops < 8; hops++, n = n.parent) {
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) return true;
    if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isTryStatement(n)) return true;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return true;
    }
    if (ts.isCallExpression(n) && /skipIf|runIf/.test(calleeName(n))) return true;
  }
  return false;
}

/**
 * Does a required path derive from a temporary fixture root?
 *
 * A fixture may intentionally mirror a repository layout below
 * `mkdtempSync(tmpdir())`, for example `<tmp>/libs/generic/sse/dist`. The
 * literal suffix still looks repo-relative, but `git clean` can never remove
 * it from the release checkout because it is not in that checkout at all.
 * Keep that provenance while following local const aliases so the scanner
 * does not turn fixture fidelity into a permanent false red.
 */
function derivesFromTemporaryFixture(
  node: ts.Node | undefined,
  constsAt: (n: ts.Node) => Map<string, ts.Expression>,
  fns: Map<string, ts.SignatureDeclaration> = new Map(),
  depth = 0,
  seen: Set<string> = new Set(),
): boolean {
  if (!node || depth > 12) return false;

  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) return false;
    // Resolve at THIS node's scope, not the original call site's: once we
    // follow a helper's `return root`, that `root` is the helper's own local
    // binding, a different variable that merely shares the caller's name.
    const init = constsAt(node).get(node.text);
    if (!init) return false;
    const next = new Set(seen);
    next.add(node.text);
    return derivesFromTemporaryFixture(init, constsAt, fns, depth + 1, next);
  }

  if (ts.isCallExpression(node)) {
    if (TEMP_ROOT_FNS.has(calleeName(node))) return true;
    // Follow a LOCAL fixture helper: `const root = fixture({...})` where
    // `function fixture(): string { const root = mkdtempSync(...); ... return root; }`
    // is the dominant fixture shape in this repo, and without this the helper's
    // temp provenance is invisible — every repo-shaped path built under its
    // return value reads as a real requirement. Only the RETURN expressions are
    // inspected, never the whole body: a helper that merely mentions `tmpdir()`
    // while returning a repo path must still be flagged.
    const callee = calleeName(node);
    if (callee && !seen.has(`fn:${callee}`)) {
      const fn = fns.get(callee);
      if (fn) {
        // Cross into the helper with the identifier trail CLEARED — only the
        // recursion guards carry over. The caller's names shadow nothing here,
        // and keeping them would make the helper's own `root` look already-seen.
        const next = new Set([...seen].filter((s) => s.startsWith('fn:')));
        next.add(`fn:${callee}`);
        return returnExpressionsOf(fn).some((r) =>
          derivesFromTemporaryFixture(r, constsAt, fns, depth + 1, next),
        );
      }
    }
  }

  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && derivesFromTemporaryFixture(child, constsAt, fns, depth + 1, seen)) found = true;
  });
  return found;
}

/** Local named functions, so a call to one can be followed to what it returns. */
function collectLocalFunctions(sf: ts.SourceFile): Map<string, ts.SignatureDeclaration> {
  const out = new Map<string, ts.SignatureDeclaration>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && !out.has(n.name.text)) {
      out.set(n.name.text, n);
    } else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
      !out.has(n.name.text)
    ) {
      out.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every expression a function can return, including a concise arrow body. */
function returnExpressionsOf(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as { body?: ts.Node }).body;
  if (!body) return [];
  if (!ts.isBlock(body)) return ts.isExpression(body as ts.Node) ? [body as ts.Expression] : [];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    // Do not descend into nested functions — their returns are not this one's.
    if (n !== body && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) {
      return;
    }
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(body);
  return out;
}

/** Candidate repo-relative paths implied by one fs-require site. */
function candidatePathsFor(literals: string[]): string[] {
  const out = new Set<string>();
  for (let i = 0; i < literals.length; i++) {
    const base = literals[i];
    if (!REPO_RELATIVE.test(base)) continue;
    const clean = (s: string) => s.replace(/^\/+|\/+$/g, '');
    out.add(clean(base));
    // Join with the following literal fragments — the vditor shape splits the
    // path across several arguments of a single resolve().
    const tail = literals
      .slice(i + 1)
      .filter((l) => l && !l.startsWith('.') && !l.startsWith('/') && !REPO_RELATIVE.test(l));
    for (let take = 1; take <= tail.length; take++) {
      out.add(clean([base, ...tail.slice(0, take)].join('/')).replace(/\/{2,}/g, '/'));
    }
  }
  return [...out];
}

/**
 * Ask git whether each path is ignored, routing submodule-internal paths to
 * their owning submodule (the superproject answers `fatal: ... is in submodule`
 * for those, which must NOT be swallowed as "not ignored").
 */
export function makeGitIgnoreOracle(repoRoot: string, submodulePaths: string[]) {
  return function isIgnored(path: string): boolean | 'unknown' {
    const sub = submodulePaths
      .filter((s) => path === s || path.startsWith(s + '/'))
      .sort((a, b) => b.length - a.length)[0];
    const cwd = sub ? `${repoRoot}/${sub}` : repoRoot;
    const rel = sub ? path.slice(sub.length + 1) : path;
    if (!rel) return false;
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd, stdio: 'pipe' });
      return true;
    } catch (err) {
      // exit 1 = "not ignored" (the normal answer). Any other status means git
      // could not decide, which is reported rather than treated as a pass.
      const status = (err as { status?: number }).status;
      return status === 1 ? false : 'unknown';
    }
  };
}

export function listSubmodulePaths(repoRoot: string): string[] {
  try {
    const out = execFileSync('git', ['config', '--file', '.gitmodules', '--get-regexp', 'path'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extract every gitignored root the release setup provisions, FROM THE
 * SHIPPED SCRIPT and the declared runtime entries of workspace packages.
 *
 * Block 3b copies registered asset roots. Block 3c-2 builds registered
 * workspace outputs from pinned source. Treating either mechanism as the only
 * one produces a false verdict, so this is the shared coverage derivation for
 * both materialization paths.
 */
export function extractProvisionedRoots(
  scriptSource: string,
  runtimeEntries: Iterable<IgnoredRuntimeEntryWorkspace> = [],
): string[] {
  const roots = new Set<string>();
  for (const m of scriptSource.matchAll(/^\s*[A-Z_]*ASSET_REL(?:\[\d*\])?=["']([^"']+)["']/gm)) {
    roots.add(m[1].replace(/\/+$/, ''));
  }
  for (const root of runtimeBuildProvisionedRoots(scriptSource, runtimeEntries)) roots.add(root);
  return [...roots];
}

/** Keep only the most specific required path per (file, line, fn) site. */
function dropNestedDuplicates(sites: RequiredAssetSite[]): RequiredAssetSite[] {
  const bySite = new Map<string, RequiredAssetSite[]>();
  for (const s of sites) {
    const key = `${s.file}:${s.line}:${s.fn}`;
    const list = bySite.get(key);
    if (list) list.push(s);
    else bySite.set(key, [s]);
  }
  const out: RequiredAssetSite[] = [];
  for (const list of bySite.values()) {
    for (const s of list) {
      const hasMoreSpecific = list.some((o) => o !== s && o.path.startsWith(s.path + '/'));
      if (!hasMoreSpecific) out.push(s);
    }
  }
  return out;
}

export function scanRequiredIgnoredAssets(opts: {
  repoRoot: string;
  /** repo-relative test file paths */
  testFiles: string[];
  /** roots block 3b provisions, e.g. ['apps/operator/public'] */
  coveredRoots: string[];
  isIgnored: (path: string) => boolean | 'unknown';
  readFile?: (absPath: string) => string;
}): AssetCoverageResult {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const sites: RequiredAssetSite[] = [];
  let parsed = 0;

  for (const rel of opts.testFiles) {
    let src: string;
    try {
      src = read(`${opts.repoRoot}/${rel}`);
    } catch {
      continue;
    }
    // Cheap prefilter. It is generated from FS_REQUIRE_FNS because a second
    // hand-maintained list silently skipped readFileSync-only tests even while
    // the AST pass claimed that spelling was supported.
    if (!FS_REQUIRE_PREFILTER.test(src)) {
      continue;
    }
    parsed++;

    const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const constsAt = buildScopedConstResolver(sf);
    const localFns = collectLocalFunctions(sf);

    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const fn = calleeName(n);
        if (FS_REQUIRE_FNS.has(fn) && !toleratesAbsence(n)) {
          const consts = constsAt(n);
          if (derivesFromTemporaryFixture(n.arguments[0], constsAt, localFns)) {
            ts.forEachChild(n, visit);
            return;
          }
          const literals = literalsOf(n.arguments[0], consts);
          const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          for (const path of candidatePathsFor(literals)) {
            sites.push({ file: rel, line, fn, path });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  const candidates = [...new Set(sites.map((s) => s.path))];
  const verdicts = new Map<string, boolean | 'unknown'>();
  const undecidable: UndecidablePath[] = [];
  for (const c of candidates) {
    const v = opts.isIgnored(c);
    verdicts.set(c, v);
    if (v === 'unknown') undecidable.push({ path: c, reason: 'git check-ignore could not decide' });
  }

  const isCovered = (p: string) =>
    opts.coveredRoots.some((r) => p === r || p.startsWith(r.replace(/\/+$/, '') + '/'));

  // One requirement can yield several nested candidates (`.../dist` and
  // `.../dist/index.js` both come from one resolve()). Report only the most
  // specific path per site: listing both says nothing extra and makes the
  // failure read like two problems, which is how a guard's output starts being
  // skimmed instead of read.
  const required = dropNestedDuplicates(sites.filter((s) => verdicts.get(s.path) === true));
  return {
    required,
    covered: required.filter((s) => isCovered(s.path)),
    violations: required.filter((s) => !isCovered(s.path)),
    undecidable,
    stats: {
      testFilesScanned: opts.testFiles.length,
      parsed,
      sites: sites.length,
      candidates: candidates.length,
    },
  };
}
