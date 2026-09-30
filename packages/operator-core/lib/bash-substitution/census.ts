/**
 * Classify 100% of the bash corpus into the five dispositions that decide the
 * REACHABLE CEILING of the substitution programme
 * (plan `bash-substitution-reachable-ceiling-2026-08-01`, P-005 and P-006).
 *
 * WHY THIS IS CODE AND NOT A SCRIPT THAT PRODUCED A NUMBER ONCE. The predecessor
 * plan's headline ("41% of tool use is bash") was computed by an ad-hoc script,
 * against a denominator later found to be inflated by 33.7% (D-047), and nobody
 * could re-derive it to check. P-018 has to re-run this same measurement after
 * Phase 3 lands and compare, so the classifier must be a reviewable artifact with
 * tests, not a shell one-liner in somebody's scrollback.
 *
 * WHAT THE FIVE DISPOSITIONS ARE FOR. P-005 states the plan's real success
 * criterion: `reachable = 1 - irreducible - should-not-happen`. Everything hangs
 * on that split being HONEST in the pessimistic direction, because every mistake
 * here flatters the programme:
 *
 *  - counting a command as substitutable when no tool can express it invents
 *    headroom that no amount of Phase 3 work can ever occupy;
 *  - counting a registry row's match as "covered" when that row's own recorded
 *    verdict is `not-a-substitute` counts a PROVEN NON-SUBSTITUTE as coverage.
 *    D-050's census did exactly this — it asked "does any pattern match?" — and
 *    so its 12.3% claimed figure is an upper bound on coverage, not coverage.
 *    {@link classifyAtom} splits the two, which is why the `covered` number here
 *    is smaller than D-050's and is the more defensible one.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE. Whether a pipe-filter (`… | head -5`)
 * is irreducible or reachable is P-006's decision, and it moves the ceiling by
 * tens of points. So it is a PARAMETER ({@link PipeFilterPolicy}), and
 * {@link runCensus} reports the ceiling under both settings. A measurement that
 * silently picked one would be presenting a decision as a finding.
 */

import { readFileSync } from 'node:fs';
import { atomHead, atomizePipeline } from './atomize';
import { ALL_PAIRS } from './pairs';
import { isBashPair } from './types';
import type { SubstitutionPair } from './types';

/** The five dispositions of P-005. */
export type Disposition =
  /** (i) An audited registry row already claims this atom AND can serve it. */
  | 'covered'
  /** (ii) Substitutable and a tool already exists — only a registry row is missing. */
  | 'tool-exists'
  /** (iii) Substitutable in principle, but the tool would have to be built. */
  | 'needs-tool'
  /** (iv) No tool can express it. This class IS the complement of the ceiling. */
  | 'irreducible'
  /** (v) The command should not have been issued at all (poll loops, redundant re-runs). */
  | 'should-not-happen';

/** P-006's open question, expressed as a parameter rather than assumed. */
export type PipeFilterPolicy =
  /** (a) Rule pipe-filters irreducible — they have no operand a tool could take. */
  | 'irreducible'
  /** (b) A caller-specified projection stage (D-041 / P-020) absorbs them all. */
  | 'projection'
  /**
   * (c) A pipe filter is reachable exactly when its PRODUCER has a tool form —
   * because the projection stage attaches to a tool call, and there is nothing
   * to attach it to when the thing on the left of the pipe is `some-script.sh`.
   *
   * Not one of the two options P-006 was written with; it is what the measurement
   * produced, and it is the one that survives contact with the corpus.
   */
  | 'producer-aware';

/** One corpus atom with the pipeline context classification depends on. */
export interface CensusAtom {
  sid: string;
  ts: string;
  /** Normalised atom — what a registry pattern is matched against. */
  atom: string;
  /** Pre-normalisation text, so elevation (`sudo …`) stays visible. */
  raw: string;
  /** First command word, path-stripped (`psql`, `journalctl`). */
  head: string;
  /** True when the atom's stdin is a pipe. */
  pipedInto: boolean;
  /** The atom feeding it, when piped. */
  upstream: string | null;
  /** That upstream's command word. */
  upstreamHead: string | null;
  /** The atom that STARTS the pipeline — the producer a projection attaches to. */
  pipelineRoot: string | null;
  /** That producer's command word. */
  pipelineRootHead: string | null;
}

/** A classification verdict for one atom. */
export interface AtomClassification {
  disposition: Disposition;
  /** Why — carried so a ranked row can be argued with rather than just read. */
  reason: string;
  /** The rule that fired, for auditing the table itself. */
  rule: string;
}

// ---------------------------------------------------------------------------
// The classification tables.
//
// Each is a judgement, so each is DATA with a stated reason rather than a branch
// buried in a function: the ceiling is only as credible as the ability to read
// these lists and disagree with a specific entry.
// ---------------------------------------------------------------------------

/**
 * Shell builtins and plumbing. Nothing here has, or could have, a tool form:
 * `cd` mutates the shell's own state, `echo`/`printf` are how a command writes
 * its output, `[`/`test` is a conditional. Together these dominate the corpus,
 * and that is the single biggest reason "~100% substitution" was never reachable.
 */
const SHELL_PLUMBING = new Set([
  'cd', 'echo', 'printf', 'export', 'set', 'unset', 'source', '.', 'eval', 'exec',
  'trap', 'shift', 'local', 'readonly', 'declare', 'typeset', 'alias', 'unalias',
  'pushd', 'popd', 'umask', 'ulimit', 'exit', 'return', 'wait', 'jobs', 'bg', 'fg',
  'read', 'true', 'false', ':', '[', '[[', 'test', 'let', 'hash', 'getopts', 'shopt',
  'break', 'continue', 'disown', 'env', 'flock', '#',
  // Path and shell INTROSPECTION. Each answers a question about the shell's own
  // position or about how a name resolves on this box; none has, or could
  // sensibly have, a tool form.
  'pwd', 'which', 'type', 'command', 'dirname', 'basename', 'realpath', 'readlink', 'stat',
]);

/**
 * Filesystem and archive MUTATIONS. A read tool cannot perform a write, and this
 * repo deliberately has no "mutate the tree" tool — edits go through Edit/Write
 * on a specific file, which is a different act from `mkdir -p` or `rm -rf`.
 */
const FS_MUTATION = new Set([
  'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'chmod', 'chown', 'chgrp', 'ln',
  'install', 'truncate', 'dd', 'tar', 'unzip', 'zip', 'gzip', 'gunzip', 'shred',
  'mktemp', 'tee', 'split',
]);

/** Commands that take over the terminal. There is no headless tool form. */
const INTERACTIVE = new Set([
  'vim', 'vi', 'nano', 'emacs', 'less', 'more', 'top', 'htop', 'watch', 'man',
  'tmux', 'screen', 'ncdu', 'lazygit',
]);

/**
 * Interpreters invoked to RUN A PROGRAM. `code:run` substitutes exactly one
 * subset of this — orchestrating papercusp tools — and nothing else: an agent
 * running `python3 analyse.py` is doing the work, not routing around a tool.
 * Classifying these as substitutable would be the clearest case of inventing
 * headroom.
 */
const SCRIPT_RUNNERS = new Set(['python3', 'python', 'node', 'tsx', 'bash', 'sh', 'zsh', 'perl', 'ruby', 'deno', 'bun']);

/**
 * The job-liveness question, in every form the corpus expresses it.
 *
 * These are (v) rather than (iv): each is perfectly substitutable in the narrow
 * sense, but the right answer is that the call should not exist — start the job
 * with `capability:bash { run_in_background: true }` and read it with
 * `capability:bash_output`. P-014 owns eliminating this class, and the repo's own
 * CLAUDE.md already tells agents so. Routing it to a tool would preserve the
 * round-trip that IS the cost.
 */
const LIVENESS_POLL = new Set(['sleep', 'pgrep', 'ps']);

/**
 * Filters that read stdin. When one of these is piped into it has no operand, so
 * every file-taking tool provably cannot express it — the P-006 population.
 */
const FILTER_HEADS = new Set(['head', 'tail', 'wc', 'sort', 'cut', 'uniq', 'tr', 'awk', 'sed', 'grep', 'jq', 'rev', 'tac', 'column', 'xargs', 'nl']);

/**
 * Verbs where a papercusp/agent tool ALREADY exists and only a registry row is
 * missing — the (ii) bucket, and the cheapest volume available to Phase 3.
 */
const TOOL_EXISTS: Record<string, string> = {
  find: 'Glob expresses name/extension discovery; no registry row names it',
  kill: 'processes:kill { taskId } — cgroup-safe, and the repo bans kill-by-pattern outright',
  du: 'dev:pg_table_sizes covers the DB case; host disk use has no row',
  df: 'host disk pressure is reported in coord:orient host block for the common case',
};

/**
 * Verbs with real fleet demand and NO tool — the (iii) bucket. The reason string
 * carries what the tool would have to do, so P-012 can size it without re-deriving.
 */
const NEEDS_TOOL: Record<string, string> = {
  ls: 'directory listing has no tool form; Glob answers name patterns, not "what is in here"',
  ssh: 'remote execution on the federation hosts; concentrated in few sessions (see MIN_POPULATION_SESSIONS)',
  scp: 'remote copy; same population caveat as ssh',
  rsync: 'remote sync; same population caveat as ssh',
  'tauri-agent-tools': 'the documented agent-e2e driver — a tool wrapper would make its output structured',
  docker: 'container lifecycle; no tool surface',
  gh: 'GitHub CLI; no tool surface',
  jq: 'JSON projection over a file operand (the piped form is the P-006 population)',
};

/**
 * Classify the PRODUCER at the head of this atom's pipeline, on its own terms.
 *
 * Always evaluated under the `irreducible` policy, which both terminates the
 * recursion in one step and is correct: a pipeline root is by construction not
 * piped into, so no pipe-filter rule can fire for it anyway.
 *
 * The root is the NORMALISED atom, so a `sudo …` producer loses its elevation
 * marker here and is judged on its verb. That errs optimistic for a handful of
 * atoms; it is called out rather than silently absorbed.
 */
function classifyPipelineRoot(entry: CensusAtom, pairs?: SubstitutionPair[]): AtomClassification | null {
  if (entry.pipelineRoot === null || entry.pipelineRootHead === null) return null;
  return classifyAtom(
    {
      ...entry,
      atom: entry.pipelineRoot,
      raw: entry.pipelineRoot,
      head: entry.pipelineRootHead,
      pipedInto: false,
      upstream: null,
      upstreamHead: null,
      pipelineRoot: null,
      pipelineRootHead: null,
    },
    { pipeFilterPolicy: 'irreducible', pairs },
  );
}

/** Registry pairs whose recorded verdict means a match is NOT coverage. */
function servesItsMatch(pair: SubstitutionPair): boolean {
  return pair.expectedVerdict === 'equivalent';
}

/**
 * Does any pair's pattern claim this atom? Returns the first match.
 *
 * SQL pairs are skipped rather than rejected at the type level, because the
 * caller legitimately hands this the WHOLE registry (`ALL_PAIRS`) — this census
 * scans shell atoms, and a pair matched by the relation a query reads has nothing
 * to say about one. Skipping is silent by design: a SQL pair failing to claim a
 * shell atom is not a gap in the census, it is the corpora being different
 * corpora (P-007).
 */
function matchingPair(atom: string, pairs: SubstitutionPair[]): SubstitutionPair | null {
  for (const pair of pairs) {
    if (!isBashPair(pair)) continue;
    // Patterns are authored with /g in places; a stateful regex would skip every
    // other match when reused across a 142k-atom scan (the classic lastIndex bug).
    const stateless = new RegExp(pair.bashPattern.source, pair.bashPattern.flags.replace(/g/g, ''));
    if (stateless.test(atom)) return pair;
  }
  return null;
}

/**
 * Does this atom redirect its output INTO A FILE? Such an atom is a write, and
 * no read tool can express it, whatever its verb.
 *
 * Two forms are deliberately NOT writes, and getting this wrong is expensive in
 * the pessimistic direction: the first version of this function counted both,
 * which moved `find` (2,973 atoms) and `cat` (2,507) into `irreducible` on the
 * strength of a trailing `2>/dev/null`.
 *
 *  - `2>&1`, `>&2` — duplicating a file descriptor produces no file;
 *  - a redirect whose target is `/dev/null` (or `/dev/std*`) — that is noise
 *    suppression on a READ, the single most common suffix in this corpus.
 */
function writesOutput(atom: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < atom.length; i += 1) {
    const ch = atom[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch !== '>') continue;
    const after = atom.slice(i + 1);
    if (after.startsWith('&')) continue;
    const target = after.replace(/^>/, '').trimStart().split(/\s+/)[0] ?? '';
    if (target.startsWith('/dev/null') || target.startsWith('/dev/std')) continue;
    return true;
  }
  return false;
}

/**
 * Classify one atom into a disposition.
 *
 * Rule ORDER is load-bearing and pessimistic by construction: structural
 * impossibility (a write, a shell builtin) is tested BEFORE any claim of
 * coverage, so a registry row whose pattern happens to match `echo foo > log`
 * cannot launder it into the reachable population.
 */
export function classifyAtom(
  entry: CensusAtom,
  options: { pipeFilterPolicy: PipeFilterPolicy; pairs?: SubstitutionPair[] },
): AtomClassification {
  const pairs = options.pairs ?? ALL_PAIRS;
  const head = entry.head;

  if (SHELL_PLUMBING.has(head)) {
    return { disposition: 'irreducible', reason: 'shell builtin / plumbing — no tool form exists or could', rule: 'shell-plumbing' };
  }
  if (LIVENESS_POLL.has(head)) {
    return { disposition: 'should-not-happen', reason: 'job-liveness polling — P-014 eliminates it (background at launch, read with bash_output)', rule: 'liveness-poll' };
  }
  if (writesOutput(entry.atom)) {
    return { disposition: 'irreducible', reason: 'redirects output to a file — a read tool cannot perform a write', rule: 'output-redirect' };
  }
  if (FS_MUTATION.has(head)) {
    return { disposition: 'irreducible', reason: 'filesystem/archive mutation — no tool surface, by design', rule: 'fs-mutation' };
  }
  if (INTERACTIVE.has(head)) {
    return { disposition: 'irreducible', reason: 'interactive/terminal-owning — no headless tool form', rule: 'interactive' };
  }
  if (/^sudo\b/.test(entry.raw)) {
    return { disposition: 'irreducible', reason: 'requires elevation — no tool here runs privileged', rule: 'elevated' };
  }
  if (head === 'tail' && /(^|\s)-{1,2}f\b|--follow/.test(entry.atom)) {
    return { disposition: 'irreducible', reason: 'streaming follow — the tool form returns a bounded read, not a stream', rule: 'follow-stream' };
  }

  if (entry.pipedInto && FILTER_HEADS.has(head)) {
    if (options.pipeFilterPolicy === 'projection') {
      return { disposition: 'needs-tool', reason: 'pipe filter — reachable via the D-041 projection stage (P-020)', rule: 'pipe-filter:projection' };
    }
    if (options.pipeFilterPolicy === 'irreducible') {
      return { disposition: 'irreducible', reason: 'pipe filter — no operand for any file-taking tool to read', rule: 'pipe-filter:irreducible' };
    }
    const producer = classifyPipelineRoot(entry, options.pairs);
    return producer === null || producer.disposition === 'irreducible' || producer.disposition === 'should-not-happen'
      ? { disposition: 'irreducible', reason: `pipe filter whose producer is ${producer?.disposition ?? 'absent'} — a projection has no tool call to attach to`, rule: 'pipe-filter:no-producer' }
      : { disposition: 'needs-tool', reason: `pipe filter over a ${producer.disposition} producer — the D-041 projection stage (P-020) attaches to it`, rule: 'pipe-filter:absorbable' };
  }

  const pair = matchingPair(entry.atom, pairs);
  if (pair && servesItsMatch(pair)) {
    return { disposition: 'covered', reason: `registry row ${pair.id} (${pair.toolName})`, rule: 'registry-equivalent' };
  }
  if (pair) {
    // A `not-a-substitute` row matching is EVIDENCE OF THE OPPOSITE of coverage:
    // the audit already established the named tool answers a different question.
    return { disposition: 'needs-tool', reason: `registry row ${pair.id} matches but its audited verdict is '${pair.expectedVerdict}' — not coverage`, rule: 'registry-negative' };
  }

  if (SCRIPT_RUNNERS.has(head) || head.endsWith('.sh') || head.endsWith('.mjs')) {
    return { disposition: 'irreducible', reason: 'runs a program — code:run substitutes only the tool-orchestration subset', rule: 'script-runner' };
  }
  if (head in TOOL_EXISTS) {
    return { disposition: 'tool-exists', reason: TOOL_EXISTS[head], rule: 'tool-exists' };
  }
  if (head in NEEDS_TOOL) {
    return { disposition: 'needs-tool', reason: NEEDS_TOOL[head], rule: 'needs-tool' };
  }

  // --- Verbs the registry claims only PARTIALLY -------------------------------
  // Each of these has a row that matches one shape and lets every other shape of
  // the same verb fall through. Left unclassified they were the bulk of a 15.2%
  // tail, and a tail that large makes a published ceiling unfalsifiable.

  if (head === 'grep' || head === 'rg' || head === 'ack') {
    // Not piped, so it has a path operand: this is CODE SEARCH, and a tool for it
    // exists. Its registry row is pinned at `observe` (WI-6445) because gitnexus
    // has not indexed this repo — a data problem, not a capability one, so the
    // disposition is (ii) and the reason carries the caveat rather than hiding it.
    return { disposition: 'tool-exists', reason: 'code search over a path — gitnexus.query / Grep exist; the registry row is pinned at observe while the index is empty (WI-6445)', rule: 'code-search-partial' };
  }
  if (head === 'wc' || head === 'awk' || head === 'cut' || head === 'uniq' || head === 'sort' || head === 'jq') {
    return { disposition: 'needs-tool', reason: 'projection over a file operand — the D-041 count/sort/cut operators (P-020) would express it', rule: 'projection-over-operand' };
  }
  if (head === 'psql') {
    // The routing table is explicit that `dev:pg_query` covers the OPERATOR
    // database only; a `$VAR` connection or another database is out of envelope,
    // and the plan's own definition of (iv) names non-operator DBs.
    return { disposition: 'irreducible', reason: 'psql outside the operator database (or an interactive/meta-command form) — dev:pg_query is operator-DB only, by design', rule: 'psql-non-operator' };
  }
  if (head === 'systemctl') {
    return { disposition: 'tool-exists', reason: 'dev:restart covers the two dev services and dev:service_health covers unit state; only these shapes lack a row', rule: 'systemctl-partial' };
  }
  if (head === 'npx' || head === 'npm' || head === 'pnpm' || head === 'yarn') {
    return { disposition: 'irreducible', reason: 'package-runner invocation outside the audited test/typecheck shapes — it runs a program', rule: 'script-runner' };
  }
  if (head.startsWith('-')) {
    // An atom whose first token is a FLAG is not a command: it is the tail of a
    // quoted or substituted construct the atomizer could not keep whole. Counted
    // and named rather than folded into the tail, because it measures residual
    // atomizer error and P-001 owns driving it to zero.
    return { disposition: 'irreducible', reason: 'atomizer residue — a flag in command position is a fragment, not a command', rule: 'atomizer-residue' };
  }

  return { disposition: 'needs-tool', reason: 'unclassified long tail — counted as reachable, which is the OPTIMISTIC reading', rule: 'unclassified' };
}

/** One ranked row of the census table. */
export interface CensusRow {
  head: string;
  atoms: number;
  sessions: number;
  /** Share of all classified atoms. */
  pct: number;
  /** The disposition holding the PLURALITY of this head's atoms. */
  disposition: Disposition;
  /**
   * Every rule that fired for this head, with counts.
   *
   * A head is routinely SPLIT — 38% of `grep` is a pipe filter and the rest is a
   * code search over a path; `tail` splits three ways (piped, bounded-with-file,
   * `-f` follow). An earlier version recorded the classification of the first
   * atom seen and labelled the whole row with it, which reported `grep` as
   * uniformly one thing and hid precisely the split P-006 exists to decide.
   */
  mix: Array<{ rule: string; disposition: Disposition; atoms: number; reason: string }>;
  reason: string;
  rule: string;
  /** How much of this head's volume was the right-hand side of a pipe. */
  pipedPct: number;
}

/** What the whole corpus says about the ceiling. */
export interface CensusReport {
  totalCalls: number;
  totalAtoms: number;
  totalSessions: number;
  byDisposition: Record<Disposition, { atoms: number; sessions: number; pct: number }>;
  /** `1 - irreducible - should-not-happen`, as a percentage. THE deliverable. */
  reachableCeilingPct: number;
  /** Share of atoms that fell through every rule — the honest uncertainty band. */
  unclassifiedPct: number;
  rows: CensusRow[];
  pipeFilter: PipeFilterAnalysis;
}

/** The evidence P-006 decides on. */
export interface PipeFilterAnalysis {
  atoms: number;
  sessions: number;
  pct: number;
  /** Ranked pipeline PRODUCERS, with whether each is itself reachable. */
  upstreams: Array<{ head: string; atoms: number; upstreamDisposition: Disposition }>;
  /**
   * Share of pipe-filter atoms whose PRODUCER has (or could have) a tool form.
   *
   * This is the number P-006 turns on: a projection stage can only absorb
   * `producer | filter` when the producer itself is a tool call to hang the
   * projection off. Where the producer is irreducible — `some-script.sh | head`
   * — the projection buys nothing and the filter stays irreducible under every
   * policy. Blanket (a) and blanket (b) are therefore both wrong, in opposite
   * directions, by exactly the complement of this figure.
   */
  absorbableByProjectionPct: number;
}

/** Read the raw JSONL extract into classified-ready atoms. */
export function loadCensusAtoms(jsonlPath: string): { atoms: CensusAtom[]; calls: number } {
  const atoms: CensusAtom[] = [];
  let calls = 0;
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let call: { sid: string; ts: string; cmd: string };
    try {
      call = JSON.parse(line) as { sid: string; ts: string; cmd: string };
    } catch {
      continue;
    }
    if (typeof call?.cmd !== 'string') continue;
    calls += 1;
    for (const part of atomizePipeline(call.cmd)) {
      const head = atomHead(part.atom);
      if (head === null) continue;
      atoms.push({
        sid: call.sid,
        ts: call.ts,
        atom: part.atom,
        raw: part.raw,
        head,
        pipedInto: part.pipedInto,
        upstream: part.upstream,
        upstreamHead: part.upstream === null ? null : atomHead(part.upstream),
        pipelineRoot: part.pipelineRoot,
        pipelineRootHead: part.pipelineRoot === null ? null : atomHead(part.pipelineRoot),
      });
    }
  }
  return { atoms, calls };
}

const EMPTY_TALLY = (): Record<Disposition, { atoms: number; sessions: Set<string> }> => ({
  covered: { atoms: 0, sessions: new Set() },
  'tool-exists': { atoms: 0, sessions: new Set() },
  'needs-tool': { atoms: 0, sessions: new Set() },
  irreducible: { atoms: 0, sessions: new Set() },
  'should-not-happen': { atoms: 0, sessions: new Set() },
});

/**
 * Run the full census.
 *
 * @param atoms every atom in the corpus — the whole point of P-004/P-005 is that
 *   this is not a sample.
 */
export function runCensus(
  atoms: CensusAtom[],
  options: { pipeFilterPolicy: PipeFilterPolicy; totalCalls?: number; pairs?: SubstitutionPair[] },
): CensusReport {
  const tally = EMPTY_TALLY();
  const byHead = new Map<string, {
    atoms: number;
    piped: number;
    sessions: Set<string>;
    byRule: Map<string, { disposition: Disposition; atoms: number; reason: string }>;
  }>();
  const sessions = new Set<string>();
  let unclassified = 0;

  const pipeFilterAtoms: CensusAtom[] = [];

  for (const entry of atoms) {
    const classification = classifyAtom(entry, options);
    sessions.add(entry.sid);
    tally[classification.disposition].atoms += 1;
    tally[classification.disposition].sessions.add(entry.sid);
    if (classification.rule === 'unclassified') unclassified += 1;
    if (classification.rule.startsWith('pipe-filter:')) pipeFilterAtoms.push(entry);

    let row = byHead.get(entry.head);
    if (!row) {
      row = { atoms: 0, piped: 0, sessions: new Set(), byRule: new Map() };
      byHead.set(entry.head, row);
    }
    row.atoms += 1;
    if (entry.pipedInto) row.piped += 1;
    row.sessions.add(entry.sid);
    const ruleTally = row.byRule.get(classification.rule);
    if (ruleTally) ruleTally.atoms += 1;
    else row.byRule.set(classification.rule, { disposition: classification.disposition, atoms: 1, reason: classification.reason });
  }

  const total = atoms.length || 1;
  const pct = (n: number): number => Math.round((n / total) * 1000) / 10;

  const byDisposition = Object.fromEntries(
    (Object.keys(tally) as Disposition[]).map((key) => [
      key,
      { atoms: tally[key].atoms, sessions: tally[key].sessions.size, pct: pct(tally[key].atoms) },
    ]),
  ) as CensusReport['byDisposition'];

  const rows: CensusRow[] = [...byHead.entries()]
    .map(([head, value]) => {
      const mix = [...value.byRule.entries()]
        .map(([rule, tallied]) => ({ rule, disposition: tallied.disposition, atoms: tallied.atoms, reason: tallied.reason }))
        .sort((a, b) => b.atoms - a.atoms);
      return {
        head,
        atoms: value.atoms,
        sessions: value.sessions.size,
        pct: pct(value.atoms),
        disposition: mix[0].disposition,
        mix,
        reason: mix[0].reason,
        rule: mix[0].rule,
        pipedPct: Math.round((value.piped / value.atoms) * 1000) / 10,
      };
    })
    // Rank by atoms x sessions, as P-004 specified: a 900-atom habit of one agent
    // is not the same finding as a 900-atom habit of sixty.
    .sort((a, b) => b.atoms * b.sessions - a.atoms * a.sessions);

  return {
    totalCalls: options.totalCalls ?? 0,
    totalAtoms: atoms.length,
    totalSessions: sessions.size,
    byDisposition,
    reachableCeilingPct:
      Math.round((100 - byDisposition.irreducible.pct - byDisposition['should-not-happen'].pct) * 10) / 10,
    unclassifiedPct: pct(unclassified),
    rows,
    pipeFilter: analysePipeFilters(pipeFilterAtoms, atoms.length, options),
  };
}

/**
 * Measure whether a projection stage could actually absorb the pipe-filter class.
 *
 * The question is NOT "how many pipe filters are there" (D-050 answered that) but
 * "how many have a producer a tool can express?" — because the projection stage
 * attaches to a TOOL CALL. `capability:read { file_path, tail: 25 }` replaces
 * `cat f | tail -25`; nothing replaces `some-script.sh | tail -25`.
 */
function analysePipeFilters(
  filters: CensusAtom[],
  totalAtoms: number,
  options: { pipeFilterPolicy: PipeFilterPolicy; pairs?: SubstitutionPair[] },
): PipeFilterAnalysis {
  const byUpstream = new Map<string, { atoms: number; disposition: Disposition }>();
  const sessions = new Set<string>();
  let absorbable = 0;

  for (const entry of filters) {
    sessions.add(entry.sid);
    const rootHead = entry.pipelineRootHead ?? '(none)';
    const producer = classifyPipelineRoot(entry, options.pairs);
    const disposition = producer?.disposition ?? 'irreducible';
    // Reachable means "there is a tool call to attach a projection to" — which
    // includes a producer whose tool has yet to be BUILT (`needs-tool`), because
    // the ceiling measures what is reachable in principle, not what ships today.
    if (disposition !== 'irreducible' && disposition !== 'should-not-happen') absorbable += 1;

    const row = byUpstream.get(rootHead);
    if (row) row.atoms += 1;
    else byUpstream.set(rootHead, { atoms: 1, disposition });
  }

  return {
    atoms: filters.length,
    sessions: sessions.size,
    pct: Math.round((filters.length / (totalAtoms || 1)) * 1000) / 10,
    upstreams: [...byUpstream.entries()]
      .map(([head, value]) => ({ head, atoms: value.atoms, upstreamDisposition: value.disposition }))
      .sort((a, b) => b.atoms - a.atoms)
      .slice(0, 20),
    absorbableByProjectionPct: filters.length === 0 ? 0 : Math.round((absorbable / filters.length) * 1000) / 10,
  };
}
