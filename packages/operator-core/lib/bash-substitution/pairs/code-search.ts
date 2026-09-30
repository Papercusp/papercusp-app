/**
 * Equivalence pairs — the CODE-SEARCH family (WI-6445).
 *
 * Owner-approved route [owner 2026-07-27] after the first fix — "rewrite
 * gitnexus's tool description to lead with agent intents" — proved UNAVAILABLE:
 * gitnexus is a dynamic-tool npm plugin whose descriptions ship from the
 * dependency, and the repo has no guidance-override mechanism. This registry is
 * the remaining seam that can speak to an agent at the moment it reaches for
 * `grep`.
 *
 * Population (measured over the same 7d corpus every sibling pair cites):
 * 214,400 atoms / 88 sessions total; 6,115 RECURSIVE grep atoms across 82
 * sessions. That whole population is emphatically NOT claimed here — see the
 * next section, which is the entire design of this file.
 *
 * ── Why this pair is narrow, and must stay narrow ────────────────────────────
 * `grep -r` and gitnexus answer DIFFERENT questions for most of that
 * population. grep returns an EXHAUSTIVE, EXACT, DETERMINISTIC set of
 * file/line text matches. `gitnexus.query` returns call chains RANKED by
 * "BM25 keyword + semantic vector search, ranked by Reciprocal Rank Fusion",
 * default limit 5 — its own description says it "Complements grep/IDE search".
 * A ranked top-N is not a substitute for an exhaustive match set, and a
 * `cover()` claiming otherwise would produce a false `equivalent`, unlock
 * enforcement, and then nudge agents toward a tool that cannot answer them —
 * precisely the failure `BashSubstitutionPair.cover`'s docblock warns about.
 *
 * So this file claims exactly ONE shape, the one where the questions genuinely
 * coincide: DEFINITION LOOKUP — "where is symbol X defined". The tool is
 * `gitnexus.context` (NOT `.query`): it takes `{ name, kind?, file_path?,
 * include_content? }`, returns the symbol's file location plus categorized
 * incoming/outgoing references, and DISAMBIGUATES same-named candidates by
 * returning them ranked for the caller to pick — rather than fusing a top-N and
 * hoping. For "where is this defined" that is faithful, and the reference graph
 * it adds is strictly more than grep could give.
 *
 * ── ⚠ THE FAILURE CLASS THIS PAIR ALMOST SHIPPED ─────────────────────────────
 * When this pair was written, gitnexus had NEVER INDEXED THIS REPO —
 * `list_repos` returned only an unrelated checkout, and `context` probes for
 * real papercusp symbols returned `Symbol not found`. Every call this advisory
 * recommends would have hit an empty index.
 *
 * That gap is INVISIBLE to this harness by construction, and the point
 * generalises well past this pair: `cover()` models the tool's ARGUMENT
 * ENVELOPE, and `gitnexus.context { name: "managedSetInterval" }` is a perfectly
 * well-formed call — it simply had no data behind it. The harness derives
 * `equivalent` and every test passes. Call it an ENVELOPE-FAITHFUL, DATA-EMPTY
 * substitution: the registry can prove a tool ACCEPTS the question and cannot
 * prove it ANSWERS it. Any future pair naming a tool with a backing store — an
 * index, a cache, a projection — needs a liveness probe that the equivalence
 * harness does not supply.
 *
 * The index has since been built and gained a durable refresh owner (see
 * {@link GITNEXUS_INDEX_FINDING}). WI-6457 observed repeated scheduled analyze
 * successes plus graph canaries, so the temporary `holdAtObserve` is retired.
 *
 * ── The kinds this claims, and the ones it deliberately does not ─────────────
 * Only `function` / `class` / `interface`. gitnexus's own `context` schema names
 * `'Function' | 'Class' | 'Method' | 'Interface' | 'Constructor'` as its symbol
 * kinds, so those three are certain to be modelled as graph nodes. `type`,
 * `const` and `enum` declarations are NOT confirmed to be indexed as symbols,
 * and a definition lookup for a symbol the graph does not model is exactly the
 * dead nudge this file exists to avoid. Costing: ~10 of the 115 measured
 * definition-shape atoms. They can be added the moment a real index confirms
 * they resolve — which is the same event that lifts the hold.
 */

import type { CoverageResult, BashSubstitutionPair } from '../types';

/**
 * The backing-index liveness finding, recorded as DATA rather than prose. The
 * initial build and its former ownership gap are retained alongside the durable
 * refresh owner that closed the gap, so a future regression test can distinguish
 * "indexed once" from "kept fresh by a verified scheduled producer."
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

/**
 * Second-level path prefixes that unambiguously name THIS repo.
 *
 * Anchoring is the same device `typecheck.ts` uses (`ROOT_DIRS`) and exists for
 * the same reason — `atomize` splits `cd <dir> && grep …`, so an atom no longer
 * carries the cwd that gave a relative path meaning. But here it must be TWO
 * segments deep, and that is not fussiness: this box also holds an `oddsmith`
 * checkout whose packages sit at the SAME first segment. The corpus is full of
 * `packages/oms`, `packages/treasury`, `packages/db`, `packages/engine`,
 * `packages/contracts` and `apps/desktop` — none of which exist here. gitnexus
 * indexes per-repo, so claiming those would claim commands this repo's index
 * can never answer. Generated from the real tree, not guessed.
 */
const REPO_ANCHORS = [
  'packages/(?:agent-mcp|backup|coordination|docs-engine|locks|omp-plugin|operator-core|plugin-loader|plugin-sdk|plugin-wit|tooldef-mcp)',
  'apps/(?:operator|operator-docs|operator-public|operator-vite|papercusp-docs|papercusp-publish|pui-companion-proto|pui-zellij-plugin|the-swarm-site|tui)',
  'libs/(?:agent-chat|flags|generic|holepunch-spike|host-platform|marketplace-public-ui|papercusp|papercusp-db|papercusp-publish-auth|papercusp-shared|test-config|testing-shell)',
  'papercusp-desktop',
];

/** At least one search operand must be anchored in this repo. */
const REQUIRE_REPO_ANCHOR = `(?=[^\\n]*(?:^|\\s)(?:${REPO_ANCHORS.join('|')})/)`;

/**
 * The declaration keywords claimed. See the header for why `type`/`const`/`enum`
 * are absent — they are a coverage sacrifice, not an oversight.
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
 * command's literal effect includes a FILE the tool does not produce (the same
 * sacrifice `tests.ts` and `typecheck.ts` make). `2>&1` / `2>/dev/null` is NOT a
 * redirect for this purpose — it is stderr plumbing present on a large share of
 * the family, and treating it as a write would empty the pattern.
 */
const EXCLUDE_UNEXPRESSIBLE = String.raw`(?![^\n]*[$\`])(?![^\n]*(?:^|\s)1?>)`;

/** `node_modules` is vendored and gitignored — the code graph never contains it. */
const EXCLUDE_VENDORED = String.raw`(?![^\n]*node_modules)`;

/**
 * A search operand that names a FIRST segment only — `.`, `packages`, `libs`,
 * `apps` — is excluded by pattern, even though a sibling operand in the same
 * command may be properly anchored.
 *
 * This is the D-008 narrowing, and it was earned rather than anticipated: the
 * first draft required only that SOME operand be anchored, and the harness
 * scored 22/24 (`needs-widening`) on exactly the two atoms that mix the two
 * kinds — `grep -rn "export interface AccountRateState" -A 22 packages
 * libs/papercusp/packages …` and `grep -rn "interface ResolvedItem"
 * libs/generic/ packages/ …`. Both search a bare `packages` tree, and this box
 * carries a second checkout (oddsmith) whose packages sit at that same first
 * segment, so which tree they mean died with the `cd` the atomizer split off.
 * Per D-008 the fix for a near-miss is to NARROW THE PATTERN until the residue
 * falls outside it — never to loosen `cover()` until the residue scores.
 *
 * `papercusp-desktop` is deliberately absent: it is a single segment, but no
 * other checkout on this box has that name, so it is not ambiguous.
 */
const EXCLUDE_UNANCHORED_ROOT = String.raw`(?![^\n]*(?:^|\s)(?:\.|packages|libs|apps)/?(?=\s|$))`;

/** Stderr plumbing and backgrounding — neither changes the request. */
const TRAILING_NOISE = String.raw`(?:\s+2>(?:&1|\s*/dev/null))?(?:\s*&)?\s*`;

/** File extensions gitnexus's code graph actually models. */
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'rb']);

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
  /** An after-context request (`-A n`), which asks to see the body. */
  afterContext: number | null;
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

/** A quoted definition pattern, re-parsed to recover its parts. */
const DEFINITION_RE = new RegExp(
  `^\\^?(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(${DECL_KEYWORD})\\s+([A-Za-z_$][\\w$]*)$`,
);

/** `grep [flags] <pattern> [paths…]`, with flags and pattern in any order. */
export function parseGrepAtom(atom: string): ParsedGrepCommand {
  const out: ParsedGrepCommand = {
    pattern: null, declKeyword: null, symbol: null, paths: [], flags: [],
    includes: [], afterContext: null, recursive: false, writes: false, dynamic: false,
  };
  const tokens = tokenize(atom);
  const start = tokens.findIndex((t) => t === 'grep');
  if (start === -1) return out;

  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i];

    // Stderr plumbing is noise; a stdout redirect is a real artifact.
    if (/^2>/.test(token)) {
      if (token === '2>') i += 1;
      continue;
    }
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
      if (ARG_FLAGS.has(bare)) {
        out.flags.push(bare);
        const value = inlineValue ?? tokens[i + 1] ?? '';
        if (inlineValue === null) i += 1;
        if (bare === '-A') out.afterContext = Number.parseInt(value, 10);
        continue;
      }

      // A short cluster like `-rln`, or `-A30` with the count attached.
      const attached = /^-([A-Za-z]+)(\d+)$/.exec(bare);
      if (attached) {
        for (const ch of attached[1]) out.flags.push(`-${ch}`);
        if (attached[1].includes('A')) out.afterContext = Number.parseInt(attached[2], 10);
        if (/[rR]/.test(attached[1])) out.recursive = true;
        continue;
      }
      if (!bare.startsWith('--')) {
        for (const ch of bare.slice(1)) out.flags.push(`-${ch}`);
        if (/[rR]/.test(bare)) out.recursive = true;
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

/** gitnexus's own symbol-kind vocabulary, from `gitnexus.context`'s schema. */
const KIND_FOR_KEYWORD: Record<string, string> = {
  function: 'Function',
  class: 'Class',
  interface: 'Interface',
};

/** Render the tool call a covered command maps onto. */
function expressionFor(parsed: ParsedGrepCommand): string {
  const kind = KIND_FOR_KEYWORD[parsed.declKeyword ?? ''];
  const content = parsed.afterContext !== null ? ', include_content: true' : '';
  return `gitnexus.context { name: "${parsed.symbol}", kind: "${kind}"${content} }`;
}

/**
 * Flags whose request `gitnexus.context` genuinely serves.
 *
 * `-l`/`-n` ask WHERE the definition is, which is exactly what the tool returns
 * (file location); `-r`/`-R` is the recursion this pattern requires; `-w` asks
 * for a whole-word match, and the tool matches an exact symbol NAME, which is
 * strictly that; `-I`/`-h`/`-s` are output/binary plumbing that does not change
 * the question; `--include` is a source-type filter checked separately.
 *
 * `-A` is covered on a JUDGEMENT that is worth stating plainly rather than
 * burying: on a DEFINITION-anchored grep, `-A 30` means "show me the start of
 * this symbol's body", and `include_content: true` returns the symbol's FULL
 * source — the same question, answered without the arbitrary truncation. `-B`
 * and `-C` are NOT covered: they ask for what PRECEDES a definition (decorators,
 * a JSDoc block), which the symbol's own source does not contain.
 */
const EXPRESSIBLE_FLAGS = new Set(['-r', '-R', '-l', '-n', '-w', '-I', '-h', '-s', '-A', '--include']);

/** Everything `gitnexus.context` can and cannot express about a parsed grep. */
export function coverDefinitionLookup(parsed: ParsedGrepCommand): CoverageResult {
  if (parsed.writes) {
    return { covered: false, reason: 'redirects the match output to a file; gitnexus.context returns a structured result and writes no artifact' };
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

  const unexpressible = parsed.flags.find((f) => !EXPRESSIBLE_FLAGS.has(f));
  if (unexpressible) {
    return {
      covered: false,
      reason: `passes \`${unexpressible}\`, which gitnexus.context has no argument for`,
    };
  }

  for (const glob of parsed.includes) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(glob)?.[1];
    if (ext === undefined || !CODE_EXTENSIONS.has(ext)) {
      return {
        covered: false,
        reason: `--include=${glob} filters to files gitnexus's CODE graph does not model (it indexes source, not data/config files)`,
      };
    }
  }

  if (parsed.paths.length === 0) {
    return {
      covered: false,
      reason: "no search path: grep walks the shell's cwd, which the atom no longer carries after `cd` was split off",
    };
  }

  const anchor = new RegExp(`^(?:${REPO_ANCHORS.join('|')})/`);
  const foreign = parsed.paths.find((p) => !anchor.test(p));
  if (foreign !== undefined) {
    return {
      covered: false,
      reason:
        `search path "${foreign}" is not anchored in this repo (a cwd-relative path, an absolute path, or another ` +
        'checkout on this box such as oddsmith); gitnexus indexes per-repo, so its answer would be about a different tree',
    };
  }

  return { covered: true, expression: expressionFor(parsed) };
}

/**
 * WI-6445 — `grep -r "<decl> <Ident>"` over a repo-anchored source tree: the one
 * shape where a recursive grep and the code graph answer the SAME question.
 *
 * Measured population for the definition shape before anchoring: 115 atoms
 * across 38 of 88 sessions, 115 distinct spellings — comfortably over both the
 * `MIN_POPULATION_ATOMS` and `MIN_POPULATION_SESSIONS` floors.
 */
export const gitnexusDefinitionLookup: BashSubstitutionPair = {
  id: 'code-search.definition-lookup',
  intentLabel: 'find-where-a-symbol-is-defined',
  bashPattern: new RegExp(
    `^${EXCLUDE_UNEXPRESSIBLE}${EXCLUDE_VENDORED}${EXCLUDE_UNANCHORED_ROOT}${REQUIRE_REPO_ANCHOR}` +
      `(?=[^\\n]*\\s${DEFINITION_PATTERN})` +
      `grep(?:\\s+-[A-Za-z]*[rR][A-Za-z]*)` +
      `[^\\n]*${TRAILING_NOISE}$`,
  ),
  toolName: 'gitnexus.context',
  advisoryText:
    'gitnexus.context { name, kind } answers "where is this defined" from the code graph: the symbol\'s file location PLUS its categorized callers and callees, and ranked candidates when the name is ambiguous — not just the one line grep would print. Add include_content: true for the full body. NOTE it is a DOT-namespaced plugin tool (gitnexus.context), not the usual server:verb form.',
  routing: {
    want: 'to find where a symbol is DEFINED (and who calls it)',
    use: '`gitnexus.context { name: "managedSetInterval", kind: "Function" }`',
    insteadOf:
      '`grep -rn "export function managedSetInterval" --include=*.ts --exclude-dir={node_modules,.vitest-tmp,dist,coverage} --exclude-dir=sidecar libs packages` (generated bundles/caches are not source evidence; exhaustive exact-text search remains grep\'s job)',
  },
  expectedVerdict: 'equivalent',
  cover(atom: string): CoverageResult {
    return coverDefinitionLookup(parseGrepAtom(atom));
  },
};

/** Every pair in the code-search family, in registry order. */
export const CODE_SEARCH_PAIRS: BashSubstitutionPair[] = [gitnexusDefinitionLookup];

/** Exported for the model-drift guard (D-015). */
export { EXPRESSIBLE_FLAGS, CODE_EXTENSIONS, REPO_ANCHORS };
