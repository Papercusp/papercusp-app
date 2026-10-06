/**
 * Equivalence pairs — the CODE-SEARCH family (WI-6445; retargeted by P-002 of
 * gitnexus-deterministic-integration-2026-10-05, D-010).
 *
 * Population: the same 7d corpus every sibling pair cites held 6,115 RECURSIVE
 * grep atoms across 82 sessions. That whole population is emphatically NOT
 * claimed here — `grep -r` returns an EXHAUSTIVE, EXACT, DETERMINISTIC set of
 * text matches, and no code-intelligence tool is a substitute for that. This
 * file claims exactly ONE shape, the one where the questions genuinely coincide:
 * LOCATION-ONLY DEFINITION LOOKUP — "where is symbol X declared", asked of one
 * directory or file inside ONE TypeScript project.
 *
 * ── Why the tool is `lsp:query`, not `gitnexus.context` (D-010) ──────────────
 * Code-intelligence D-001 [owner 2026-08-21] routes definition/references
 * to the `lsp` facade and only call chains, impact and topology to GitNexus.
 * This pair used to route to `gitnexus.context`, which contradicted that ruling
 * and the hand-written storage-policy row beside it. Measured before the
 * retarget (WI-10006282): 138 advisory fires in 7 days across 42 sessions, and
 * ONE complied. `lsp:query { op: "workspace_symbols", name, file }` answers the
 * question from the compiler: every declaration site of the name, with its kind
 * and one-indexed line, for the tsconfig project that `file` names.
 *
 * ── What is deliberately NOT claimed, and why each one ───────────────────────
 *  - BODY READS (`-A`/`-B`/`-C`, `--context`). `workspace_symbols` returns
 *    locations, not bodies. The faithful form is two steps — `lsp:query` then
 *    `capability:read { offset, limit }` — and a pair maps onto ONE tool call,
 *    so this sub-population (520 of 837 fired atoms) stays bash in the generated
 *    table. The advisory still names the two-step route.
 *  - MORE THAN ONE SEARCH ROOT. A symbol search covers ONE project, so a grep
 *    over two trees has no single faithful call.
 *  - A ROOT THAT IS NOT INSIDE A KNOWN TYPESCRIPT PROJECT, or that CONTAINS a
 *    nested one. `lsp:query` resolves a directory anchor to the nearest
 *    tsconfig.json at-or-above it and REFUSES a directory spanning nested
 *    projects (`resolveDirectoryAnchor`), because answering for the outer
 *    project would read as absence for symbols in the inner ones. `cover()`
 *    must stay pure, so it decides this from {@link TS_PROJECT_ROOTS} — the
 *    tracked tsconfig.json set, pinned against the tree by a test — instead of
 *    walking the filesystem. A root outside every listed project is simply not
 *    claimed; nothing is guessed.
 *  - NON-TYPESCRIPT `--include` filters. tsserver indexes TS sources only.
 *  - `type` / `const` / `enum` declarations. The compiler does model them, but
 *    the certification corpus for this retarget is the advisory's own FIRES,
 *    which only ever contain `function` / `class` / `interface` shapes. Adding a
 *    keyword without a sample that contains it would certify nothing.
 *
 * ── A residue stated plainly rather than buried ──────────────────────────────
 * A grep with no `--include` also reads `.js`/`.mjs`/`.md` files under the root,
 * and tsserver does not index those, nor files a tsconfig excludes. For a
 * DEFINITION question in a TypeScript project that is judged acceptable: a
 * definition in a doc is a mention, not a declaration. A symbol defined only in
 * an excluded file is the case where grep still wins, and the advisory says so.
 *
 * ── The envelope-faithful, data-empty failure class ──────────────────────────
 * When this pair first shipped (pointing at gitnexus) the graph had NEVER
 * indexed this repo; every call it recommended would have hit an empty index,
 * and the harness still derived `equivalent`. `cover()` models a tool's ARGUMENT
 * ENVELOPE; it cannot prove the tool ANSWERS. That finding is retained as
 * {@link GITNEXUS_INDEX_FINDING} because the reindex routine and its tests cite
 * it. The LSP facade fails closed instead: an unanchored or unresolvable
 * symbol search refuses rather than returning an empty that reads as absence.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * The backing-index liveness finding for the code graph, recorded as DATA. It
 * no longer describes this pair's tool (D-010 moved definition lookups to LSP),
 * but it is the provenance of `system:gitnexus-reindex` and stays here so the
 * envelope-faithful/data-empty lesson keeps its evidence.
 */
export const GITNEXUS_INDEX_FINDING = {
  /** Before: `list_repos` returned exactly one, unrelated, checkout. */
  indexedBefore: false,
  probeBefore: "gitnexus.context { name: 'managedSetInterval' } → \"Symbol 'managedSetInterval' not found\"",
  /** After: `npx gitnexus analyze . --skip-agents-md --name papercusp`, 309.2s. */
  indexedAt: '2026-07-27',
  indexStats: { nodes: 234_905, edges: 373_483, clusters: 6067, flows: 300 },
  probeAfter:
    "gitnexus.context { name: 'managedSetInterval', kind: 'Function', repo: 'papercusp' } → found at " +
    'libs/generic/scheduled-registry/src/index.ts:221-262 with 24 incoming callers; ' +
    "{ name: 'BashSubstitutionPair', kind: 'Interface' } → found at " +
    'packages/operator-core/lib/bash-substitution/types.ts:72-157. Both claimed kinds verified.',
  refreshStep: 'npx gitnexus analyze . --skip-agents-md --name papercusp',
  /**
   * ⚠ `--skip-agents-md` is REQUIRED, not cosmetic: the default rewrites a
   * gitnexus section into CLAUDE.md and AGENTS.md, which in this repo are prompt
   * SOURCES spliced into every agent's context — and CLAUDE.md additionally holds
   * the generated routing table this very registry owns.
   */
  refreshOwner: 'system:gitnexus-reindex — durable hourly routine, cron 0 35 * * * *',
  note:
    'The index is a LOCAL artifact under <repo>/.gitnexus (gitignored). The durable system:gitnexus-reindex ' +
    'routine now owns refreshes; WI-6457 verified repeated scheduled analyze completions and healthy graph ' +
    'canaries on 2026-09-03/04, then re-probed managedSetInterval through gitnexus.context. commitsBehind can ' +
    'still rise between gated hourly runs, but the former unowned-decay blocker is closed.',
} as const;

/** `libs/generic/<pkg>` packages that carry their own tsconfig.json. */
const LIBS_GENERIC_PROJECTS = [
  'activity-bridge', 'agent-roster', 'artifact-registry', 'bench-metrics', 'cache', 'card-stack', 'chat-cards',
  'chat-protocol', 'control-mutation', 'debounce-coalesce', 'decision-model', 'dependency-order',
  'deployment-driver', 'desktop-ipc', 'dock-workbench', 'embedded-pg-discovery', 'eval-battery', 'event-reaction',
  'facets', 'failure-detector', 'fanout-resolver', 'gui-readiness', 'hash-chain', 'image-blankness',
  'ipc-endpoint-server', 'ipc-framing', 'kokoro-tts', 'lexicon', 'linkable-edges', 'locks-core', 'memory',
  'merkle-log', 'model-pricing', 'module-singleton', 'overlap-clusters', 'papergrid/bloom-grid', 'papergrid/grid',
  'papergrid/grid-core', 'papergrid/kv-persist', 'papergrid/kv-persist-indexeddb', 'plan-parser', 'plugin-loader',
  'projection-index', 'prospect-contract', 'pubsub-substrate', 'ranked-selection', 'rate-limit', 'release-profile',
  'rerank', 'resource-profile', 'result-encoding', 'resumable-download', 'rrf', 'rules', 'scheduled-registry',
  'search', 'search-core', 'seed-bundle', 'sequence-patterns', 'sse', 'step-program', 'structured-concurrency',
  'sync', 'tauri-release-kit', 'tauri-verify', 'template-kit', 'tooldef', 'tooldef-http', 'ui-primitives',
  'verification-harness',
].map((pkg) => `libs/generic/${pkg}`);

/**
 * Every directory in this repo that holds a tracked `tsconfig.json` — the units
 * a TypeScript symbol search can cover. Derived from
 * `git ls-files --recurse-submodules -- '*tsconfig.json'` (exact name; `_retired`
 * and generated `env-sidecars` copies excluded), and pinned by
 * `code-search.test.ts`, which fails if any entry stops holding a tsconfig.json.
 *
 * Anchoring on these is also what keeps the OTHER checkouts on this box out: an
 * `oddsmith` tree shares the first path segment (`packages/oms`,
 * `packages/treasury`, `apps/desktop`), so a one-segment anchor would claim
 * commands about a different repository. Every entry here is at least two
 * segments deep and names a project that exists in THIS tree.
 *
 * Completeness is NOT required: a project added later and missing here is only
 * a grep this pair does not claim — the conservative direction.
 */
export const TS_PROJECT_ROOTS: readonly string[] = [
  'apps/operator', 'apps/operator-docs', 'apps/operator-public', 'apps/operator-vite', 'apps/papercusp-docs',
  'apps/papercusp-publish', 'apps/the-swarm-site',
  'libs/agent-chat', 'libs/flags', 'libs/host-platform', 'libs/marketplace-public-ui', 'libs/papercusp-db',
  'libs/papercusp-publish-auth', 'libs/papercusp-shared', 'libs/test-config', 'libs/testing-shell',
  'libs/papercusp/libs/db', 'libs/papercusp/packages/blueprint-distribution', 'libs/papercusp/packages/cli',
  'libs/papercusp/packages/file-claim', 'libs/papercusp/packages/harness',
  'libs/papercusp/packages/harness/docs-viewer', 'libs/papercusp/packages/locks',
  'libs/papercusp/packages/orchestrator', 'libs/papercusp/plugins/gitnexus-bridge',
  'packages/agent-mcp', 'packages/backup', 'packages/coordination', 'packages/docs-engine', 'packages/omp-plugin',
  'packages/operator-core', 'packages/operator-ui', 'packages/tooldef-mcp',
  ...LIBS_GENERIC_PROJECTS,
];

/**
 * Roots inside a project that also CONTAIN another project — the directories
 * `resolveDirectoryAnchor` refuses. Derived from {@link TS_PROJECT_ROOTS}: every
 * ancestor of a nested project, from its enclosing project down.
 */
export const NESTED_PROJECT_CONTAINERS: readonly string[] = (() => {
  const out = new Set<string>();
  for (const inner of TS_PROJECT_ROOTS) {
    for (const outer of TS_PROJECT_ROOTS) {
      if (inner === outer || !inner.startsWith(`${outer}/`)) continue;
      const segments = inner.slice(outer.length + 1).split('/');
      for (let i = 0; i < segments.length; i += 1) {
        out.add([outer, ...segments.slice(0, i)].join('/'));
      }
    }
  }
  return [...out].sort();
})();

function escapeRe(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest first, so an alternation never stops at a shorter sibling prefix. */
const byLengthDesc = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).map(escapeRe);

/** A search operand inside one listed project: the project itself, or any path below it. */
const PROJECT_OPERAND = `(?:${byLengthDesc(TS_PROJECT_ROOTS).join('|')})(?:/\\S*)?`;

/** At least one search operand lies inside a known TypeScript project. */
const REQUIRE_PROJECT_ROOT = `(?=[^\\n]*(?:^|\\s)${PROJECT_OPERAND}(?=\\s|$))`;

/** A root that spans a nested project is refused by the tool, so it is not claimed. */
const EXCLUDE_CONTAINER_ROOT = `(?![^\\n]*(?:^|\\s)(?:${byLengthDesc(NESTED_PROJECT_CONTAINERS).join('|')})/?(?=\\s|$))`;

/**
 * The declaration keywords claimed. See the header for why `type`/`const`/`enum`
 * are absent — they are a sampling limit, not a tool limit.
 */
const DECL_KEYWORD = '(?:function|class|interface)';

/**
 * A quoted grep pattern that names a DECLARATION and an identifier. The quotes
 * are required: an unquoted `grep -rn export function foo` would make `function`
 * the pattern and `foo` a path, which is a different command.
 */
const DEFINITION_PATTERN =
  `(?:"\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?${DECL_KEYWORD}\\s+[A-Za-z_$][\\w$]*"` +
  `|'\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?${DECL_KEYWORD}\\s+[A-Za-z_$][\\w$]*')`;

/**
 * Atoms this family must never claim, excluded by PATTERN per D-008.
 *
 * A shell expansion (`$f`, `$(grep …)`) is genuinely undecidable — the corpus
 * contains `grep -rn -A 35 "interface PresenceRecord" $(grep -rln …`, where the
 * search root is the output of another command. An stdout redirect means the
 * command's literal effect includes a FILE the tool does not produce. `2>&1` /
 * `2>/dev/null` is NOT a redirect for this purpose — it is stderr plumbing.
 */
const EXCLUDE_UNEXPRESSIBLE = String.raw`(?![^\n]*[$\`])(?![^\n]*(?:^|\s)1?>)`;

/** `node_modules` is vendored and gitignored — no project indexes it as source. */
const EXCLUDE_VENDORED = String.raw`(?![^\n]*node_modules)`;

/**
 * D-010(b): a context request reads the BODY, which `workspace_symbols` does not
 * return. Any short cluster carrying A/B/C (`-A 30`, `-rnA5`, `-C3`) or a long
 * `--context` form takes the atom out of this pair entirely.
 */
const EXCLUDE_CONTEXT = String.raw`(?![^\n]*\s(?:-[A-Za-z]*[ABC]|--(?:after-|before-)?context))`;

/**
 * Any OTHER flag `cover()` cannot express is also excluded by pattern (D-008:
 * narrow until the residue falls outside). A short cluster carrying a letter
 * outside {@link EXPRESSIBLE_FLAGS} (`-c` counts, `-i` folds case, `-e` moves
 * the pattern), or a long flag other than `--include`. Measured on the fires
 * corpus this removed the `-rnc` count atom that was the pair's residue.
 */
const EXCLUDE_UNEXPRESSIBLE_FLAG =
  String.raw`(?![^\n]*\s(?:-[A-Za-z]*(?![rRlnwIhsE])[A-Za-z]|--(?!include(?:=|\s))[a-z]))`;

/** `--include` must name TypeScript sources only (`*.ts`, `"*.tsx"`, `*.{ts,tsx}`). */
const TS_EXT_ALT = '(?:ts|tsx|mts|cts)';
const TS_GLOB = `\\*\\.(?:${TS_EXT_ALT}|\\{${TS_EXT_ALT}(?:,${TS_EXT_ALT})*\\})`;
const EXCLUDE_NON_TS_INCLUDE = `(?![^\\n]*\\s--include(?:=|\\s+)(?!["']?${TS_GLOB}["']?(?:\\s|$))\\S)`;

/**
 * A FILE root must be a TypeScript source: `lsp:query` opens it as a document in
 * the TypeScript server, and a `.mjs` / `.json` / `.md` root is not one. Any
 * unquoted, non-flag operand ending in a non-TS extension takes the atom out.
 */
const EXCLUDE_NON_TS_FILE_ROOT = `(?![^\\n]*\\s(?!-)[^\\s"']*\\.(?!${TS_EXT_ALT}(?:\\s|$))[A-Za-z0-9]+(?=\\s|$))`;

/**
 * A second search root has no single faithful call. A path operand is any token
 * after the quoted pattern that is not a flag, stderr plumbing or backgrounding;
 * two of them take the atom out. (The pattern operand itself is quoted and comes
 * first, so it never counts; `--include <glob>` is consumed as one flag.)
 */
const SKIPPABLE_TOKEN = String.raw`(?:--include\s+\S+|-\S+|2>\S*|&)`;
const PATH_TOKEN = String.raw`(?!-|2>|&)\S+`;
const EXCLUDE_SECOND_ROOT =
  `(?![^\\n]*${DEFINITION_PATTERN}(?:\\s+${SKIPPABLE_TOKEN})*\\s+${PATH_TOKEN}` +
  `(?:\\s+${SKIPPABLE_TOKEN})*\\s+${PATH_TOKEN})`;

/** Stderr plumbing and backgrounding — neither changes the request. */
const TRAILING_NOISE = String.raw`(?:\s+2>(?:&1|\s*/dev/null))?(?:\s*&)?\s*`;

/** Source extensions the TypeScript server indexes. */
const TS_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts']);

interface ParsedGrepCommand {
  /** The quoted search pattern, unquoted; null when none was found. */
  pattern: string | null;
  /** The declaration keyword inside `pattern`. */
  declKeyword: string | null;
  /** The identifier being looked up. */
  symbol: string | null;
  /** Non-flag operands after the pattern — the search roots. */
  paths: string[];
  /** Every flag, normalised to its bare name. */
  flags: string[];
  /** `--include` globs. */
  includes: string[];
  /** An after-context request (`-A n`). */
  afterContext: number | null;
  /** Any context request at all (`-A`/`-B`/`-C`/`--context`): a body read. */
  readsBody: boolean;
  /** Recursive (`-r`/`-R`, in any cluster). */
  recursive: boolean;
  /** An stdout redirect is present. */
  writes: boolean;
  /** An operand contains a shell expansion. */
  dynamic: boolean;
}

function tokenize(atom: string): string[] {
  return atom.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function unquote(token: string): string {
  if (token.length >= 2 && (token[0] === '"' || token[0] === "'") && token[token.length - 1] === token[0]) {
    return token.slice(1, -1);
  }
  return token;
}

/** Flags that consume the NEXT token as their argument. */
const ARG_FLAGS = new Set(['-A', '-B', '-C', '-e', '-m', '-f', '--include', '--exclude', '--exclude-dir']);

/** Long context flags, which always read the body. */
const LONG_CONTEXT_FLAGS = new Set(['--context', '--after-context', '--before-context']);

/** A quoted definition pattern, re-parsed to recover its parts. */
const DEFINITION_RE = new RegExp(
  `^\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(${DECL_KEYWORD})\\s+([A-Za-z_$][\\w$]*)$`,
);

/** `grep [flags] <pattern> [paths…]`, with flags and pattern in any order. */
export function parseGrepAtom(atom: string): ParsedGrepCommand {
  const out: ParsedGrepCommand = {
    pattern: null, declKeyword: null, symbol: null, paths: [], flags: [], includes: [],
    afterContext: null, readsBody: false, recursive: false, writes: false, dynamic: false,
  };
  const tokens = tokenize(atom);
  const start = tokens.findIndex((t) => t === 'grep');
  if (start === -1) return out;

  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i];

    // Stderr plumbing and backgrounding are noise; a stdout redirect is a real artifact.
    if (/^2>/.test(token)) {
      if (token === '2>') i += 1;
      continue;
    }
    if (token === '&') continue;
    const redirect = /^(\d*)(?:>>|>)/.exec(token);
    if (redirect) {
      if (redirect[1] === '' || redirect[1] === '1') out.writes = true;
      if (/^\d*(?:>>|>)$/.test(token)) i += 1;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const [bare, inlineValue] = token.includes('=')
        ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
        : [token, null];

      if (bare === '--include') {
        out.flags.push('--include');
        out.includes.push(unquote(inlineValue ?? tokens[++i] ?? ''));
        continue;
      }
      if (LONG_CONTEXT_FLAGS.has(bare)) {
        out.flags.push(bare);
        out.readsBody = true;
        if (inlineValue === null) i += 1;
        continue;
      }
      if (ARG_FLAGS.has(bare)) {
        out.flags.push(bare);
        const value = inlineValue ?? tokens[i + 1] ?? '';
        if (inlineValue === null) i += 1;
        if (bare === '-A') out.afterContext = Number.parseInt(value, 10);
        if (bare === '-A' || bare === '-B' || bare === '-C') out.readsBody = true;
        continue;
      }

      // A short cluster like `-rln`, or `-A30` / `-rnC3` with the count attached.
      const attached = /^-([A-Za-z]+)(\d+)$/.exec(bare);
      if (attached) {
        for (const ch of attached[1]) out.flags.push(`-${ch}`);
        if (attached[1].includes('A')) out.afterContext = Number.parseInt(attached[2], 10);
        if (/[ABC]/.test(attached[1])) out.readsBody = true;
        if (/[rR]/.test(attached[1])) out.recursive = true;
        continue;
      }
      if (!bare.startsWith('--')) {
        for (const ch of bare.slice(1)) out.flags.push(`-${ch}`);
        if (/[rR]/.test(bare)) out.recursive = true;
        // A cluster ENDING in A/B/C takes the next token as its count (`-rnA 5`).
        if (/[ABC]$/.test(bare)) {
          out.readsBody = true;
          if (bare.endsWith('A')) out.afterContext = Number.parseInt(tokens[i + 1] ?? '', 10);
          i += 1;
        } else if (/[ABC]/.test(bare)) {
          out.readsBody = true;
        }
        continue;
      }
      out.flags.push(bare);
      continue;
    }

    const operand = unquote(token);
    if (/[$`]/.test(operand)) out.dynamic = true;

    // The first quoted operand matching the definition shape is the PATTERN;
    // everything after it is a search path.
    if (out.pattern === null) {
      const match = DEFINITION_RE.exec(operand);
      if (match) {
        out.pattern = operand;
        out.declKeyword = match[1];
        out.symbol = match[2];
        continue;
      }
      // A non-definition first operand is still the pattern for grep's purposes.
      if (token !== unquote(token) || !/^[-/.\w*]/.test(operand)) {
        out.pattern = operand;
        continue;
      }
    }
    out.paths.push(operand);
  }

  return out;
}

/**
 * Turn a grep root into the `file` anchor `lsp:query` takes: drop a trailing
 * slash, and cut a glob segment back to the directory before it
 * (`packages/x/src/*.ts` → `packages/x/src`). Without `globstar`, `**` is just
 * `*`, so the same cut is faithful for it.
 */
export function anchorForRoot(root: string): string {
  const segments = root.replace(/\/+$/, '').split('/');
  const firstGlob = segments.findIndex((s) => /[*?[{]/.test(s));
  return (firstGlob === -1 ? segments : segments.slice(0, firstGlob)).join('/');
}

/** The project a repo-relative anchor lies in, or null when no listed project contains it. */
export function projectForAnchor(anchor: string): string | null {
  let best: string | null = null;
  for (const project of TS_PROJECT_ROOTS) {
    if ((anchor === project || anchor.startsWith(`${project}/`)) && (best === null || project.length > best.length)) {
      best = project;
    }
  }
  return best;
}

/** `--include` globs as extension lists: `*.ts` → [ts], `*.{ts,tsx}` → [ts, tsx]. */
function includeExtensions(glob: string): string[] | null {
  const brace = /\.\{([A-Za-z0-9,]+)\}$/.exec(glob);
  if (brace) return brace[1].split(',');
  const ext = /\.([A-Za-z0-9]+)$/.exec(glob)?.[1];
  return ext === undefined ? null : [ext];
}

/** Render the tool call a covered command maps onto. */
function expressionFor(symbol: string, anchor: string): string {
  return `lsp:query { op: "workspace_symbols", name: "${symbol}", file: "${anchor}" }`;
}

/**
 * Flags whose request `workspace_symbols` genuinely serves.
 *
 * `-l`/`-n` ask WHERE the definition is, which is exactly what the tool returns
 * (file and one-indexed line); `-r`/`-R` is the recursion this pattern requires;
 * `-w` asks for a whole-word match, and the tool matches a symbol NAME, which is
 * strictly that; `-I`/`-h`/`-s` are output/binary plumbing that does not change
 * the question; `--include` is a source-type filter checked separately.
 * Context flags are NOT here: D-010(b) excludes body reads by pattern.
 *
 * `-E` is covered because it cannot change the question for THIS pattern
 * shape: a pattern only reaches `cover()` after {@link DEFINITION_RE} accepts it,
 * so its text is identifier characters, spaces, and at most a leading `^` — and
 * `^`/`$` anchor identically in basic and extended syntax. (Measured: 3 of the
 * 286 fired atoms carried `-E`.) `-F` is NOT covered: it makes a leading `^`
 * literal, which does change the match.
 */
const EXPRESSIBLE_FLAGS = new Set(['-r', '-R', '-l', '-n', '-w', '-I', '-h', '-s', '-E', '--include']);

/** Everything `lsp:query workspace_symbols` can and cannot express about a parsed grep. */
export function coverDefinitionLookup(parsed: ParsedGrepCommand): CoverageResult {
  if (parsed.writes) {
    return { covered: false, reason: 'redirects the match output to a file; lsp:query returns a structured result and writes no artifact' };
  }
  if (parsed.dynamic) {
    return { covered: false, reason: 'a search operand is a shell expansion, so the searched tree is not decidable from the atom' };
  }
  if (!parsed.recursive) {
    return { covered: false, reason: 'not a recursive search: the command greps named files, not a tree' };
  }
  if (parsed.symbol === null || parsed.declKeyword === null) {
    return { covered: false, reason: 'the search pattern does not name a declaration keyword and an identifier, so it is not a definition lookup' };
  }
  if (parsed.readsBody) {
    return {
      covered: false,
      reason:
        'asks for context lines (-A/-B/-C), i.e. reads the BODY; workspace_symbols returns locations only, so the ' +
        'faithful form is two calls (lsp:query, then capability:read { offset, limit }), not one (D-010b)',
    };
  }

  const unexpressible = parsed.flags.find((f) => !EXPRESSIBLE_FLAGS.has(f));
  if (unexpressible) {
    return { covered: false, reason: `passes \`${unexpressible}\`, which lsp:query workspace_symbols has no argument for` };
  }

  for (const glob of parsed.includes) {
    const exts = includeExtensions(glob);
    if (exts === null || exts.some((ext) => !TS_EXTENSIONS.has(ext))) {
      return {
        covered: false,
        reason: `--include=${glob} reaches files the TypeScript server does not index (it indexes .ts/.tsx/.mts/.cts sources only)`,
      };
    }
  }

  if (parsed.paths.length === 0) {
    return {
      covered: false,
      reason: "no search path: grep walks the shell's cwd, which the atom no longer carries after `cd` was split off",
    };
  }
  if (parsed.paths.length > 1) {
    return {
      covered: false,
      reason: `searches ${parsed.paths.length} roots; a symbol search covers ONE tsconfig project, so there is no single faithful call`,
    };
  }

  const anchor = anchorForRoot(parsed.paths[0]);
  const fileExt = /\.([A-Za-z0-9]+)$/.exec(anchor.split('/').pop() ?? '')?.[1];
  if (fileExt !== undefined && !TS_EXTENSIONS.has(fileExt)) {
    return {
      covered: false,
      reason: `search root "${anchor}" is a .${fileExt} file, which the TypeScript server cannot open as a project document`,
    };
  }
  if (projectForAnchor(anchor) === null) {
    return {
      covered: false,
      reason:
        `search root "${parsed.paths[0]}" is not inside a known TypeScript project of this repo (a cwd-relative or ` +
        'absolute path, a directory above every project, or another checkout on this box such as oddsmith)',
    };
  }
  if (NESTED_PROJECT_CONTAINERS.includes(anchor)) {
    return {
      covered: false,
      reason: `search root "${anchor}" contains a nested tsconfig project, which lsp:query refuses as an anchor (one project per search)`,
    };
  }

  return { covered: true, expression: expressionFor(parsed.symbol, anchor) };
}

/**
 * P-002 / D-010 — `grep -r "<decl> <Ident>" <one root inside one TS project>`,
 * with no context flags: the one shape where a recursive grep and the compiler's
 * symbol index answer the SAME question. Certified on a fresh sample of the
 * advisory's own fires (see the fixture's `evidenceRef`).
 */
export const lspDefinitionLookup: BashSubstitutionPair = {
  id: 'code-search.definition-lookup',
  intentLabel: 'find-where-a-symbol-is-defined',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}${EXCLUDE_VENDORED}${EXCLUDE_CONTEXT}${EXCLUDE_UNEXPRESSIBLE_FLAG}` +
      `${EXCLUDE_NON_TS_INCLUDE}${EXCLUDE_NON_TS_FILE_ROOT}${EXCLUDE_SECOND_ROOT}` +
      `${EXCLUDE_CONTAINER_ROOT}${REQUIRE_PROJECT_ROOT}` +
      `(?=[^\\n]*\\s${DEFINITION_PATTERN})` +
      `grep(?:\\s+-[A-Za-z]*[rR][A-Za-z]*)` +
      `[^\\n]*${TRAILING_NOISE}$`,
  ),
  toolName: 'lsp:query',
  advisoryText:
    'lsp:query { op: "workspace_symbols", name, file } answers "where is this defined" from the TypeScript compiler: ' +
    'every declaration site of the name with its kind and one-indexed line1, for the ONE tsconfig project that `file` ' +
    '(a file or a directory inside that project, e.g. the grep root) names. A directory spanning several projects ' +
    '(libs/generic) is refused, so anchor the package you mean. To read the body, follow with capability:read ' +
    '{ file_path, offset: line1, limit }. Searches across several projects, symbols in files a tsconfig excludes, ' +
    'and exact-text matching remain grep\'s job.',
  // Kept within a few bytes of the row it replaced: this table is spliced into
  // launch-prose surfaces that sit at their ceilings (lint:launch-prose-budget).
  routing: {
    want: 'to find where a symbol is DEFINED',
    use: '`lsp:query { op: "workspace_symbols", name: "X", file: "<grep root>" }`; body: `capability:read`',
    insteadOf:
      '`grep -rn "export function X" <one project dir>` (repo-wide: add `--exclude-dir={node_modules,.vitest-tmp,dist,coverage} --exclude-dir=sidecar` — generated bundles/caches are not source evidence; exhaustive exact-text search remains grep\'s job)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverDefinitionLookup(parseGrepAtom(atom));
  },
};

// ── P-002(d) / D-010(d): who CALLS this symbol ───────────────────────────────
//
// Population (30 days to 2026-10-06T08:00Z, harness_shared.session_turn_parts):
// 462 recursive greps whose quoted pattern is `IDENT(` across 131 sessions, 363
// distinct identifiers (fixtures/code-search.callers-lookup.sample.json carries
// totalAtoms/totalSessions; D-017). graph:query { op:'callers', name } is the
// routed tool.
//
// This pair is RECORDED `needs-widening`, not certified, because measurement
// says the tool cannot answer a large share of these questions in one call:
//  - graph:query takes a name and an optional kind, but no file or uid. When a
//    test file redeclares the name (a stub `getWorkItem`, a helper
//    `managedSetInterval`), the facade refuses the whole question as ambiguous.
//    grep never needs to disambiguate: it returns every textual call.
//  - Some callers come back as FILE-level edges with no line. A caller grep asks
//    for lines.
//  - A symbol written after the last index run is reported as not found.
// `cover()` therefore checks the envelope first, then looks the identifier up in
// {@link CALLERS_GRAPH_OUTCOMES}: the graph's own answer for each identifier in
// the frozen sample, measured on a named date and indexed commit. That table is
// evidence, not a model; re-measure it whenever the fixture or the backend
// changes (P-017 may replace the backend).
//
// What a resolved answer means: grep's matches include the definition line,
// substrings (`fooBar(` matches `myfooBar(`), comments and same-named methods on
// unrelated types. None of those are callers, so the graph answering with fewer
// lines is the faithful answer to "who calls X", not a loss. A grep restricted to
// one root, an --include or an --exclude-dir asks about a subset of the repo; the
// graph answers repo-wide with a path on every site, so the subset is a filter
// over the answer, not a different question.

/** A quoted `IDENT(` pattern, optionally word-bounded or with an escaped paren. */
const CALLER_PATTERN =
  String.raw`(?:"(?:\\b|\\<)?[A-Za-z_][\w$]*\\?\("|'(?:\\b|\\<)?[A-Za-z_][\w$]*\\?\(')`;

/** Recover the identifier and whether the paren was escaped. */
const CALLER_RE = /^(?:\\b|\\<)?([A-Za-z_][\w$]*)(\\?)\($/;

/** The identifier a caller-shaped grep asks about, or null. */
export function callerIdentOf(atom: string): string | null {
  const parsed = parseGrepAtom(atom);
  return parsed.pattern === null ? null : (CALLER_RE.exec(parsed.pattern)?.[1] ?? null);
}

/**
 * What the graph answered for each identifier in the frozen callers sample,
 * from `graph:query { op: 'callers', name, limit: 500 }`.
 *  - `resolved`: at least one call site with a line.
 *  - `ambiguous`: refused; more than one symbol carries the name.
 *  - `file-only`: every caller edge was file-level, with no line.
 *  - `not-found`: no symbol of that name at the indexed commit.
 *  - `missed`: an empty answer with no error while the tree has call sites
 *    (checked by grep). The worst class: it reads as "no callers".
 */
export type CallersGraphOutcome = 'resolved' | 'ambiguous' | 'file-only' | 'not-found' | 'missed';

export const CALLERS_GRAPH_MEASUREMENT = {
  measuredAt: '2026-10-06T08:08:32Z',
  indexedCommit: '4cd6d81cd66231fe8a5c3ae7a4f134a098429b23',
  indexedAt: '2026-10-06T06:05:11Z',
  tool: "graph:query { op: 'callers', name, limit: 500 } through the operator facade",
  tally: { resolved: 23, ambiguous: 10, 'file-only': 4, 'not-found': 2, missed: 1 },
} as const;

export const CALLERS_GRAPH_OUTCOMES: Readonly<Record<string, CallersGraphOutcome>> = {
  DBOSUnexpectedStepError: 'not-found',
  acknowledgeControlTransition: 'file-only',
  amendRubric: 'resolved',
  applyShippedDocVectorSeed: 'file-only',
  attributionMapForRepo: 'resolved',
  buildCarryBrief: 'ambiguous',
  bulkDedupInFlight: 'resolved',
  claimAdvSessionResume: 'resolved',
  compileLaunchSpecificationArtifact: 'ambiguous',
  createHostedDesktopBackend: 'resolved',
  createOrgTestDb: 'ambiguous',
  deriveSessionState: 'resolved',
  drainQueuedEpochContent: 'resolved',
  ensureHeapSampling: 'resolved',
  estimatePrice: 'ambiguous',
  fetch: 'ambiguous',
  gcVerifyInstances: 'file-only',
  gitSidecarEnabled: 'ambiguous',
  hostedAwsHostStackFragment: 'resolved',
  intakeConfidenceRefusal: 'resolved',
  // Empty, no error; grep finds 10+ calls in harness/__tests__/join-shared-harness.test.ts
  // and join-default-boot-wiring.test.ts.
  joinSharedHarness: 'missed',
  listLiveSessionPresence: 'resolved',
  mapLiveLockHoldingsForRepo: 'resolved',
  openAppChannel: 'ambiguous',
  planWorkspaceHostRecovery: 'file-only',
  promotePlanItems: 'ambiguous',
  readCell: 'ambiguous',
  readSocialPost: 'resolved',
  recordEditAttribution: 'resolved',
  registerDesktopSession: 'resolved',
  requirePrincipal: 'resolved',
  resolveClassFireTarget: 'resolved',
  resolveWorkspaceHostInitializationOperationsForHost: 'resolved',
  runGoldSet: 'resolved',
  runWorkspaceHostDestroy: 'resolved',
  sendMessage: 'ambiguous',
  setKernelEnforcementResolver: 'resolved',
  splitMarkdown: 'resolved',
  supportsContext1m: 'not-found',
  validateScorecardCompleteness: 'resolved',
};

const CALLER_OUTCOME_REASON: Record<Exclude<CallersGraphOutcome, 'resolved'>, string> = {
  ambiguous:
    'graph:query refused the name as ambiguous: more than one symbol carries it (often a test-file stub), and the ' +
    'tool has no file or uid argument to choose one. grep answers without choosing.',
  'file-only':
    'graph:query returned only file-level caller edges with no line; a caller grep asks for the lines.',
  'not-found':
    'graph:query found no symbol of this name at the indexed commit (unknown, or written after the last index run).',
  missed:
    'graph:query returned an empty answer with no error while the tree has call sites; read as "no callers", it is wrong.',
};

/** Flags whose request a repo-wide callers answer serves (paths are filters over it). */
const CALLER_EXPRESSIBLE_FLAGS = new Set([
  '-r', '-R', '-l', '-n', '-w', '-I', '-h', '-s', '-E', '-F', '-P', '--include', '--exclude-dir', '--exclude',
]);

/** Code the graph indexes; an --include outside it asks about docs or data. */
const CODE_EXTENSIONS = new Set([...TS_EXTENSIONS, 'js', 'jsx', 'mjs', 'cjs']);

/** Inside this repo: within a listed project, or a multi-segment directory that contains one. */
function repoAnchored(anchor: string): boolean {
  if (projectForAnchor(anchor) !== null) return true;
  return anchor.includes('/') && TS_PROJECT_ROOTS.some((p) => p.startsWith(`${anchor}/`));
}

/** Everything `graph:query callers` can and cannot express about a caller-shaped grep. */
export function coverCallersLookup(atom: string): CoverageResult {
  const parsed = parseGrepAtom(atom);
  if (parsed.writes) return { covered: false, reason: 'redirects the match output to a file; graph:query writes no artifact' };
  if (parsed.dynamic) return { covered: false, reason: 'a search operand is a shell expansion, so the searched tree is not decidable from the atom' };
  if (!parsed.recursive) return { covered: false, reason: 'not a recursive search: the command greps named files, not a tree' };
  const shape = parsed.pattern === null ? null : CALLER_RE.exec(parsed.pattern);
  if (!shape) return { covered: false, reason: 'the pattern is not a bare `IDENT(` call shape' };
  const ident = shape[1]!;
  const escaped = shape[2] === '\\';
  const extended = parsed.flags.includes('-E') || parsed.flags.includes('-P');
  const fixed = parsed.flags.includes('-F');
  if (fixed ? escaped : escaped !== extended) {
    return {
      covered: false,
      reason: fixed
        ? 'with -F the backslash is literal, so the grep matches `IDENT\\(` text, not calls'
        : `grep rejects this pattern as an unmatched paren in ${extended ? 'extended' : 'basic'} syntax, so the command asks nothing`,
    };
  }
  if (parsed.readsBody) {
    return {
      covered: false,
      reason: 'asks for context lines (-A/-B/-C), i.e. reads the caller BODY; graph:query returns sites, so the faithful form is two calls',
    };
  }
  const unexpressible = parsed.flags.find((f) => !CALLER_EXPRESSIBLE_FLAGS.has(f));
  if (unexpressible) return { covered: false, reason: `passes \`${unexpressible}\`, which graph:query callers has no argument for` };
  for (const glob of parsed.includes) {
    const exts = includeExtensions(glob);
    if (exts === null || exts.some((ext) => !CODE_EXTENSIONS.has(ext))) {
      return { covered: false, reason: `--include=${glob} reaches files the code graph does not index as code` };
    }
  }
  if (parsed.paths.length === 0) {
    return { covered: false, reason: "no search path: grep walks the shell's cwd, which the atom no longer carries" };
  }
  const outside = parsed.paths.find((root) => !repoAnchored(anchorForRoot(root)));
  if (outside !== undefined) {
    return {
      covered: false,
      reason:
        `search root "${outside}" is not anchored inside this repo (a bare first segment such as packages/, a cwd-relative ` +
        'or absolute path, or another checkout on this box); the graph indexes this repo only',
    };
  }
  const outcome = CALLERS_GRAPH_OUTCOMES[ident];
  if (outcome === undefined) {
    return { covered: false, reason: `no graph answerability measurement for \`${ident}\`; re-measure CALLERS_GRAPH_OUTCOMES` };
  }
  if (outcome !== 'resolved') return { covered: false, reason: CALLER_OUTCOME_REASON[outcome] };
  return { covered: true, expression: `graph:query { op: "callers", name: "${ident}" }` };
}

/**
 * P-002(d) / D-010(d): `grep -r "IDENT(" <roots in this repo>` routed to
 * graph:query callers. Recorded `needs-widening` from the measured sample, so it
 * is not projected into the routing table and stays at observe (see header).
 */
export const graphCallersLookup: BashSubstitutionPair = {
  id: 'code-search.callers-lookup',
  intentLabel: 'find-who-calls-a-symbol',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}${EXCLUDE_VENDORED}` +
      `(?=[^\\n]*\\s-[A-Za-z]*[rR])(?=[^\\n]*\\s${CALLER_PATTERN}(?=\\s|$))` +
      `grep\\s[^\\n]*$`,
  ),
  toolName: 'graph:query',
  advisoryText:
    'graph:query { op: "callers", name } answers "who calls X" from the code graph: resolved call sites with path and ' +
    'one-indexed line1, repo-wide, excluding the definition, comments and same-named substrings. It refuses a name that ' +
    'more than one symbol carries (it has no file argument), can return file-level edges with no line, and an index ' +
    'behind HEAD reports a new symbol as missing. An empty answer is not proof of absence: confirm with a grep -rl over ' +
    'the whole tree before acting on "no callers".',
  routing: {
    want: 'who CALLS a symbol',
    use: '`graph:query { op: "callers", name: "X" }` (empty is not absence)',
    insteadOf: '`grep -rn "X(" <dirs>` — still required for ambiguous names and for proving absence',
  },
  expectedVerdict: 'needs-widening',
  holdAtObserve:
    'Measured needs-widening: graph:query cannot answer a share of sampled caller questions in one call (ambiguous ' +
    'names with no file/uid argument, file-level edges without a line, symbols missing from the index). Promote only ' +
    'after P-017 settles the graph backend, the facade gains a disambiguator and line resolution, and ' +
    'CALLERS_GRAPH_OUTCOMES is re-measured to all-resolved. Owned by WI-10006543 (D-018): caller routing is ' +
    'deferred, not delivered, until this hold is lifted.',
  cover: coverCallersLookup,
};

/** Every pair in the code-search family, in registry order. */
export const CODE_SEARCH_PAIRS: BashSubstitutionPair[] = [lspDefinitionLookup, graphCallersLookup];

/** Exported for the model-drift guard (D-015). */
export { EXPRESSIBLE_FLAGS, TS_EXTENSIONS };
