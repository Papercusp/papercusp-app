#!/usr/bin/env node
/**
 * artifact-url-delivery-guard — stop an artifact URL from being reported to the
 * owner as delivered when no artifact was ever published (EI-21844056581395228,
 * a repeat of EI-19944806095285549).
 *
 * WHY A HOOK AND NOT A PROMPT RAIL
 * The prompt already carries the rail ("Rendered ≠ delivered … re-resolve before
 * citing an artifact URL as delivered"). It has now failed TWICE, in sessions
 * that were carrying that exact text. A rail that has been read and not followed
 * twice is not repaired by rewording it a third time, so this is the mechanical
 * layer underneath it. On the derived-truth ladder this is the ATTEST rung: the
 * claim ("this artifact exists") cannot be derived statically, so it is
 * reconciled against a runtime ledger of Artifact calls that actually happened.
 *
 * THE ORACLE — deliberately "verified", not "published"
 * An id is citable only if a NON-ERROR Artifact tool call in THIS session
 * returned it: a publish, an action:'list' row, or an action:'read'. That is
 * precisely the re-resolve discipline the rail asks for, so an agent citing an
 * artifact from an earlier session is required to confirm it still resolves
 * first — which is the point, not a false positive. A failing call (a read of a
 * URL that does not exist) is an error response and is never harvested, so a
 * bad URL echoed back inside an error can never verify itself.
 *
 * THREE BRANCHES, ONE MECHANISM (matching the ask-gate-mirror precedent):
 *   PostToolUse(Artifact) → harvest returned ids into a session-scoped ledger.
 *   Stop                  → scan the final assistant text; block on any cited
 *                           id the ledger never saw.
 *   PreToolUse(durable)   → scan the INPUT of a durable write (checkpoint, plan,
 *                           fact, coord:send, …); deny on an unverified id.
 *
 * WHY THE PreToolUse BRANCH IS NOT REDUNDANT WITH Stop
 * The Stop branch covers prose, which is how the SECOND occurrence reached the
 * owner. But the FIRST (EI-19944806095285549) never appeared in prose at all: the
 * dead URL was written into a work-item CHECKPOINT and inherited by a successor as
 * settled fact. Those are different vectors and prose-scanning cannot see the
 * second one — a durable write can happen in a turn whose final message never
 * mentions the URL. The durable case is also the worse of the two: a claim in
 * prose is read once by a human who might question it, while a claim in a
 * checkpoint is re-injected into a successor's context already stated, where
 * nothing re-checks it. See DURABLE_WRITE_TOOLS for why that branch is an
 * allow-list rather than a pattern.
 *
 * SCANNING IS QUOTE-STRIPPED (the EI-19412167276099357 defect-3 lesson): code
 * fences, inline code and blockquotes are removed before scanning, so quoting a
 * known-bad URL — in a post-mortem, a fixture, a table row, this very file's
 * header — can never itself trip the guard. That also gives the agent its escape
 * hatch: discuss the URL in backticks, cite it bare only once it resolves.
 *
 * WHY BLOCKING AT Stop CANNOT WEDGE A SESSION: Claude sets `stop_hook_active` on
 * the continuation that follows our own decision:block, and we exit early on it.
 * The guard therefore bounces at most ONCE per turn — it forces a correction, it
 * cannot trap a session in a loop.
 *
 * FAIL-OPEN EVERYWHERE ELSE: any parse/IO failure exits 0 silently. A broken
 * guard must degrade to "no guard", never to a blocked agent.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Artifact ids as they appear in a claude.ai artifact URL. */
const ARTIFACT_URL_RE = /claude\.ai\/(?:code\/)?artifact(?:s)?\/([0-9a-zA-Z][0-9a-zA-Z-]{7,})/gi;

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/** Where a session's verified-id ledger lives (overridable for tests). */
export function ledgerPathFor(sessionId, env = process.env) {
  const root = env.PAPERCUSP_ARTIFACT_LEDGER_DIR || join(homedir(), '.papercusp', 'artifact-url-ledger');
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return join(root, `${safe}.ids`);
}

/**
 * Remove regions where citing a URL is deliberate quotation rather than a
 * delivery claim: fenced blocks, inline code, and blockquote lines.
 */
export function stripQuotedForScanning(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ');
}

/** Every artifact id mentioned in `text`, de-duplicated, order preserved. */
export function extractArtifactIds(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(ARTIFACT_URL_RE)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** True when a PostToolUse payload names the native/MCP Artifact tool. */
export function isArtifactTool(toolName) {
  return typeof toolName === 'string' && /(^|_)artifact$/i.test(toolName.replace(/^mcp__.*?__/, ''));
}

/**
 * Collapse a tool name to a comparable key: drop any `mcp__<server>__` prefix and
 * treat the colon and underscore spellings of a verb as the same tool, because a
 * papercusp verb is written `work_items:checkpoint` in docs and arrives from the
 * client mangled to `work_items_checkpoint`.
 */
export function normalizeToolName(toolName) {
  if (typeof toolName !== 'string') return '';
  return toolName
    .replace(/^mcp__.*?__/, '')
    .trim()
    .toLowerCase()
    .replace(/:/g, '_');
}

/**
 * DURABLE SURFACES — where a cited URL stops being a sentence and becomes a fact
 * a successor inherits without re-checking. This is the vector of the FIRST
 * occurrence (EI-19944806095285549): the dead URL was written into a work-item
 * CHECKPOINT, not into prose, and was then carried forward as settled truth.
 *
 * This is an explicit ALLOW-LIST, deliberately not a broad pattern. A broad
 * matcher would also catch `Artifact { action:'read' }` and `WebFetch` — the very
 * calls the block message tells the agent to make in order to verify a URL — and
 * a guard that denies its own remedy is a trap with no exit rather than a guard.
 * Under-coverage here is a miss (another surface goes unscanned); over-coverage
 * would be a wedged agent. Extend by adding a verb, never by widening to a regex.
 */
export const DURABLE_WRITE_TOOLS = new Set([
  'work_items_checkpoint',
  'work_items_comment',
  'work_items_complete',
  'work_items_create',
  'work_items_update',
  'loop_checkpoint',
  'facts_assert',
  'memory_remember',
  'coord_send',
  'improvements_capture',
  'plans_new',
  'plans_edit',
  'plans_add-item',
  'plans_add-decision',
  'plans_set-now',
]);

/** True when writing this tool's input persists text a successor will inherit. */
export function isDurableWriteTool(toolName) {
  if (isArtifactTool(toolName)) return false; // never deny the remedy
  return DURABLE_WRITE_TOOLS.has(normalizeToolName(toolName));
}

/**
 * Every string in a tool_input, depth- and count-bounded. Scanning the string
 * VALUES rather than `JSON.stringify(input)` keeps real newlines intact, so the
 * blockquote half of the quote-stripper still works on a markdown body.
 */
export function collectStrings(value, out = [], depth = 0) {
  if (depth > 8 || out.length >= 500) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out, depth + 1);
  }
  return out;
}

/**
 * Strings that a durable write will actually persist. Most durable tools expose
 * their written content directly, so scanning every string is appropriate. A
 * targeted plans:edit is different: old_string is the content being removed,
 * while only new_string becomes part of the resulting plan. Scanning old_string
 * makes the guard deny the prescribed remedy of deleting an unverifiable URL.
 */
export function durableWriteStrings(toolName, toolInput) {
  if (normalizeToolName(toolName) === 'plans_edit') {
    if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return [];
    return typeof toolInput.new_string === 'string' ? [toolInput.new_string] : [];
  }
  return collectStrings(toolInput);
}

/** True when the tool response reports failure (never harvest from these). */
export function isErrorResponse(response) {
  if (!response) return false;
  if (typeof response === 'object') {
    if (response.is_error === true || response.isError === true) return true;
    if (response.error) return true;
    if (response.ok === false) return true;
  }
  return false;
}

/**
 * Ids a non-error Artifact call actually returned. Harvest from the RESPONSE
 * only: an id that appears solely in the request is a URL the agent asserted,
 * which is exactly the unverified thing this guard exists to catch.
 */
export function harvestLedgerIds(hook) {
  if (!hook || !isArtifactTool(hook.tool_name ?? hook.toolName)) return [];
  const response = hook.tool_response ?? hook.toolResponse;
  if (response === undefined || response === null) return [];
  if (isErrorResponse(response)) return [];
  let blob;
  try {
    blob = typeof response === 'string' ? response : JSON.stringify(response);
  } catch {
    return [];
  }
  return extractArtifactIds(blob);
}

export function readLedger(path) {
  try {
    return new Set(
      readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function appendLedger(path, ids) {
  if (!ids.length) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, ids.map((id) => `${id}\n`).join(''), 'utf8');
  } catch {
    /* fail open */
  }
}

export function formatBlockReason(unverified) {
  const list = unverified.map((id) => `  • ${id}`).join('\n');
  return (
    `⛔ artifact-url-delivery-guard (EI-21844056581395228): your message cites an ` +
    `artifact URL that NO Artifact call in this session ever returned:\n\n${list}\n\n` +
    `Publishing is not the same as delivering, and a publish result is not proof a ` +
    `page is reachable. This exact failure has now happened twice: a URL was reported ` +
    `to the owner as ready for review and the artifact did not exist.\n\n` +
    `Do ONE of these before ending the turn:\n` +
    `  1. VERIFY it — Artifact { action:'list' } (it should appear) or read/publish it. ` +
    `Then cite it; this guard will pass because the call returned the id.\n` +
    `  2. STOP CITING IT — if it does not resolve, say so plainly and retract it. ` +
    `A dead URL handed to the owner is worse than no link.\n` +
    `  3. QUOTE IT — discussing a known-bad URL is fine in backticks or a code fence; ` +
    `this guard only scans unquoted prose.\n\n` +
    `Prefer recording the SOURCE FILE PATH alongside any URL: a path lets the next ` +
    `reader republish, where a bare dead URL is a dead end.`
  );
}

/**
 * The Stop decision. Returns null to allow the turn to end, or { reason }.
 * Pure so both directions are unit-testable without a transcript or a session.
 */
export function evaluateStop({ text, ledger, stopHookActive }) {
  if (stopHookActive) return null; // loop guard — never bounce twice in one turn
  const cited = extractArtifactIds(stripQuotedForScanning(text));
  if (!cited.length) return null;
  const unverified = cited.filter((id) => !ledger.has(id));
  if (!unverified.length) return null;
  return { unverified, reason: formatBlockReason(unverified) };
}

export function formatDurableBlockReason(unverified, toolName) {
  const list = unverified.map((id) => `  • ${id}`).join('\n');
  return (
    `⛔ artifact-url-delivery-guard (EI-21890940999877469): this \`${toolName}\` call ` +
    `writes an artifact URL that NO Artifact call in this session ever returned:\n\n${list}\n\n` +
    `This is a DURABLE surface. Unlike a sentence in a reply, what you write here is ` +
    `re-injected into a successor's context and inherited as settled fact — nobody ` +
    `re-checks it, because it arrives already stated. That is exactly how the FIRST ` +
    `occurrence happened (EI-19944806095285549): a dead URL was written into a work-item ` +
    `checkpoint and carried forward for hours as a delivered report that never existed.\n\n` +
    `Do ONE of these:\n` +
    `  1. VERIFY it — Artifact { action:'list' } (it should appear) or read it. Neither ` +
    `call is blocked by this guard. Then re-issue this write; it will pass.\n` +
    `  2. DROP THE URL — record the SOURCE FILE PATH instead. A path lets the next reader ` +
    `republish; a bare dead URL is a dead end, which is the whole failure being prevented.\n` +
    `  3. QUOTE IT — backticks or a code fence, if you are deliberately recording a ` +
    `known-bad URL in a post-mortem. Only unquoted text is scanned.`
  );
}

/**
 * The PreToolUse decision for a durable-surface write. Returns null to allow, or
 * { unverified, reason }. Pure, so both directions are unit-testable.
 */
export function evaluatePreToolUse({ toolName, toolInput, ledger }) {
  if (!isDurableWriteTool(toolName)) return null;
  const text = durableWriteStrings(toolName, toolInput).join('\n');
  const cited = extractArtifactIds(stripQuotedForScanning(text));
  if (!cited.length) return null;
  const unverified = cited.filter((id) => !ledger.has(id));
  if (!unverified.length) return null;
  return { unverified, reason: formatDurableBlockReason(unverified, toolName) };
}

/** Last assistant text blocks from a JSONL transcript tail. */
export function lastAssistantText(transcriptPath, readFile = readFileSync) {
  if (!transcriptPath) return '';
  let raw;
  try {
    raw = readFile(transcriptPath, 'utf8');
  } catch {
    return '';
  }
  const tail = raw.length > TRANSCRIPT_TAIL_BYTES ? raw.slice(raw.length - TRANSCRIPT_TAIL_BYTES) : raw;
  const lines = tail.split('\n');
  if (raw.length > TRANSCRIPT_TAIL_BYTES) lines.shift(); // drop a torn first line
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.type !== 'assistant') continue;
    const content = obj.message?.content;
    const texts = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
    } else if (typeof content === 'string') {
      texts.push(content);
    }
    if (texts.length) return texts.join('\n');
    // a tool-only assistant turn — keep scanning further back
  }
  return '';
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function readStdin(timeoutMs) {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        done(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (c) => {
      data += c;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function main() {
  try {
    const hook = JSON.parse(await readStdin(250));
    const event = hook.hook_event_name ?? hook.hookEventName ?? '';
    const sessionId = hook.session_id ?? hook.sessionId ?? '';
    const path = ledgerPathFor(sessionId);

    if (event === 'PostToolUse') {
      appendLedger(path, harvestLedgerIds(hook));
      process.exit(0);
    }

    if (event === 'PreToolUse') {
      const verdict = evaluatePreToolUse({
        toolName: hook.tool_name ?? hook.toolName,
        toolInput: hook.tool_input ?? hook.toolInput,
        ledger: readLedger(path),
      });
      if (verdict) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: verdict.reason,
            },
          }) + '\n',
        );
        process.stderr.write(verdict.reason + '\n');
      }
      process.exit(0);
    }

    if (event !== 'Stop') process.exit(0);

    const verdict = evaluateStop({
      text: lastAssistantText(hook.transcript_path ?? hook.transcriptPath ?? ''),
      ledger: readLedger(path),
      stopHookActive: truthy(hook.stop_hook_active ?? hook.stopHookActive),
    });
    if (verdict) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: verdict.reason }) + '\n');
    }
  } catch {
    // Fail open: a broken guard degrades to no guard, never to a blocked agent.
  }
  process.exit(0);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('artifact-url-delivery-guard.mjs');
if (invokedDirectly) main();
