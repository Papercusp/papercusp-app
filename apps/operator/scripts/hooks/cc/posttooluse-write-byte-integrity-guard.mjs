#!/usr/bin/env node
// posttooluse-write-byte-integrity-guard.mjs
//
// PostToolUse (Write and capability:write) diagnostic for EI-21220966892195714.
//
// A full-file write has enough information to verify the result exactly: the tool
// input contains the requested string and the resulting file is available on disk.
// Compare those UTF-8 byte sequences immediately after dispatch so an encoding or
// transport layer that turns printable input into a different byte is visible while
// the author is still able to repair it. Edit/MultiEdit are deliberately excluded:
// their input is a fragment and cannot reconstruct the complete resulting file.
//
// CONTRACT
//   - Diagnostic only. PostToolUse cannot undo a completed write; report loudly via
//     additionalContext and stderr, then exit successfully.
//   - Fail open on malformed input, missing files, or any internal error. A guard
//     failure must never wedge an otherwise successful edit.
//   - Report bytes as hex and never interpolate raw control bytes into the message.
//   - `--self-test` runs the pure comparison cases without touching the worktree.
//
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();

/** Return true for native Write and MCP-projected capability:write names. */
export function isWriteTool(tool) {
  if (typeof tool !== 'string') return false;
  const normalized = tool.toLowerCase();
  return normalized === 'write' || /(?:^|__)capability_write$/.test(normalized);
}

/**
 * Resolve the exact file path the hook should inspect. Native Write and
 * capability:write both use `file_path`; relative capability paths are relative
 * to the client process' project cwd, which is also the hook's cwd.
 */
export function writePath(hook) {
  const input = hook?.tool_input;
  if (!input || typeof input.file_path !== 'string' || input.file_path.length === 0) return null;
  return resolve(input.file_path);
}

/** Compare two byte sequences and return the first mismatch, or null if equal. */
export function firstByteMismatch(expected, actual) {
  const left = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
  const right = Buffer.isBuffer(actual) ? actual : Buffer.from(actual);
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i++) {
    if (left[i] !== right[i]) {
      return { offset: i, expected: left[i], actual: right[i] };
    }
  }
  if (left.length !== right.length) {
    return { offset: limit, expected: left[limit], actual: right[limit] };
  }
  return null;
}

/**
 * Inspect one PostToolUse payload. `readFile` is injectable for unit tests and
 * is intentionally the only filesystem seam in this pure decision function.
 */
export function inspectWrite(hook, readFile = readFileSync) {
  if (!isWriteTool(hook?.tool_name)) return null;
  const input = hook?.tool_input;
  if (!input || typeof input.content !== 'string') return null;
  const filePath = writePath(hook);
  if (!filePath) return null;

  let actual;
  try {
    actual = readFile(filePath);
  } catch {
    return null;
  }

  const expected = Buffer.from(input.content, 'utf8');
  const mismatch = firstByteMismatch(expected, actual);
  if (!mismatch) return null;
  return {
    tool: hook.tool_name,
    filePath,
    expectedBytes: expected.length,
    actualBytes: actual.length,
    ...mismatch,
  };
}

function hexByte(value) {
  return value === undefined ? '<EOF>' : `0x${value.toString(16).padStart(2, '0')}`;
}

export function formatMismatch(hit) {
  return (
    `⚠ write-byte-integrity-guard (EI-21220966892195714): ${hit.tool} reported success, ` +
    `but the resulting file bytes differ from the requested UTF-8 content.\n\n` +
    `File: ${hit.filePath}\n` +
    `Expected ${hit.expectedBytes} bytes, found ${hit.actualBytes}; first difference at byte ` +
    `${hit.offset}: expected ${hexByte(hit.expected)}, found ${hexByte(hit.actual)}.\n\n` +
    `The write already landed. Re-read the file as bytes, verify the intended content, ` +
    `then repair with a full Write/capability:write and verify again. This diagnostic ` +
    `covers corruption after tool dispatch that an incoming-content guard cannot see.`
  );
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const hit = inspectWrite(hook);
    if (hit) {
      const message = formatMismatch(hit);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: message },
        }) + '\n',
      );
      process.stderr.write(message + '\n');
    }
  } catch {
    // Fail open: this hook must never disturb an edit that already completed.
  }
  process.exit(0);
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
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
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
  const clean = Buffer.from('const separator = " ";\n', 'utf8');
  if (firstByteMismatch(clean, Buffer.from(clean))) throw new Error('equal bytes reported as different');

  const expected = Buffer.from("const separator = ' ';\n", 'utf8');
  const actual = Buffer.from("const separator = '\x00';\n", 'utf8');
  const mismatch = firstByteMismatch(expected, actual);
  if (!mismatch || mismatch.expected !== 0x20 || mismatch.actual !== 0x00)
    throw new Error(`space-to-NUL mismatch was not detected: ${JSON.stringify(mismatch)}`);

  const hit = inspectWrite(
    { tool_name: 'mcp__papercusp-su__capability_write', tool_input: { file_path: 'x.ts', content: 'a b' } },
    () => Buffer.from([0x61, 0x00, 0x62]),
  );
  if (!hit || hit.expected !== 0x20 || hit.actual !== 0x00) throw new Error('capability:write case failed');

  process.stdout.write('posttooluse-write-byte-integrity-guard --self-test: all cases passed\n');
}
