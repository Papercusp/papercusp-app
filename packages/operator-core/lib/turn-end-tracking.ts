/**
 * turn-end-tracking — system-owned turn-end sweeps
 * (deterministic-context-carry-2026-07-14 P-015, plan D-003: tracking becomes
 * system-owned/deterministic wherever possible).
 *
 * Two sweeps, both riding the P-012 turn-end seam (journal:record-turn — the
 * one server-side moment that fires at every turn end across every CLI):
 *
 *  1. AUTO-CHECKPOINT ON STALE HELD-WI — a held work-item whose checkpoint is
 *     missing or old is the classic silent-halt precursor: the holder dies /
 *     compacts and the successor cold-starts. The system writes a MECHANICAL
 *     checkpoint block composed deterministically from what it already tracks
 *     (the turn's journal note + the P-013 tool-call log tail) — clearly
 *     marked, holder-session-level, never overwriting agent-authored prose
 *     (the block is appended; only a PREVIOUS mechanical block is replaced).
 *
 *  2. UNREGISTERED-ARTIFACT DETECTION — a deliverable written to a scratch
 *     path (report, analysis, export) that is never registered via
 *     artifacts:save is invisible to every other agent and dies with the
 *     sandbox. Detected from the turn's file-write ledger vs the
 *     harness_text_artifacts registrations in the same window; recorded as a
 *     journal tripwire (kind 'unregistered-artifact').
 *
 * PURE logic here (unit-tested without PG); the IO wiring lives in
 * agent-tools/journal/record-turn.ts. Warn/record-only — enforcement is P-016.
 */

import { createHash } from 'node:crypto';

/** A held checkpoint older than this (or absent) is STALE at turn end. */
export const STALE_CHECKPOINT_MS = 45 * 60 * 1000;

/** Marker opening a mechanical (system-written) checkpoint block. The ⟦…⟧
 *  bracket family is already the machine-text convention (⟦journal⟧,
 *  ⟦turn-origin⟧) — unmistakable, never typed by hand. */
export const MECHANICAL_CHECKPOINT_MARKER = '⟦auto-checkpoint mechanical';

/** Separator between agent-authored prose and the appended mechanical block. */
const MECHANICAL_SEP = '\n\n---\n';
const STRUCTURED_CARRY_SECTION_RE = /^##\s+(?:Checks|Walls)\s*$/im;

export interface HeldCheckpointState {
  checkpoint: string | null;
  /** Epoch ms of the checkpoint's last write; null/undefined when unknown
   *  (matches CarryBriefHeldItem's optional meta). */
  checkpointUpdatedAtMs?: number | null;
}

/**
 * Stale = no checkpoint at all, or one older than the threshold. An EXISTING
 * checkpoint with UNKNOWN write time is NOT stale — this sweep only acts when
 * it can prove the gap (warn-only discipline; a wrong overwrite is worse than
 * a missed nudge).
 */
export function isStaleHeldCheckpoint(
  item: HeldCheckpointState,
  nowMs: number,
  thresholdMs: number = STALE_CHECKPOINT_MS,
): boolean {
  if (item.checkpoint === null || item.checkpoint.trim() === '') return true;
  if (item.checkpointUpdatedAtMs === null || item.checkpointUpdatedAtMs === undefined) return false;
  return nowMs - item.checkpointUpdatedAtMs > thresholdMs;
}

export interface MechanicalCheckpointInput {
  /** When the block was composed (ISO). */
  atIso: string;
  /** The turn's journal note, when one was recorded. */
  journalNote?: string | null;
  /** The P-013 tool-call log tail for the window (renderToolCallLog output). */
  toolLog?: string | null;
  /** The recording session, for traceability. */
  sessionId?: string | null;
}

const JOURNAL_NOTE_CAP = 400;

/**
 * Compose the mechanical block. Honest about its own nature: it is a snapshot
 * of the HOLDER's session activity, not verified per-item state — strictly
 * better than a null checkpoint for a cold successor, never presented as
 * agent-authored.
 */
export function composeMechanicalCheckpoint(input: MechanicalCheckpointInput): string {
  const lines = [
    `${MECHANICAL_CHECKPOINT_MARKER} @${input.atIso}⟧ system turn-end snapshot — the holder's agent-written ` +
      `checkpoint was missing/stale (P-015). Holder-session-level, not item-verified.`,
  ];
  if (input.sessionId) lines.push(`session: ${input.sessionId}`);
  const note = (input.journalNote ?? '').replace(/\s+/g, ' ').trim();
  if (note) lines.push(`latest journal: ${note.slice(0, JOURNAL_NOTE_CAP)}`);
  const log = (input.toolLog ?? '').trim();
  if (log) lines.push('tool-log tail:', log);
  return lines.join('\n');
}

/**
 * Merge the mechanical block into an existing checkpoint: agent-authored prose
 * is PRESERVED verbatim; a previous mechanical block (always the tail — this
 * function only ever appends one at the end) is replaced, so repeated sweeps
 * never stack blocks.
 */
export function mergeMechanicalCheckpoint(existing: string | null | undefined, block: string): string {
  const prior = (existing ?? '').trimEnd();
  if (!prior) return block;
  const markerAt = prior.indexOf(MECHANICAL_CHECKPOINT_MARKER);
  const agentPart = (markerAt >= 0 ? prior.slice(0, markerAt) : prior).replace(/(\n\s*---\s*)+$/, '').trimEnd();
  if (!agentPart) return block;

  // Mechanical tool-log lines are ordinary prose, but carry-note parsing treats
  // every line after `## Checks`/`## Walls` as a structured row. Keep the system
  // snapshot before those sections so activity metadata cannot consume the
  // twelve-row claim budget or evict real verified claims.
  const sectionMatch = STRUCTURED_CARRY_SECTION_RE.exec(agentPart);
  const structuredStart = sectionMatch?.index ?? -1;
  if (structuredStart < 0) return `${agentPart}${MECHANICAL_SEP}${block}`;

  const authoredBody = agentPart.slice(0, structuredStart).trimEnd();
  const structuredSections = agentPart.slice(structuredStart).trimStart();
  return [authoredBody, block, structuredSections].filter(Boolean).join(MECHANICAL_SEP);
}

/* ------------------------------------------------------------------ */
/* Unregistered-artifact detection                                     */
/* ------------------------------------------------------------------ */

/** Scratch/temp roots — a deliverable landing here dies with the sandbox
 *  unless registered. Repo-tree writes are NOT artifacts (artifacts:save's own
 *  guidance: source code belongs in the repo, not the artifact store). */
const SCRATCH_PATH_RE =
  /^(?:\/tmp\/|~?\/?\.papercusp\/scratch\/(?:)|(?:\.{1,2}\/)?scratch(?:pad)?\/)|\/(?:scratchpad|\.papercusp\/scratch|scratch)\//;

/** Deliverable-shaped extensions: human-readable reports/exports. Code,
 *  JSONL plumbing, logs, and lockfiles are deliberately excluded — the lint
 *  must stay high-precision or agents learn to ignore it. */
const DELIVERABLE_EXT_RE = /\.(?:md|html?|csv|txt|pdf)$/i;

/** Obvious plumbing under scratch that is never a deliverable. */
const PLUMBING_RE = /\/(?:tasks|node_modules|\.git)\/|result-door-\d+/;

export function isDeliverableWrite(filePath: string): boolean {
  const p = filePath.trim();
  if (!p) return false;
  if (!SCRATCH_PATH_RE.test(p)) return false;
  if (PLUMBING_RE.test(p)) return false;
  return DELIVERABLE_EXT_RE.test(p);
}

/** The file/command fields persisted by the activity bridge. Native edit tools
 * carry `file`; shell tools carry `command` because their summary is only a
 * display glyph (▶). */
export interface FileWriteLedgerRow {
  file?: string | null;
  command?: string | null;
}

function addScratchTarget(out: string[], seen: Set<string>, raw: string | null | undefined): void {
  const path = (raw ?? '').trim();
  if (!path || path === '-' || /^&\d+$/.test(path) || !isDeliverableWrite(path) || seen.has(path)) return;
  seen.add(path);
  out.push(path);
}

/** Remove heredoc bodies before looking for shell-level redirects. The header
 * remains intact, while a `>` in prose or generated content cannot become a
 * fake file target. Interpreter APIs are scanned from the original command
 * separately, so writes inside a Python/Node heredoc still count. */
function withoutHeredocBodies(command: string): string {
  const lines = command.split('\n');
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = null;
      kept.push('');
      continue;
    }
    kept.push(line);
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_-]*)\1/);
    if (match) delimiter = match[2]!;
  }
  return kept.join('\n');
}

/** Tokenize only the shell punctuation needed by the write-shape scanner.
 * Quoted values stay single tokens and shell comments are ignored. This is
 * intentionally not a shell parser: unresolved expansions remain literal and
 * therefore fail open rather than producing a guessed path. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: string | null = null;
  let escaped = false;
  const flush = () => {
    if (token) tokens.push(token);
    token = '';
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\' && quote !== "'") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      } else {
        token += ch;
      }
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '#' && !token && (i === 0 || /[\s;|&]/.test(command[i - 1]!))) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if ('|;&<>'.includes(ch)) {
      flush();
      let op = ch;
      const next = command[i + 1];
      if ((ch === '>' || ch === '<') && next === ch) {
        op += next;
        i += 1;
      } else if ((ch === '>' || ch === '&') && next === '&') {
        op += next;
        i += 1;
      } else if ((ch === '>' || ch === '&') && next === '>') {
        op += next;
        i += 1;
      } else if (ch === '|' && next === '|') {
        op += next;
        i += 1;
      }
      tokens.push(op);
      continue;
    }
    token += ch;
  }
  if (escaped) token += '\\';
  flush();
  return tokens;
}

function isShellControl(token: string): boolean {
  return token === '|' || token === ';' || token === '&&' || token === '||';
}

function isRedirectOperator(token: string): boolean {
  return /^(?:>{1,2}|<{1,3}|&>|>&|>\|)$/.test(token);
}

function commandBase(token: string): string {
  return basenameOf(token.replace(/^.*[\\/]/, ''));
}

/** Read a balanced call's argument text, respecting nested calls and quoted
 * strings. `end` points at the closing parenthesis for method chaining. */
function callArguments(source: string, openParen: number): { args: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = openParen; i < source.length; i += 1) {
    const ch = source[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\' && quote !== "'") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { args: source.slice(openParen + 1, i), end: i };
    }
  }
  return null;
}

function splitCallArguments(args: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (ch === '\\' && quote !== "'") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(args.slice(start).trim());
  return out;
}

function quotedLiteral(text: string): string | null {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  let escaped = false;
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (escaped) {
      value += ch;
      escaped = false;
    } else if (ch === '\\' && quote !== "'") {
      escaped = true;
    } else if (ch === quote) {
      return value;
    } else {
      value += ch;
    }
  }
  return null;
}

function shellWriteTargets(command: string): string[] {
  const source = command.slice(0, 8_000);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string | null | undefined) => addScratchTarget(out, seen, path);
  const tokens = shellTokens(withoutHeredocBodies(source));

  // `>`, `>>`, `2>`, `&>`, and `>|`; `<<` only introduces heredoc content.
  for (let i = 0; i < tokens.length; i += 1) {
    let operator = tokens[i]!;
    let operatorIndex = i;
    if (/^\d+$/.test(operator) && isRedirectOperator(tokens[i + 1] ?? '')) {
      operator = tokens[i + 1]!;
      operatorIndex = i + 1;
    }
    if (isRedirectOperator(operator)) {
      if (!operator.startsWith('<')) add(tokens[operatorIndex + 1]);
      i = operatorIndex;
    }
  }

  // In-place shell utilities. Only their literal positional targets are
  // useful here; a computed/glob target is deliberately left unresolved.
  for (let i = 0; i < tokens.length; i += 1) {
    const name = commandBase(tokens[i]!);
    if (name === 'tee') {
      for (let j = i + 1; j < tokens.length && !isShellControl(tokens[j]!); j += 1) {
        const candidate = tokens[j]!;
        if (isRedirectOperator(candidate) || /^\d+$/.test(candidate) || candidate === '&' || candidate === '-')
          continue;
        if (candidate === '--' || candidate.startsWith('-')) continue;
        add(candidate);
      }
      continue;
    }
    if (name === 'cp' || name === 'mv' || name === 'install') {
      const positional: string[] = [];
      let recursive = false;
      for (let j = i + 1; j < tokens.length && !isShellControl(tokens[j]!); j += 1) {
        const candidate = tokens[j]!;
        if (
          candidate === '-r' ||
          candidate === '-R' ||
          candidate === '-a' ||
          candidate === '--recursive' ||
          candidate === '--archive'
        )
          recursive = true;
        if (isRedirectOperator(candidate) || candidate.startsWith('-')) continue;
        positional.push(candidate);
      }
      if (!recursive && positional.length >= 2) add(positional[positional.length - 1]);
      continue;
    }
    if (name === 'touch') {
      for (let j = i + 1; j < tokens.length && !isShellControl(tokens[j]!); j += 1) {
        const candidate = tokens[j]!;
        if (!candidate.startsWith('-') && candidate !== '--') add(candidate);
      }
      continue;
    }
    if (name === 'sed' || name === 'perl' || name === 'ruby' || name === 'awk') {
      const segment: string[] = [];
      for (let j = i + 1; j < tokens.length && !isShellControl(tokens[j]!); j += 1) segment.push(tokens[j]!);
      const inPlace =
        name === 'awk'
          ? segment.some((t, j) => t === 'inplace' && (segment[j - 1] === '-i' || segment[j - 1] === '--include'))
          : segment.some((t) => t === '-i' || t.startsWith('-i') || t === '--in-place');
      if (inPlace) {
        for (const candidate of segment) {
          if (!candidate.startsWith('-') && candidate !== 'inplace') add(candidate);
        }
      }
    }
  }

  // Literal-path interpreter/file APIs. A read-only `open(...).read()` or
  // `readFileSync(...)` never matches these write-shaped call names/modes.
  const writeCall =
    /\b(?:(?:fs|Deno)\.(?:promises\.)?|Bun\.)?(?:writeFile|appendFile)(?:Sync)?\s*\(|\b(?:Deno\.)?write(?:Text|Binary)File\s*\(|\bBun\.write\s*\(|\bcreateWriteStream\s*\(/gi;
  for (const match of source.matchAll(writeCall)) {
    const open = source.indexOf('(', match.index ?? 0);
    const call = callArguments(source, open);
    if (call) add(quotedLiteral(splitCallArguments(call.args)[0] ?? ''));
  }

  const openCall = /\bopen\s*\(/gi;
  for (const match of source.matchAll(openCall)) {
    const open = source.indexOf('(', match.index ?? 0);
    const call = callArguments(source, open);
    if (!call) continue;
    const args = splitCallArguments(call.args);
    const mode = args
      .slice(1)
      .map((arg) => quotedLiteral(arg) ?? arg)
      .join(' ');
    if (/[wax+]/i.test(mode)) add(quotedLiteral(args[0] ?? ''));
  }

  const pathCall = /\bPath\s*\(/gi;
  for (const match of source.matchAll(pathCall)) {
    const open = source.indexOf('(', match.index ?? 0);
    const call = callArguments(source, open);
    if (!call || !/\.\s*write_(?:text|bytes)\s*\(/i.test(source.slice(call.end + 1, call.end + 80))) continue;
    add(quotedLiteral(splitCallArguments(call.args)[0] ?? ''));
  }

  const copyCall = /\b(?:shutil\.)?(?:copy|copy2|move|rename|replace)\s*\(/gi;
  for (const match of source.matchAll(copyCall)) {
    const open = source.indexOf('(', match.index ?? 0);
    const args = callArguments(source, open);
    if (!args) continue;
    const positional = splitCallArguments(args.args)
      .map((arg) => quotedLiteral(arg))
      .filter((arg): arg is string => Boolean(arg));
    if (positional.length >= 2) add(positional[1]);
  }

  return out;
}

/** Extract native edit paths and literal scratch targets from shell writes.
 * Native paths are retained exactly as before; shell candidates are narrowed
 * to deliverable-shaped scratch paths so read-only/prose commands fail open. */
export function extractFileWritePaths(rows: readonly FileWriteLedgerRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const nativePath = (row.file ?? '').trim();
    if (nativePath && !seen.has(nativePath)) {
      seen.add(nativePath);
      out.push(nativePath);
    }
    for (const shellPath of shellWriteTargets(row.command ?? '')) {
      if (!seen.has(shellPath)) {
        seen.add(shellPath);
        out.push(shellPath);
      }
    }
  }
  return out;
}

/** Export the shell-only leg for focused pure tests and future callers. */
export const extractShellWriteTargets = shellWriteTargets;

export function basenameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return (i >= 0 ? p.slice(i + 1) : p).toLowerCase();
}

const MAX_UNREGISTERED = 5;

/**
 * Deliverable-shaped file writes with no artifacts:save registration in the
 * same window. Matching is by BASENAME on purpose: artifacts register under a
 * harness-relative rel_path that never equals the sandbox's absolute write
 * path, and a false negative (same basename registered for different content)
 * is fine for a warn-only sweep.
 */
export function detectUnregisteredArtifacts(writtenFiles: string[], registeredRelPaths: string[]): string[] {
  const registered = new Set(registeredRelPaths.map(basenameOf));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of writtenFiles) {
    if (!isDeliverableWrite(f)) continue;
    const base = basenameOf(f);
    if (seen.has(base) || registered.has(base)) continue;
    seen.add(base);
    out.push(f);
    if (out.length >= MAX_UNREGISTERED) break;
  }
  return out;
}

/** The journal-tripwire payload for an unregistered-deliverable turn. */
export interface UnregisteredArtifactTripwire {
  kind: 'unregistered-artifact';
  /** Scratch-path deliverables written this turn with no registration. */
  files: string[];
  note: string;
}

export const UNREGISTERED_ARTIFACT_NOTE =
  'Deliverable(s) written to a scratch path with no artifacts:save registration this turn — scratch dies with ' +
  'the sandbox and nothing else can find the file. Register it: artifacts:save { rel_path, content } ' +
  '(PG-canonical, readable by every agent via artifacts:load). deterministic-context-carry P-015.';

export function unregisteredArtifactTripwire(
  writtenFiles: string[],
  registeredRelPaths: string[],
): UnregisteredArtifactTripwire | null {
  const files = detectUnregisteredArtifacts(writtenFiles, registeredRelPaths);
  if (files.length === 0) return null;
  return { kind: 'unregistered-artifact', files, note: UNREGISTERED_ARTIFACT_NOTE };
}

/* ------------------------------------------------------------------ */
/* Ephemeral terminal-deliverable reference detection                  */
/* ------------------------------------------------------------------ */

/** A textual reference that cannot be the sole durable home of a deliverable. */
export type EphemeralDeliverableReferenceKind = 'scratch-path' | 'scratch-uri' | 'artifact-url' | 'loopback-url';

export interface EphemeralDeliverableReference {
  kind: EphemeralDeliverableReferenceKind;
  reference: string;
}

/** Keep an adversarial completion/plan body from becoming an unbounded regex job. */
const MAX_EPHEMERAL_REFERENCE_SCAN_CHARS = 40_000;
/** A warning must remain useful even when a caller pasted a very large report. */
export const MAX_EPHEMERAL_DELIVERABLE_REFERENCES = 5;

/**
 * These are references, not filesystem writes. A path under `.papercusp/scratch`
 * is session-local (including `~/.papercusp/scratch` and nested repo copies),
 * while `papercusp://scratch` is the URI form returned by large-tool-output
 * doors. Claude artifact URLs are account-scoped and deletable, so they are a
 * rendering surface rather than a durable source of truth.
 */
const SCRATCH_REFERENCE_RE =
  /(?:^|[\s"'`(<\[])((?:~\/|(?:\.\.?\/)+|\/)?(?:[A-Za-z0-9._~-]+\/)*\.papercusp\/scratch(?:\/[A-Za-z0-9._~:@%+,-]+)*)/g;
const SCRATCH_URI_REFERENCE_RE =
  /(?:^|[\s"'`(<\[])(papercusp:\/\/scratch\/[A-Za-z0-9._~:@%+,-]+(?:\/[A-Za-z0-9._~:@%+,-]+)*)/gi;
const CLAUDE_ARTIFACT_REFERENCE_RE =
  /(?:^|[\s"'`(<\[])((?:https?:\/\/)?claude\.ai\/(?:code\/)?artifacts?\/[A-Za-z0-9][A-Za-z0-9._~:\/?#@!$&+,;=%-]*)/gi;
/**
 * A loopback presentation URL is reachable only while the local serving
 * process remains alive. Keep this deliberately to HTTP(S) presentation
 * links and the common loopback host spellings; internal tool/API URLs should
 * not be inferred from arbitrary prose as durable deliverables either, but
 * this guard's recurrence is specifically about links an owner is expected
 * to open after handoff.
 */
const LOOPBACK_URL_REFERENCE_RE =
  /(?:^|[\s"'`(<\[])((?:https?:\/\/)(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[\/?#][A-Za-z0-9._~:\/?#@!$&+,;=%-]*)?)(?![A-Za-z0-9._:-])/gi;

function trimEphemeralReference(reference: string): string {
  // Markdown prose commonly puts a reference immediately before punctuation.
  // Do not let that punctuation become part of the caller-visible evidence.
  return reference.replace(/[.,;:!?)}]+$/g, '');
}

/**
 * Find bounded, ordered references to session/account-local deliverable stores.
 * Pure and fail-open: malformed or overlong input can only reduce the warning,
 * never reject the durable write that the caller is making.
 */
export function detectEphemeralDeliverableReferences(text: string): EphemeralDeliverableReference[] {
  const source = String(text ?? '').slice(0, MAX_EPHEMERAL_REFERENCE_SCAN_CHARS);
  if (!source) return [];

  const found: Array<EphemeralDeliverableReference & { index: number }> = [];
  const collect = (regex: RegExp, kind: EphemeralDeliverableReferenceKind) => {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) {
      const raw = match[1];
      if (!raw) continue;
      const reference = trimEphemeralReference(raw);
      if (!reference) continue;
      const index = match.index ?? 0;
      found.push({ kind, reference, index });
    }
  };

  collect(SCRATCH_REFERENCE_RE, 'scratch-path');
  collect(SCRATCH_URI_REFERENCE_RE, 'scratch-uri');
  collect(LOOPBACK_URL_REFERENCE_RE, 'loopback-url');
  collect(CLAUDE_ARTIFACT_REFERENCE_RE, 'artifact-url');

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const unique: EphemeralDeliverableReference[] = [];
  for (const { kind, reference } of found) {
    const key = `${kind}:${reference.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ kind, reference });
    if (unique.length >= MAX_EPHEMERAL_DELIVERABLE_REFERENCES) break;
  }
  return unique;
}

/**
 * Caller-facing warning shared by durable Now and completion surfaces.
 * Warn-only is intentional: the content is already being persisted, and a
 * detector fault or a false positive must never discard that narrative.
 */
export function renderEphemeralDeliverableWarning(
  surface: string,
  references: EphemeralDeliverableReference[],
): string | undefined {
  if (references.length === 0) return undefined;
  const listed = references
    .slice(0, MAX_EPHEMERAL_DELIVERABLE_REFERENCES)
    .map(({ kind, reference }) => `${kind} '${reference}'`)
    .join(', ');
  const hasLoopbackUrl = references.some(({ kind }) => kind === 'loopback-url');
  const scopeNote = hasLoopbackUrl
    ? 'These references are host/process-local, session-local, or account-local and are not durable source storage.'
    : 'These references are session/account-local and are not durable source storage.';
  const loopbackNote = hasLoopbackUrl
    ? ' Loopback presentation URLs are transient: re-verify reachability at handoff and keep their serving process managed/alive.'
    : '';
  return (
    `${surface} names ${references.length === 1 ? 'an' : 'ephemeral'} ephemeral terminal-deliverable ` +
    `reference${references.length === 1 ? '' : 's'}: ${listed}. ${scopeNote}${loopbackNote} Persist the deliverable first in committed repository, plan, or ` +
    `work-item storage, and record its source path alongside any URL. This warning is advisory; the write ` +
    `was recorded (deliverable-durability guard).`
  );
}

/* ------------------------------------------------------------------ */
/* Open-task continuation — bounded TodoTracker-style turn reminder    */
/* ------------------------------------------------------------------ */

/** OMO's stagnation guard stops after three unchanged continuations. */
export const MAX_OPEN_TASK_REMINDER_ATTEMPTS = 3;

export interface OpenTaskReminderTask {
  id: string;
  content: string;
  activeForm?: string | null;
  status: string;
  position?: number | null;
  updatedAt: string;
}

export interface OpenTaskReminderTripwire {
  kind: 'open-task-reminder';
  note: string;
  signature: string;
  attempt: number;
  maxAttempts: number;
  taskCount: number;
  taskIds: string[];
}

export interface OpenTaskReminderDecision {
  tripwire: OpenTaskReminderTripwire;
  prompt: string;
  tasks: OpenTaskReminderTask[];
}

function openReminderTasks(tasks: readonly OpenTaskReminderTask[]): OpenTaskReminderTask[] {
  return tasks
    .filter((task) => task.status === 'pending' || task.status === 'in_progress')
    .map((task) => ({ ...task }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * A task mutation changes `updatedAt`; the remaining fields make the
 * fingerprint robust to imported/legacy rows whose timestamp was preserved.
 */
export function openTaskReminderSignature(tasks: readonly OpenTaskReminderTask[]): string {
  const canonical = openReminderTasks(tasks).map((task) => ({
    id: task.id,
    status: task.status,
    content: task.content,
    activeForm: task.activeForm ?? '',
    position: task.position ?? null,
    updatedAt: task.updatedAt,
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);
}

function oneLine(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function renderOpenTaskReminder(
  tasks: readonly OpenTaskReminderTask[],
  attempt: number,
  maxAttempts: number,
): string {
  const shown = tasks.slice(0, 6);
  const remaining = tasks.length - shown.length;
  const lines = shown.map((task) => {
    const label = task.status === 'in_progress' && task.activeForm ? task.activeForm : task.content;
    return `- [${task.status}] ${oneLine(label)}`;
  });
  if (remaining > 0) lines.push(`- …and ${remaining} more open task${remaining === 1 ? '' : 's'}`);
  return [
    `⟦open-task-reminder ${attempt}/${maxAttempts}⟧ This turn ended with ${tasks.length} ` +
      `pending/in-progress session task${tasks.length === 1 ? '' : 's'} and no armed continuation.`,
    ...lines,
    'Continue working now. Mark finished tasks completed, or drop/edit tasks that no longer describe real work. ' +
      `This automatic continuation stops after ${maxAttempts} unchanged attempts.`,
  ].join('\n');
}

/**
 * Decide whether this turn earns one continuation. A concrete wake source (an
 * engine loop, a bounded event-await, or an owner-answer turn) wins and makes
 * this reminder redundant. An unchanged task signature increments the durable
 * attempt carried by the prior journal tripwire; any task mutation resets it.
 */
export function decideOpenTaskReminder(input: {
  tasks: readonly OpenTaskReminderTask[];
  wakeGuaranteed: boolean;
  priorTripwire?: OpenTaskReminderTripwire | null;
  maxAttempts?: number;
}): OpenTaskReminderDecision | null {
  if (input.wakeGuaranteed) return null;
  const tasks = openReminderTasks(input.tasks);
  if (tasks.length === 0) return null;
  const maxAttempts = input.maxAttempts ?? MAX_OPEN_TASK_REMINDER_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return null;
  const signature = openTaskReminderSignature(tasks);
  const priorAttempt = input.priorTripwire?.signature === signature ? input.priorTripwire.attempt : 0;
  if (priorAttempt >= maxAttempts) return null;
  const attempt = priorAttempt + 1;
  const prompt = renderOpenTaskReminder(tasks, attempt, maxAttempts);
  return {
    prompt,
    tasks,
    tripwire: {
      kind: 'open-task-reminder',
      note: prompt,
      signature,
      attempt,
      maxAttempts,
      taskCount: tasks.length,
      taskIds: tasks.map((task) => task.id),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Unguarded-halt detection — the re-wake guarantee at turn end        */
/* ------------------------------------------------------------------ */

/**
 * The classic silent-halt: an AUTONOMOUS session (auto/drain mode) ends a turn
 * with open work but NO guaranteed re-wake — no armed loop, no registered
 * event-await, and (by the autonomous mode's own semantics) no owner present to
 * speak next. Nothing re-invokes it; it halts until a human notices. This is
 * exactly the "never end a turn expecting a wake that is not armed" failure the
 * compaction-strategy prose describes — the point of this sweep is to move it
 * from advice the agent must REMEMBER to a MECHANICAL turn-end read the system
 * owns (deterministic-context-carry P-015; warn-only, enforcement is P-016).
 *
 * Gating on autonomous-mode is the high-precision "open work + no present owner"
 * signal: AUTO/DRAIN's entire premise is that the owner is away and work recurs
 * across turns (the AUTO contract literally says to arm a loop for exactly this),
 * so an autonomous session with no loop and no await is DEFINITIONALLY about to
 * violate that contract. An interactive session is never flagged — its owner IS
 * the guaranteed next wake.
 */
export interface RewakeGuaranteeState {
  /** An autonomous mode (auto/drain) is active — the owner is, by that mode's
   *  own semantics, NOT the guaranteed next speaker. */
  autonomousModeActive: boolean;
  /**
   * The current turn was injected by the machine (for example, a loop-fire or
   * wake-pump turn), so the owner cannot be treated as the next speaker merely
   * because the mode row is absent or stale.
   */
  machineTurn?: boolean;
  /** The engine loop is armed (loop:status.active === true). */
  loopActive: boolean;
  /** Count of this owner's active event-await registrations that actually
   *  GUARANTEE a re-wake, EXCLUDING the always-armed `coord:inbox-wake:`
   *  keepalive (which every live agent holds, so it is liveness — not a
   *  deliberate wake for this session's pending work).
   *
   *  ⚠ "Guarantee" is narrower than "registered" (WI-6604). The caller counts
   *  only awaits that are BOUNDED (an expiry is set) AND wake on that deadline
   *  (`timeoutBehavior: 'wake'`), because an unbounded — or silently expiring —
   *  await wakes nobody if its event never fires, and a sleeping await also
   *  suppresses monitor-loop fires, so it can take an armed loop down with it.
   *  The caller applies both filters (INBOX_WAKE_KEY_PREFIX + boundedness). */
  activeAwaitCount: number;
  /** The prompt that STARTED this turn was owner-interactive (a human is here
   *  and will speak next) — suppresses the flag. Best-effort; default false. */
  ownerInteractiveTurn?: boolean;
}

/**
 * Is a re-wake GUARANTEED after this turn ends? True (safe to settle) when the
 * session is interactive, an owner is present this turn, a loop is armed, or a
 * real (non-inbox-wake) await is registered. False ONLY for an autonomous
 * session with none of those — the unguarded halt.
 */
export function isRewakeGuaranteed(s: RewakeGuaranteeState): boolean {
  // A machine-injected turn has no implicit human wake. Check the concrete wake
  // sources first, even when the mode row is absent/stale (EI-21189324808136207).
  if (s.machineTurn) {
    return s.loopActive || s.activeAwaitCount > 0;
  }
  if (!s.autonomousModeActive) return true; // interactive/normal: owner speaks next
  if (s.ownerInteractiveTurn) return true; // a human is here this turn
  if (s.loopActive) return true; // armed engine loop re-wakes it
  if (s.activeAwaitCount > 0) return true; // a registered event-await re-wakes it
  return false;
}

/** The await fields that decide whether it can be relied on to re-invoke a session. */
export interface RewakeAwaitShape {
  eventKey: string;
  /** ISO deadline, or null for an await with no bound. */
  expiresTs?: string | null;
  /** What happens at the deadline; defaults to 'wake' (the store's own default). */
  timeoutBehavior?: string | null;
  /** Cardinality: the platform keepalive is the only standing inbox-wake row. */
  once?: boolean | null;
}

/**
 * Does this await actually GUARANTEE a re-wake? (WI-6604 — pure, so it is testable
 * without PG; the IO caller maps rows through it.)
 *
 * Registered is NOT the same as guaranteeing. Three ways an await fails to wake you:
 *   · it is the always-armed `coord:inbox-wake:` keepalive — liveness every agent holds,
 *     not a deliberate wake for this session's pending work;
 *   · it is UNBOUNDED (no expiry), so if the event never fires nothing ever re-invokes you;
 *   · it EXPIRES silently at its deadline instead of waking you.
 *
 * "The event never fires" is routine, not exotic: sleeping on `release:deployed` after a
 * gate run wakes nobody when the gate reds, because no deploy is ever attempted. And since
 * a sleeping await suppresses monitor-loop fires, an await that cannot fire also silences
 * an armed loop — the session reads active:true / parked:true and produces no turns.
 */
export function awaitGuaranteesRewake(a: RewakeAwaitShape, inboxWakePrefix: string): boolean {
  // The platform's always-armed inbox keepalive is specifically a standing,
  // no-deadline, silently-expiring row (`once=false`, `expire`). An explicit
  // bounded `events:await` may intentionally use the same owner-keyed event
  // (the incident that motivated this guard), and must count as a wake source.
  // Classify the keepalive by its persisted shape instead of excluding the
  // entire key family by prefix.
  const isStandingInboxWakeKeepalive =
    a.eventKey.startsWith(inboxWakePrefix) &&
    a.once !== true &&
    a.expiresTs == null &&
    (a.timeoutBehavior ?? 'expire') === 'expire';
  if (isStandingInboxWakeKeepalive) return false;
  if (a.expiresTs == null) return false;
  return (a.timeoutBehavior ?? 'wake') === 'wake';
}

export interface UnguardedHaltTripwire {
  kind: 'unguarded-halt';
  note: string;
}

export const UNGUARDED_HALT_NOTE =
  'Turn ending under an autonomous mode (auto/drain) with NO guaranteed re-wake: no armed loop, ' +
  'no registered event-await, and no owner present to speak next. Nothing will re-invoke this ' +
  'session — it silently halts until a human notices (the "ended a turn expecting a wake that was ' +
  'not armed" failure). Before ending: arm a loop (loop:arm), register a BOUNDED wake ' +
  '(events:await / deploy:await WITH an explicit timeout_sec), or self-compact to continue ' +
  '(session:request-compaction { autoContinue: true }). ' +
  '⚠ A registered await is only a guarantee if its EVENT CAN ACTUALLY FIRE and it is BOUNDED. ' +
  'Ask what happens in the FAILURE branch: sleeping on release:deployed after a gate run wakes ' +
  'nobody if the gate reds, because no deploy is ever attempted. And an await SUPPRESSES ' +
  'monitor-loop fires while it sleeps, so an unbounded or impossible await silences an armed loop ' +
  'too — the loop reads active:true while parked:true, producing no turns (WI-6604).';

/** The unguarded-halt tripwire for a turn-end state, or null when a re-wake is
 *  guaranteed ({@link isRewakeGuaranteed}). Pure. */
export function detectUnguardedHalt(s: RewakeGuaranteeState): UnguardedHaltTripwire | null {
  return isRewakeGuaranteed(s) ? null : { kind: 'unguarded-halt', note: UNGUARDED_HALT_NOTE };
}

/* ------------------------------------------------------------------ *
 * Coord watermark settle (unread-count-truthfulness-2026-07-27 P-008 /
 * D-008) — the THIRD sweep riding this seam.
 * ------------------------------------------------------------------ */

/** The two message cursors, as stored on `harness_shared.coord_watermarks`. */
export interface CoordSettleState {
  /** `messages_since_ts` — the turn-END settle cursor: the newest message
   *  PROVABLY CONSUMED IN A COMPLETED TURN. */
  sinceTs: string | null | undefined;
  /** `messages_shown_ts` — the read RECEIPT: the newest message put in front
   *  of the agent, advanced MID-TURN by `coord:inbox` at injection (D-002). */
  shownTs: string | null | undefined;
}

/**
 * The value `messages_since_ts` should settle to at a CLEAN turn end, or null
 * when no write is warranted. Pure.
 *
 * D-008: `messages_since_ts` becomes a strict, abort-safe FOLLOWER of
 * `messages_shown_ts`, exactly one clean turn behind — so the two cursors keep
 * genuinely distinct meanings (shown = put in front of the agent, possibly by a
 * turn that later aborted; since = consumed in a turn that genuinely finished).
 *
 * Two properties, both load-bearing, both enforced HERE rather than in
 * `writeWatermark`:
 *   - MONOTONE — returns null unless `shown > since`, so the settle can never
 *     regress a value an OMP session reported. `writeWatermark` is deliberately
 *     last-write-wins (its own doc: a `max()` clamp there would break the
 *     at-least-once safe-commit recovery and turn a documented re-delivery into
 *     a SKIP), and explicitly makes ordering safety "the caller's". This is
 *     that caller.
 *   - CLAMPED — the only non-null value returned is `shown` itself, so the
 *     cursor can never advance past what was demonstrably shown. That gives
 *     P-008's `since_ts <= shown_ts` invariant BY CONSTRUCTION rather than by
 *     a test, matching the substrate's own stated contract
 *     (`messages_shown_ts` is always >= `messages_since_ts`).
 *
 * An empty `shownTs` returns null: no receipt on record means nothing has been
 * PROVEN shown, and inventing a wall-clock "now" here would silently skip mail.
 */
export function settledMessagesCursor(s: CoordSettleState): string | null {
  const shown = s.shownTs || null;
  if (!shown) return null; // no receipt → nothing proven shown → never guess
  const since = s.sinceTs || null;
  if (since && since >= shown) return null; // already at/ahead → no write
  return shown;
}
