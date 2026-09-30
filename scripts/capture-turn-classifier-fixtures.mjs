#!/usr/bin/env node
/**
 * capture-turn-classifier-fixtures.mjs — build the REAL captured transcript
 * fixtures that `psu-pty-host-classifier-fixtures.test.ts` asserts against
 * (plan psu-pty-turn-boundary-generalization-2026-09-22, P-010).
 *
 * WHY THIS EXISTS AS A SCRIPT RATHER THAN A HAND-WRITTEN FIXTURE
 * -------------------------------------------------------------
 * A hand-written fixture encodes what the author BELIEVED the transcript looks
 * like, which is exactly the error D-003 caught: porting codex's
 * "user_message resets" rule to claude looks obviously right and is silently
 * wrong, because Claude Code writes TOOL RESULTS as `type:'user'` rows. A
 * mock written by someone holding that wrong belief would have encoded the
 * wrong belief and passed. Only a real transcript could falsify it.
 *
 * So the fixture is CAPTURED from a real on-disk transcript, and this script is
 * committed so the capture is reproducible and its provenance auditable rather
 * than being a claim in a comment.
 *
 * WHAT IS CAPTURED (and what is deliberately NOT)
 * ----------------------------------------------
 * Only the fields the classifiers actually READ survive: the row `type`, the
 * `timestamp`, the completion identity (`uuid` / `payload.turn_id`), the
 * `stop_reason`, `isMeta`, and the CONTENT BLOCK TYPES (never their text).
 * Every other field — prompts, tool arguments, file contents, model names,
 * cwd — is dropped at capture time, so no owner content is ever committed.
 * The result is a real SHAPE and a real SEQUENCE with no real payload.
 *
 * The captured window is one genuine turn: from the last true turn-start
 * before the final completion, through that completion, plus the rows that
 * trail it. The trailing rows are load-bearing — several row kinds legitimately
 * occur AFTER the final completion, and a classifier that reset on one would
 * discard a true completion.
 *
 * Usage:
 *   node scripts/capture-turn-classifier-fixtures.mjs \
 *     --agent claude --source ~/.claude/projects/<proj>/<session>.jsonl
 *   node scripts/capture-turn-classifier-fixtures.mjs \
 *     --agent codex  --source ~/.codex/sessions/<y>/<m>/<d>/rollout-<id>.jsonl
 *
 * Optional: --out <dir> (defaults to the test's __fixtures__ directory).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TURN_ROW_CLASSIFIERS } from '../apps/operator/scripts/psu-pty-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', 'apps', 'operator', 'lib', '__fixtures__', 'turn-transcripts');

/** Per-agent capture rules, mirroring the classifier contracts under test. */
const AGENTS = {
  codex: {
    /** A row that certifies a completed turn. */
    isCompletion: (row) =>
      row?.type === 'event_msg'
      && (row.payload?.type === 'task_complete' || row.payload?.type === 'turn_completed'),
    /** A row that genuinely STARTS a turn (and so resets a latched completion). */
    isTurnStart: (row) =>
      row?.type === 'event_msg'
      && ['task_started', 'user_message', 'turn_aborted'].includes(row.payload?.type),
    /**
     * Is this window strong enough to be worth committing? For codex the
     * property under test is that rows which are NEITHER a start nor a
     * completion are ignored rather than clobbering a latched completion, so a
     * window with no such row proves nothing.
     */
    discriminates: (window) =>
      window.some((row) => row?.type === 'event_msg'
        && !['task_started', 'user_message', 'turn_aborted', 'task_complete', 'turn_completed']
          .includes(row.payload?.type)),
    discriminatorDescription: 'at least one ignorable event_msg row between start and completion',
    sanitize: (row) => {
      const out = { type: row.type };
      if (typeof row.timestamp === 'string') out.timestamp = row.timestamp;
      if (row.payload && typeof row.payload === 'object') {
        out.payload = { type: row.payload.type };
        if (typeof row.payload.turn_id === 'string') out.payload.turn_id = row.payload.turn_id;
      }
      return out;
    },
  },
  claude: {
    isCompletion: (row) => row?.type === 'assistant' && row.message?.stop_reason === 'end_turn',
    isTurnStart: (row) => {
      if (row?.type !== 'user' || row.isMeta) return false;
      const content = row.message?.content;
      // A tool RESULT is not a new owner turn, however much it looks like one.
      return !(Array.isArray(content) && content.some((b) => b?.type === 'tool_result'));
    },
    /**
     * D-003 IS the property under test for claude, so a window containing no
     * `type:'user'` tool-result row cannot possibly falsify the naive codex
     * port — the correct classifier and the wrong one agree on it, and the
     * test would pass VACUOUSLY. Refusing such a window here is what stops a
     * comfortable green from being committed.
     */
    discriminates: (window) =>
      window.some((row) => row?.type === 'user'
        && !row.isMeta
        && Array.isArray(row.message?.content)
        && row.message.content.some((b) => b?.type === 'tool_result')),
    discriminatorDescription: "at least one type:'user' row carrying a tool_result block (the D-003 trap)",
    sanitize: (row) => {
      const out = { type: row.type };
      if (typeof row.timestamp === 'string') out.timestamp = row.timestamp;
      if (typeof row.uuid === 'string') out.uuid = row.uuid;
      if (row.isMeta === true) out.isMeta = true;
      if (row.message && typeof row.message === 'object') {
        const message = {};
        if (typeof row.message.stop_reason === 'string') message.stop_reason = row.message.stop_reason;
        else if (row.message.stop_reason === null) message.stop_reason = null;
        // Block TYPES only — never the text/arguments inside a block.
        if (Array.isArray(row.message.content)) {
          message.content = row.message.content.map((b) => ({ type: b?.type ?? 'unknown' }));
        }
        out.message = message;
      }
      return out;
    },
  },
};

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const agent = args.agent;
  const rules = AGENTS[agent];
  if (!rules) {
    throw new Error(`--agent must be one of: ${Object.keys(AGENTS).join(', ')} (got ${agent ?? 'nothing'})`);
  }
  if (!args.source) throw new Error('--source <transcript.jsonl> is required');
  const source = resolve(args.source.replace(/^~/, process.env.HOME ?? '~'));

  const lines = readFileSync(source, 'utf8').split('\n').filter((l) => l.trim());
  const rows = lines.map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`source line ${i + 1} is not valid JSON`); }
  });

  /**
   * Walk completions NEWEST-FIRST and take the first window that actually
   * DISCRIMINATES. Taking the last completion unconditionally is the obvious
   * implementation and it is a trap: measured on a real 3,071-row claude
   * transcript, the final turn was a bare question-and-answer with no tool
   * calls at all, so the captured window held zero tool_result rows and the
   * fixture could not tell the correct classifier from the naive codex port.
   * A fixture that cannot fail is worse than no fixture, because it reads as
   * coverage. Prefer freshness, but never at the cost of discriminating power.
   */
  const completions = [];
  for (let i = rows.length - 1; i >= 0; i -= 1) if (rules.isCompletion(rows[i])) completions.push(i);
  if (!completions.length) {
    throw new Error(`no completion row found in ${source} — pick a transcript with a finished turn`);
  }

  let anchor = -1;
  let start = -1;
  let end = -1;
  let rejectedForWeakness = 0;
  for (const candidate of completions) {
    let candidateStart = -1;
    for (let i = candidate - 1; i >= 0; i -= 1) {
      if (rules.isTurnStart(rows[i])) { candidateStart = i; break; }
    }
    if (candidateStart < 0) continue;

    // Include the rows that TRAIL the completion, up to (not including) the
    // next real turn-start. These prove trailing rows do not clobber it.
    let candidateEnd = rows.length - 1;
    for (let i = candidate + 1; i < rows.length; i += 1) {
      if (rules.isTurnStart(rows[i])) { candidateEnd = i - 1; break; }
    }

    if (!rules.discriminates(rows.slice(candidateStart, candidateEnd + 1))) {
      rejectedForWeakness += 1;
      continue;
    }
    anchor = candidate;
    start = candidateStart;
    end = candidateEnd;
    break;
  }

  if (anchor < 0) {
    throw new Error(
      `no DISCRIMINATING window in ${source}: every one of ${completions.length} completed turn(s) `
      + `failed the ${agent} discriminator (${rules.discriminatorDescription}). `
      + 'Refusing to emit a fixture that would pass vacuously — capture from a transcript with real tool activity.',
    );
  }

  const window = rows.slice(start, end + 1);
  const sanitized = window.map(rules.sanitize);

  /**
   * PROVE the sanitizer is verdict-preserving, rather than asserting it in a
   * comment. Dropping a field the classifier turns out to read would produce a
   * fixture that is real-looking, committed, and quietly testing different
   * behaviour than production sees — the failure would surface as a passing
   * test. Comparing raw against sanitized across the fence boundaries is cheap
   * and makes the claim falsifiable at the moment of capture.
   */
  const classify = TURN_ROW_CLASSIFIERS[agent];
  if (typeof classify !== 'function') {
    throw new Error(`no registered classifier for '${agent}' — the registry and this script disagree`);
  }
  const stamps = window.map((r) => Date.parse(r?.timestamp)).filter((n) => Number.isFinite(n));
  if (!stamps.length) throw new Error('captured window has no parseable timestamps');
  const lo = Math.min(...stamps);
  const hi = Math.max(...stamps);
  // Both an in-fence and an out-of-fence context, so a dropped timestamp or
  // identity field cannot hide behind one lenient comparison.
  const contexts = [
    { receivedAtMs: lo, nowMs: hi + 1 },
    { receivedAtMs: hi + 1, nowMs: hi + 2 },
  ];
  for (const ctx of contexts) {
    for (let i = 0; i < window.length; i += 1) {
      const before = classify(window[i], ctx);
      const after = classify(sanitized[i], ctx);
      if (before !== after) {
        throw new Error(
          `sanitizer changed the verdict for captured row ${i} (${before} -> ${after}). `
          + 'The fixture would not represent production behaviour; widen the sanitizer allowlist.',
        );
      }
    }
  }

  mkdirSync(args.out ? resolve(args.out) : DEFAULT_OUT, { recursive: true });
  const outDir = args.out ? resolve(args.out) : DEFAULT_OUT;
  const jsonl = `${sanitized.map((r) => JSON.stringify(r)).join('\n')}\n`;
  writeFileSync(join(outDir, `${agent}.jsonl`), jsonl);

  // Provenance, so a later reader can tell a real capture from a hand-edit.
  // The source is identified by a HASH, never by a path that could leak a
  // session id or a project name.
  const meta = {
    agent,
    capturedAt: new Date().toISOString(),
    generator: 'scripts/capture-turn-classifier-fixtures.mjs',
    sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    sourceRowCount: rows.length,
    capturedRowCount: sanitized.length,
    windowStartIndex: start,
    completionIndex: anchor,
    trailingRowCount: end - anchor,
    discriminator: rules.discriminatorDescription,
    verdictPreservingSanitizer: 'proven at capture: raw vs sanitized agree on every row, in-fence and out-of-fence',
    completionsConsidered: completions.length,
    windowsRejectedAsNonDiscriminating: rejectedForWeakness,
    note: 'Captured from a real on-disk transcript; every field the classifier does not read was dropped at capture time.',
  };
  writeFileSync(join(outDir, `${agent}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`);

  process.stdout.write(
    `captured ${sanitized.length} row(s) for ${agent} `
    + `(window ${start}..${end} of ${rows.length}, completion at ${anchor}, `
    + `${meta.trailingRowCount} trailing) -> ${join(outDir, `${agent}.jsonl`)}\n`,
  );
}

main();
