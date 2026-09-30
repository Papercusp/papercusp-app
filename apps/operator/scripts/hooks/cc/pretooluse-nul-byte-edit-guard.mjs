#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-nul-byte-edit-guard.mjs
//
// PreToolUse (Edit|MultiEdit) BLOCKING guard against EI-18896033546676518 —
// the CLI's built-in Edit tool asserts "The file has been updated
// successfully" while writing a DIFFERENT byte than requested, on files
// containing a raw NUL (0x00) byte.
//
// WHY
//   Repro (2026-07-28, su-3ff0da85): `libs/generic/sync/src/persisted-cache.ts`
//   had a literal NUL byte inside a string literal. `Read` renders it as a
//   SPACE, so an Edit whose old_string was built from what Read showed matched
//   at the wrong byte. Edit reported success; the on-disk byte at that offset
//   was silently rewritten to 0x1F (unit separator) — NOT deleted, NOT the
//   requested change. File length was unchanged (a corrupted byte, not a
//   dropped one), and every SUBSEQUENT Edit against either rendering then
//   failed "String to replace not found", leaving the file un-editable via
//   the tool. The failure is undetectable from the tool's own success message
//   — only a byte-level re-read after the fact would have caught it.
//
//   This hook cannot fix the Edit tool itself (it is part of the closed CLI,
//   not this repo) — it implements the item's proposed "correct state (b)":
//   REFUSE an edit the tool cannot be trusted to round-trip losslessly,
//   before it silently corrupts anything, and point at the established
//   escape-sequence convention that avoids the whole class going forward
//   (see the memory note this item's own recall carried: "Write NUL
//   delimiters as the `\x00` escape; the runtime string is byte-identical").
//
// CONTRACT
//   - Scope: Edit / MultiEdit only. Write is NOT blocked — a whole-file
//     overwrite is not a find/replace patch against stale rendered content,
//     so it is not known to share this failure mode, and it is the sanctioned
//     recovery path this guard points callers at.
//   - Trigger: the file ALREADY ON DISK (not the tool_input) contains a raw
//     NUL byte (0x00) ANYWHERE. Scoped to the whole file, not just the
//     old_string span — Read already mis-renders NUL as a space, so an agent
//     cannot reliably tell whether its old_string even covers the NUL's real
//     offset; refusing the whole file is the only sound floor.
//   - On a hit: permissionDecision "deny" (JSON, exit 0) — matches the
//     secrets-guard / content-lint sibling hooks' contract exactly.
//   - FAIL-OPEN on any internal error (missing file, read error, bad JSON,
//     stdin timeout) — a bug here must never wedge an ordinary edit.
//   - `--self-test` runs the embedded cases (no stdin needed) and exits
//     non-zero on failure; mirrors pretooluse-secrets-guard.mjs's own flag.
//
import { readFileSync } from 'node:fs';
import process from 'node:process';

const NUL = 0x00;

main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const offset = findNulByte(filePath);
    if (offset !== null) return deny(filePath, offset);
  } catch {
    // fail-open: never wedge edits on a hook bug
  }
  done();
}

/** Returns the byte OFFSET of the first NUL byte in `filePath`, or null when
 *  the file is absent/unreadable (fail-open — never denies on our own inability
 *  to read the target) or genuinely contains none. */
function findNulByte(filePath) {
  let buf;
  try {
    buf = readFileSync(filePath);
  } catch {
    return null;
  }
  const idx = buf.indexOf(NUL);
  return idx === -1 ? null : idx;
}

function deny(filePath, offset) {
  const base = filePath.split(/[/\\]/).pop();
  const reason =
    `🛑 nul-byte-edit-guard (EI-18896033546676518): ${base} contains a raw NUL byte ` +
    `(0x00) at file offset ${offset}. The Edit/MultiEdit tool has a CONFIRMED bug on ` +
    `files like this: it renders the NUL as a space, can match the WRONG byte, report ` +
    `"updated successfully", and silently write a different byte than requested (once ` +
    `observed: it wrote 0x1F where a NUL should have been deleted) — with no way to ` +
    `detect the corruption except a byte-level re-read.\n\n` +
    `Do NOT retry with a different old_string rendering — that is how the corruption ` +
    `happened the first time. Instead:\n` +
    `1. Inspect the real bytes first, e.g. ` +
    `\`capability:bash "python3 -c \\"raw=open('${filePath}','rb').read(); print(raw.count(b'\\\\x00'), raw.find(b'\\\\x00'))\\""\`.\n` +
    `2. A NUL byte almost never belongs in source as a literal control character — the ` +
    `established fix is to replace it with the TEXT-SAFE escape sequence (\`\\x00\` in a ` +
    `JS/TS string literal, \`\\u001f\` etc. for other control bytes) — byte-identical at ` +
    `runtime, and no longer invisible to Read/Edit.\n` +
    `3. Apply that fix via \`Write\` (a full-file overwrite, not a find/replace patch — ` +
    `not known to share this failure mode) with the corrected content, never another Edit ` +
    `against this file until it is NUL-free.`;
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
    process.stderr.write(reason + '\n');
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
  // Self-contained: no real stdin/file plumbing, just the pure logic.
  const cases = [
    { name: 'no NUL byte', buf: Buffer.from('const x = 1;\n'), expectDeny: false },
    { name: 'NUL byte present', buf: Buffer.from('a\x00b'), expectDeny: true },
    { name: 'empty buffer', buf: Buffer.from(''), expectDeny: false },
  ];
  let failed = false;
  for (const c of cases) {
    const idx = c.buf.indexOf(NUL);
    const denied = idx !== -1;
    const ok = denied === c.expectDeny;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} — ${c.name}\n`);
  }
  process.exit(failed ? 1 : 0);
}
