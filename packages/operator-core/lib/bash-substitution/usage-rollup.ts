/**
 * Tool-usage extraction + rollup for the bash→tool substitution METRIC
 * (plan `bash-to-tool-substitution-2026-07-26`, P-002).
 *
 * This is the measurement half of the plan: P-029 has to show the number MOVED,
 * which is only meaningful against a before-number computed the same way. These
 * are the pure functions that turn a raw agent transcript line into countable
 * usage, so the counting rule lives in ONE place that a test can pin.
 *
 * WHY THE TRANSCRIPT AND NOT POSTGRES (measured 2026-07-26 — do not re-derive):
 *  - Native `Bash` NEVER reaches `harness_shared.tool_invocations`. That table
 *    records MCP calls; the CLI's own tools are invisible to it. Its only
 *    bash-shaped row is `capability:bash` (108 calls/7d against ~24.6k real
 *    ones) — a different tool, not a sample of this one.
 *  - `locks:check_command` DOES carry full command text (6,875/7d), but it is a
 *    BIASED and SELF-CONFIRMING sample: the PreToolUse hook only escalates to
 *    the operator for commands hitting its local pre-filter
 *    (`sed cat head tail psql systemctl curl git` + the resource-gate triggers).
 *    Adding a pre-filter head would "improve" the metric while changing no
 *    agent's behaviour at all — the one thing a before/after number must never
 *    do. It is excluded as a census source on purpose.
 *  - `harness_shared.session_turns` is live and current, but is TEXT TURNS ONLY
 *    by design (its own header says so): `tool_use` blocks are never stored
 *    there. Its speakers are just `assistant`/`user`.
 *
 * So the transcript is the only complete source, and these functions are built
 * to run INSIDE the existing incremental session ingester
 * (`lib/search/session-ingest.ts`) rather than as a second scanner. That
 * matters for three reasons:
 *  1. A standalone sweep costs ~95s over the 7d window (1,678 files / 10.5M
 *    lines, measured) — above the MCP foreground budget, so it could never be
 *    a plain synchronous tool call.
 *  2. The ingester already walks these exact files incrementally, with
 *    byte-offset + mtime resume. A second walker would double the I/O over
 *    1.4GB to recompute what the first one already had in hand.
 *  3. Transcripts ROLL OFF (see `corpus.ts`, which freezes fixtures for this
 *    same reason). A scan-based metric silently loses its own baseline window
 *    as history ages out; counting AS WE INGEST persists the number before the
 *    bytes disappear.
 *
 * Everything here is pure and total: no I/O, and no input can make it throw.
 * The caller is a hot loop over ~10M lines inside a live fleet-wide pipeline,
 * so a malformed line must cost a skipped count, never a failed ingest.
 */

import { atomHead, atomize } from './atomize';
import { atomsOf, matchAtomsToSubstitutions, type SubstitutionRow } from './match';

/**
 * The grain a rollup row is keyed at.
 *
 * `verb` is null for the per-CALL row and set for a per-ATOM row. The audit
 * reported both figures (24,641 Bash calls carrying 156,345 atoms), and they
 * answer different questions: "Bash share of tool_use blocks" is a share of
 * CALLS, while "which intent bucket is this" is a property of an ATOM — one
 * `cd repo && sed -n '1,80p' f | head -5` is one call and three atoms. Keeping
 * both measures on one grain lets the report compute either without a second
 * pass, and stops the two from being silently conflated.
 */
export interface UsageKey {
  /** Calendar day (UTC, `YYYY-MM-DD`) of the record's own timestamp. */
  day: string;
  /** Tool as the client named it (`Bash`, `Read`, `mcp__papercusp-su__…`). */
  toolName: string;
  /** Command verb for a Bash atom (`sed`, `psql`); null on the per-call row. */
  verb: string | null;
  /**
   * Registry intent bucket (`file-range-read`) for a matched Bash atom; null on
   * every other row.
   *
   * Stored rather than derived at read time (migration 674, superseding 672's
   * plan to map verb→bucket on read) because a registry `bash_pattern` is an
   * ANCHORED regex over a FULL atom and the bare verb `sed` cannot match it.
   * The read-time mapping degrades to "verbs this pattern could start with",
   * measured 2026-07-26 at 34.2% precision overall and 1.1% for `head` — whose
   * atoms are overwhelmingly `| head -20` pipe filters, not file reads. The
   * bucket is matched HERE, where the command text still exists.
   */
  intentLabel: string | null;
}

/** Accumulated measures for one {@link UsageKey}. */
export interface UsageCounts {
  /** tool_use blocks — the denominator for "Bash share of tool_use blocks". */
  calls: number;
  /** Command atoms — the grain the intent buckets are defined at. */
  atoms: number;
  /** tool_result payload bytes, the result-token cost proxy (see BYTES_PER_TOKEN). */
  resultBytes: number;
}

/** A rollup keyed by `day\ttoolName\tverb\tintentLabel`. */
export type UsageRollup = Map<string, UsageKey & UsageCounts>;

/**
 * Bytes per token used to turn `resultBytes` into the reported token cost.
 *
 * 4 is the standard rough ratio for English + code under BPE. This is an
 * ESTIMATE and is named as one everywhere it surfaces: the transcript stores
 * the rendered result text, not the tokenizer's output, so an exact count would
 * require running the tokenizer over ~10M lines — far more than a cost proxy is
 * worth. What the metric needs is a number that moves proportionally when a
 * bucket's result volume moves, and this delivers that.
 */
export const BYTES_PER_TOKEN = 4;

/** Compose the map key. Tab-joined: none of the four parts can contain a tab. */
export function usageKeyOf(key: UsageKey): string {
  return `${key.day}\t${key.toolName}\t${key.verb ?? ''}\t${key.intentLabel ?? ''}`;
}

/**
 * One observed tool call, before it is folded into a rollup.
 *
 * `verbs` carries one entry per command ATOM for a Bash call (and is empty for
 * every other tool), so the caller never has to know which tool names are
 * shell-shaped.
 */
export interface ToolUseObservation {
  toolName: string;
  verbs: string[];
  /**
   * The raw shell command for a Bash call (null for every other tool).
   *
   * Carried alongside `verbs` — rather than replacing them — because the two
   * feed different measures: `verbs` is the re-classifiable "what is the shell
   * used for" row, while the command is what the registry's anchored patterns
   * must be matched against to attribute an INTENT BUCKET (migration 674). A
   * verb cannot stand in for the command there; see {@link UsageKey.intentLabel}.
   */
  command: string | null;
  /** ISO timestamp of the owning record, or null when the line carries none. */
  ts: string | null;
}

/**
 * The client's name for the shell tool.
 *
 * Pinned as a constant rather than matched loosely (`/bash/i`) because
 * `capability:bash` — the MCP tool — is a DIFFERENT tool that must not be
 * folded into this count: it is separately visible in `tool_invocations`, and
 * merging them would double-count the small overlap while implying the PG
 * source is a census of the CLI tool, which is exactly the confusion this
 * module's header exists to prevent.
 */
export const SHELL_TOOL_NAME = 'Bash';

/**
 * UTC calendar day of an ISO timestamp, or null if unparseable.
 *
 * UTC, not local: the rollup is compared across machines and re-read by a
 * report that may run in another zone, and a local-day bucket would silently
 * shift a call between days depending on who asked.
 */
export function dayOf(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 10);
}

/**
 * The command verbs of one shell invocation, one per atom.
 *
 * Reuses `atomize`/`atomHead` rather than re-splitting: those are documented as
 * the shared definition of an atom, and the frozen equivalence fixtures in
 * `pairs/` were drawn with exactly those semantics. A second splitter here
 * would let the metric and the verdicts drift apart without either changing.
 */
export function commandVerbs(command: unknown): string[] {
  if (typeof command !== 'string' || !command.trim()) return [];
  const out: string[] = [];
  for (const atom of atomize(command)) {
    const head = atomHead(atom);
    if (head) out.push(head);
  }
  return out;
}

/** Everything countable on one transcript line, from a SINGLE parse. */
export interface LineUsage {
  /** The record's own timestamp, used to date both measures below. */
  ts: string | null;
  /** tool_use blocks on an assistant record. */
  toolUses: ToolUseObservation[];
  /** tool_result payload bytes on a synthetic user record. */
  resultBytes: number;
}

const EMPTY_LINE_USAGE: LineUsage = { ts: null, toolUses: [], resultBytes: 0 };

/**
 * Extract every countable signal from one raw Claude transcript line.
 *
 * ONE `JSON.parse` per line, deliberately: the caller runs this over ~10M lines
 * per sweep inside a pipeline that already had to be taught to yield
 * cooperatively because per-line parsing was starving the event loop (WI-5218).
 * Parsing twice to keep two tidy single-purpose extractors would have doubled
 * the most expensive thing on the hot path for a cosmetic gain.
 *
 * Returns empty for malformed JSON rather than throwing — the ingester meets
 * real files mid-write.
 */
export function extractLineUsage(line: string): LineUsage {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return EMPTY_LINE_USAGE;
  }
  const kind = obj?.type;
  if (kind !== 'assistant' && kind !== 'user') return EMPTY_LINE_USAGE;
  const message = obj.message as { role?: string; content?: unknown } | undefined;
  if (!message || !Array.isArray(message.content)) return EMPTY_LINE_USAGE;
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;

  const toolUses: ToolUseObservation[] = [];
  let resultBytes = 0;
  for (const part of message.content) {
    if (!part || typeof part !== 'object') continue;
    const block = part as { type?: string; name?: string; input?: { command?: unknown }; content?: unknown };
    if (block.type === 'tool_use' && typeof block.name === 'string' && block.name) {
      const isShell = block.name === SHELL_TOOL_NAME;
      const command = isShell && typeof block.input?.command === 'string' ? block.input.command : null;
      toolUses.push({
        toolName: block.name,
        verbs: isShell ? commandVerbs(command) : [],
        command,
        ts,
      });
      continue;
    }
    if (block.type === 'tool_result') resultBytes += measureContentBytes(block.content);
  }
  return { ts, toolUses, resultBytes };
}

/**
 * Tool calls on one line. Thin wrapper over {@link extractLineUsage} kept for
 * readable single-purpose tests.
 */
export function extractToolUses(line: string): ToolUseObservation[] {
  return extractLineUsage(line).toolUses;
}

/**
 * Rendered size, in bytes, of the tool_result payloads on one line.
 *
 * This is the cost side of the metric (the audit's "9.82M result tokens /
 * 28.6% of tool-result context"). Counted in bytes at the source and converted
 * only at report time, so the stored number stays exact and the estimate stays
 * visible at the point it is made.
 *
 * ⚠ UNDERCOUNTS BY CONSTRUCTION, and must be read as a floor. The CLI does not
 * write a large result into the transcript: it substitutes a short
 * `<persisted-output> Output too large (47.1KB). Full output saved to: …` stub
 * and stores the payload beside the session. So the biggest results — exactly
 * the ones a substitution is most worth making — contribute only their stub's
 * bytes. The audit's own cost figure was measured the same way, so before and
 * after remain comparable, which is what P-029 needs; it just means the
 * absolute number understates true context cost.
 */
export function extractToolResultBytes(line: string): number {
  return extractLineUsage(line).resultBytes;
}

/**
 * Byte size of a tool_result's `content`, which the CLI writes either as a
 * bare string or as an array of content parts.
 */
function measureContentBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  let bytes = 0;
  for (const part of content) {
    if (typeof part === 'string') {
      bytes += Buffer.byteLength(part, 'utf8');
      continue;
    }
    if (part && typeof part === 'object') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') bytes += Buffer.byteLength(text, 'utf8');
    }
  }
  return bytes;
}

/** Fold one observation into a rollup, in place. */
export function addToolUse(
  rollup: UsageRollup,
  obs: ToolUseObservation,
  fallbackDay: string | null,
  substitutionRows: SubstitutionRow[] = [],
): void {
  const day = dayOf(obs.ts) ?? fallbackDay;
  // A call we cannot date cannot be windowed, and silently filing it under
  // "today" would inflate whichever window happens to be running. Drop it.
  if (!day) return;

  bump(rollup, { day, toolName: obs.toolName, verb: null, intentLabel: null }, { calls: 1, atoms: 0, resultBytes: 0 });
  for (const verb of obs.verbs) {
    bump(rollup, { day, toolName: obs.toolName, verb, intentLabel: null }, { calls: 0, atoms: 1, resultBytes: 0 });
  }

  // Intent buckets (P-002 / migration 674). Counted at ATOM grain via the
  // shared enforcement matcher, so the metric and the PreToolUse gate can never
  // disagree about what a bucket IS — and so this stays comparable with the
  // frozen fixtures' `totalAtoms`, which were also per-atom.
  if (obs.command === null || substitutionRows.length === 0) return;
  for (const match of matchAtomsToSubstitutions(atomsOf(obs.command), substitutionRows)) {
    bump(
      rollup,
      { day, toolName: obs.toolName, verb: null, intentLabel: match.intentLabel },
      { calls: 0, atoms: 1, resultBytes: 0 },
    );
  }
}

/** Fold result-payload bytes into a rollup, in place. */
export function addResultBytes(rollup: UsageRollup, bytes: number, day: string | null): void {
  if (bytes <= 0 || !day) return;
  bump(
    rollup,
    { day, toolName: RESULT_BYTES_TOOL, verb: null, intentLabel: null },
    { calls: 0, atoms: 0, resultBytes: bytes },
  );
}

/**
 * Synthetic tool name the un-attributed result bytes are filed under.
 *
 * A `tool_result` record does NOT name the tool it answers — only the
 * `tool_use_id` it replies to, whose matching call may sit in an earlier tick's
 * byte range or an already-rolled-off file. Rather than guess an attribution
 * that would be wrong at exactly the boundaries that matter, the total is kept
 * honest and un-attributed; per-bucket cost is reported from the calls side.
 */
export const RESULT_BYTES_TOOL = '_result_bytes';

function bump(rollup: UsageRollup, key: UsageKey, delta: UsageCounts): void {
  const id = usageKeyOf(key);
  const cur = rollup.get(id);
  if (cur) {
    cur.calls += delta.calls;
    cur.atoms += delta.atoms;
    cur.resultBytes += delta.resultBytes;
    return;
  }
  rollup.set(id, { ...key, ...delta });
}

/**
 * Fold every countable signal on one line into the rollup.
 *
 * `fallbackDay` dates a record that carries no usable timestamp of its own —
 * pass the owning file's last known day, or null to drop such lines.
 */
export function ingestLine(
  rollup: UsageRollup,
  line: string,
  fallbackDay: string | null,
  substitutionRows: SubstitutionRow[] = [],
): void {
  const usage = extractLineUsage(line);
  for (const obs of usage.toolUses) addToolUse(rollup, obs, fallbackDay, substitutionRows);
  // Date the result bytes from the RECORD's own timestamp, exactly like a call.
  // Passing the caller's fallback here regardless was a real bug: tool_result
  // records do carry a timestamp, and dropping it filed every byte under
  // `null` — which addResultBytes then discards, silently reporting a total
  // cost of zero against a corpus full of results.
  if (usage.resultBytes > 0) addResultBytes(rollup, usage.resultBytes, dayOf(usage.ts) ?? fallbackDay);
}

/** Merge `src` into `dst`, in place. */
export function mergeRollup(dst: UsageRollup, src: UsageRollup): void {
  for (const row of src.values()) {
    bump(dst, { day: row.day, toolName: row.toolName, verb: row.verb, intentLabel: row.intentLabel }, row);
  }
}

/** A rollup as plain rows, ordered deterministically for storage and tests. */
export function rollupRows(rollup: UsageRollup): Array<UsageKey & UsageCounts> {
  return [...rollup.values()].sort((a, b) =>
    a.day < b.day ? -1
      : a.day > b.day ? 1
        : a.toolName < b.toolName ? -1
          : a.toolName > b.toolName ? 1
            : (a.verb ?? '') < (b.verb ?? '') ? -1
              : (a.verb ?? '') > (b.verb ?? '') ? 1
                : (a.intentLabel ?? '') < (b.intentLabel ?? '') ? -1
                  : (a.intentLabel ?? '') > (b.intentLabel ?? '') ? 1
                    : 0,
  );
}
