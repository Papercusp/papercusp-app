#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-write-overwrite-guard.mjs
//
// PreToolUse (Write) overwrite guard against EI-19966323166806405 and
// EI-21263341660938734 — the CLI's
// built-in Write tool's own description states an overwrite of an existing,
// un-Read file "will fail", but on 2026-08-09 (su-e0359276) it did not: it
// silently replaced a 350-line shared module with 123 lines of unrelated new
// content, reported "has been updated successfully" (worded identically to a
// routine, intended overwrite — the ONLY distinguishing signal vs a genuine
// new-file "File created successfully at: <path>" was one skimmable word),
// clobbered another plan's in-flight file, and crash-looped shared :3170
// staging for ~13 minutes before the mismatch was traced. Recoverable only
// because git-sync happened to have committed the victim file minutes
// earlier — a clobber landing inside the sweep window, on work not yet
// committed, would have been unrecoverable (kopia backs up ~14KB of
// workspace-state, not code; see CLAUDE.md's destructive-git-op warning).
//
// WHY ADVISORY, NOT A HARD DENY (read before extending this to `deny`)
//   The native Write tool's own read-tracking is internal to the closed CLI,
//   not this repo — this hook cannot fix THAT guard. What it CAN do is
//   independently reconstruct "was this path Read in this session" from the
//   session transcript and say so loudly before the write lands. It does
//   NOT hard-deny, because the only read signal it can see here is a
//   Read/Edit/MultiEdit/Write tool_use recorded in the Claude Code
//   transcript with a matching file_path — a file a caller genuinely
//   inspected via a different surface (an MCP `capability:*` read path, a
//   Grep that happened to show the whole file, a Codex/OMP-native
//   equivalent this hook doesn't recognize) would read as "unread" here.
//   A false NEGATIVE (silently missing a real prior inspection) only costs
//   an extra warning the agent can act on and dismiss; a false POSITIVE
//   under a hard `deny` would wedge a legitimate Write fleet-wide — the
//   wrong trade, matching the same reasoning pretooluse-content-lint.mjs
//   documents for its own advisory-only posture on a shared tree.
//
// TRIGGER: `Write` targets a path that (a) already exists on disk with
// non-trivial content, AND (b) has NO prior Read / Edit / MultiEdit / Write
// tool_use recorded against that same absolute path earlier in THIS
// session's transcript (self-excluded by tool_use_id).
//
// CONTRACT (targeted deny + advisory fallback, FAIL-OPEN)
//   - A high-confidence destructive signature is denied even after a prior
//     Read: a substantial existing file collapsing below 10% of its original
//     byte size, or a JSON document replacing a source-code file. These are
//     payload/path invariants and therefore do not depend on transcript shape.
//   - Other unread-file overwrites remain advisory: additionalContext
//     (model-facing), no permissionDecision, and the Write proceeds.
//   - FAIL-OPEN on any error / missing transcript / oversized transcript /
//     unparseable line: exit 0, silent. A bug here must never wedge an
//     ordinary Write.
//   - `--self-test` runs the embedded cases (no stdin/session needed).

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Transcripts here are session-lifetime JSONL; refuse to scan anything
// absurd rather than stall a tool call. 200MB is generous for even a very
// long-running warm-carry session.
const MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
const READ_LIKE_TOOL_NAMES = new Set(['Read', 'Edit', 'MultiEdit', 'Write']);
const MIN_PROTECTED_BYTES = 1024;
const MAX_REPLACEMENT_RATIO = 0.1;
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.go',
  '.java',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.ts',
  '.tsx',
]);
const DESTRUCTIVE_WRITE_BYPASS_ENV = 'PAPERCUSP_ALLOW_DESTRUCTIVE_WRITE';

main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    if ((hook.tool_name || '') !== 'Write') return done();

    const filePath = (hook.tool_input || {}).file_path;
    if (typeof filePath !== 'string' || !filePath) return done();

    const cwd = typeof hook.cwd === 'string' && hook.cwd ? hook.cwd : process.cwd();
    const abs = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

    const existing = statExisting(abs);
    if (!existing || existing.size === 0) return done(); // new file, or trivial — nothing to protect

    const content = (hook.tool_input || {}).content;
    const destructive = destructiveWriteReason(abs, existing.size, content);
    if (destructive && process.env[DESTRUCTIVE_WRITE_BYPASS_ENV] !== '1') {
      return denyDestructive(abs, destructive);
    }

    const transcriptPath = hook.transcript_path || hook.transcriptPath;
    if (typeof transcriptPath !== 'string' || !transcriptPath || !existsSync(transcriptPath)) {
      return done(); // can't verify — fail open, never guess
    }

    const selfId = hook.tool_use_id || hook.toolUseId || null;
    const seen = scanTranscriptForPriorRead(transcriptPath, abs, cwd, selfId);
    if (seen === null) return done(); // unreadable/oversized/unparseable — fail open
    if (seen) return done(); // a Read/Edit/MultiEdit/Write already touched this exact path

    return warn(abs, existing);
  } catch {
    // fail-open: never wedge a Write on a hook bug
  }
  done();
}

function destructiveWriteReason(abs, existingBytes, content) {
  if (typeof content !== 'string') return null;
  const replacementBytes = Buffer.byteLength(content, 'utf8');
  const ratio = existingBytes > 0 ? replacementBytes / existingBytes : 1;
  if (existingBytes >= MIN_PROTECTED_BYTES && ratio < MAX_REPLACEMENT_RATIO) {
    return {
      kind: 'catastrophic-shrink',
      existingBytes,
      replacementBytes,
      detail: `replacement is ${(ratio * 100).toFixed(1)}% of the existing file`,
    };
  }

  if (SOURCE_EXTENSIONS.has(path.extname(abs).toLowerCase()) && parsesAsJsonDocument(content)) {
    return {
      kind: 'json-to-source',
      existingBytes,
      replacementBytes,
      detail: `replacement parses as JSON but target suffix is '${path.extname(abs)}'`,
    };
  }
  return null;
}

function parsesAsJsonDocument(content) {
  const trimmed = content.trim();
  if (!trimmed || !['{', '['].includes(trimmed[0])) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function statExisting(abs) {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

/**
 * Returns true if a Read/Edit/MultiEdit/Write tool_use targeting `abs`
 * (resolved the same way, relative to `cwd`) appears anywhere in the
 * transcript BEFORE/other-than the current call (`selfId`). Returns false
 * when the transcript parses cleanly and genuinely contains no such call.
 * Returns null (== "unknown, fail open") on any structural problem: an
 * oversized file, an unreadable file, or a transcript whose shape this
 * parser doesn't recognize at all (zero valid JSON lines).
 */
function scanTranscriptForPriorRead(transcriptPath, abs, cwd, selfId) {
  let raw;
  try {
    const st = statSync(transcriptPath);
    if (st.size > MAX_TRANSCRIPT_BYTES) return null;
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  let parsedAny = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue; // one bad line shouldn't sink the whole scan
    }
    parsedAny = true;

    const blocks = extractToolUseBlocks(entry);
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.id && selfId && block.id === selfId) continue; // never self-match
      if (!READ_LIKE_TOOL_NAMES.has(block.name)) continue;
      const candidatePath = block.input && typeof block.input.file_path === 'string' ? block.input.file_path : null;
      if (!candidatePath) continue;
      const candidateAbs = path.isAbsolute(candidatePath) ? candidatePath : path.join(cwd, candidatePath);
      if (candidateAbs === abs) return true;
    }
  }

  return parsedAny ? false : null;
}

/** Both Claude Code's native transcript shape (message.content[] blocks)
 *  and a defensive top-level fallback (some adapters flatten tool_use to
 *  the entry root) are checked — anything else yields no blocks, not an
 *  error, so an unrecognized transcript shape degrades to "found nothing"
 *  (→ null upstream via parsedAny, i.e. fail-open) rather than a false hit. */
function extractToolUseBlocks(entry) {
  const out = [];
  const content = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : null;
  if (content) {
    for (const block of content) {
      if (block && block.type === 'tool_use') out.push(block);
    }
  }
  if (entry && entry.type === 'tool_use') out.push(entry);
  return out;
}

function warn(abs, stat) {
  const base = abs.split(/[/\\]/).pop();
  let lineCount = null;
  try {
    lineCount = readFileSync(abs, 'utf8').split('\n').length;
  } catch {
    // binary or unreadable as text — byte size alone is still useful
  }
  const sizeDesc = lineCount !== null ? `${lineCount} lines, ${stat.size} bytes` : `${stat.size} bytes`;
  const reason =
    `⚠️ OVERWRITE OF AN UN-READ FILE (EI-19966323166806405): '${base}' already exists on disk ` +
    `(${sizeDesc}) and this session's transcript shows NO prior Read/Edit of it. ` +
    `Write REPLACES the entire file — if you intended to CREATE a new module and just picked a ` +
    `name that collided with something that already exists (the exact failure this guard exists ` +
    `for), you are about to silently destroy it. The tool's own success message will say ` +
    `"has been updated successfully" either way — that wording does NOT distinguish a safe ` +
    `intentional rewrite from a destructive accidental one, so do not rely on it after the fact.\n\n` +
    `Before proceeding: Read '${abs}' first and confirm this is genuinely the file you mean to ` +
    `fully replace with content you have actually reviewed. If the path was meant to be a NEW ` +
    `file, pick a different name — this one is already in use.\n\n` +
    `(This is an ADVISORY, not a block — it may be a false alarm if you inspected this file via ` +
    `a non-native read path this hook can't see. If so, proceed.)`;
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: reason,
        },
      }) + '\n',
    );
  } catch {
    /* ignore */
  }
  process.exit(0);
}

function denyDestructive(abs, finding) {
  const base = abs.split(/[/\\]/).pop();
  const reason =
    `BLOCKED DESTRUCTIVE FULL-FILE WRITE (EI-21263341660938734): '${base}' is ${finding.existingBytes} bytes, ` +
    `the proposed replacement is ${finding.replacementBytes} bytes, and ${finding.detail}. This strongly matches ` +
    `an MCP/JSON argument blob misrouted into a repository source path, which previously replaced 2128-line and ` +
    `291-line TypeScript modules without any warning. Re-check the tool target and payload; use Edit/apply_patch for ` +
    `a scoped source change. If this full replacement is genuinely intentional, re-run the session with ` +
    `${DESTRUCTIVE_WRITE_BYPASS_ENV}=1 and document why the destructive overwrite is safe.`;
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n',
    );
  } catch {
    /* ignore */
  }
  process.exit(0);
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
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

function selfTest() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'write-overwrite-guard-selftest-'));
  const cwd = tmpDir;

  const priorReadTranscript = path.join(tmpDir, 'prior-read.jsonl');
  const priorReadTarget = path.join(tmpDir, 'read-me.ts');
  writeFileSync(
    priorReadTranscript,
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: priorReadTarget } }],
      },
    }) + '\n',
  );

  const noReadTranscript = path.join(tmpDir, 'no-read.jsonl');
  writeFileSync(
    noReadTranscript,
    JSON.stringify({
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/some/other/file.ts' } }],
      },
    }) + '\n',
  );

  const emptyTranscript = path.join(tmpDir, 'empty.jsonl');
  writeFileSync(emptyTranscript, 'not json at all\n\n');

  const cases = [
    {
      name: 'prior Read of the exact path → seen (would allow silently)',
      abs: priorReadTarget,
      transcript: priorReadTranscript,
      selfId: 'toolu_99',
      expect: true,
    },
    {
      name: 'transcript mentions only a different path → unseen (would warn)',
      abs: path.join(tmpDir, 'unrelated.ts'),
      transcript: noReadTranscript,
      selfId: 'toolu_99',
      expect: false,
    },
    {
      name: 'self tool_use excluded from matching itself → unseen (would warn)',
      abs: priorReadTarget,
      transcript: priorReadTranscript,
      selfId: 'toolu_1',
      expect: false, // excluding the only match leaves nothing seen
    },
    {
      name: 'unparseable transcript → null (fail-open), not a false hit',
      abs: path.join(tmpDir, 'whatever.ts'),
      transcript: emptyTranscript,
      selfId: null,
      expectNull: true,
    },
  ];

  let failed = false;
  for (const c of cases) {
    const result = scanTranscriptForPriorRead(c.transcript, c.abs, cwd, c.selfId);
    let ok;
    if (c.expectNull) {
      ok = result === null;
    } else {
      ok = result === c.expect;
    }
    if (!ok) failed = true;
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} — ${c.name} (got ${JSON.stringify(result)})\n`);
  }

  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
