#!/usr/bin/env node
// pretooluse-control-bytes-content-guard.mjs
//
// PreToolUse (apply_patch, Edit|Write|MultiEdit and MCP capability writers) BLOCKING guard against
// EI-19478121013052934 —
// a raw forbidden control byte written INTO a source file, caught today only by
// the fleet-wide green-checkpoint leg `lint:no-control-bytes`.
//
// WHY
//   Measured 2026-08-03 (su-ae348): transform-failure fixtures were built from
//   REAL captured esbuild output, which carries raw ANSI 0x1b bytes. Four ESC
//   bytes landed in packages/operator-core/lib/__tests__/test-file-router.test.ts.
//   Nothing checked. The first signal was the gate, twice (verdicts 22:37Z and
//   23:34Z, both cand 577ef744, GATE_HELD_BY=["lint:no-control-bytes"]),
//   contributing to an 8-consecutive-red streak that froze `main` for ~7h for
//   EVERY agent. The fix was mechanical the whole time: write '\x1b', which is
//   byte-identical at runtime and stays greppable/diffable.
//
//   The trap worth naming: capturing REAL tool output is exactly what makes a
//   fixture trustworthy (non-vacuous), so the property you are rightly proud of
//   is the property that imports the control bytes. Nobody types 0x1b on
//   purpose — it arrives by paste/capture, invisibly.
//
// NOT ALREADY COVERED by pretooluse-nul-byte-edit-guard.mjs, which is easy to
// mistake for coverage. That guard inspects the file ALREADY ON DISK (to dodge a
// confirmed Edit-tool corruption bug on NUL-bearing files); it is NUL(0x00)-only;
// and it deliberately excludes Write. Here the file was clean before the edit and
// the bytes were 0x1b, so it could never have fired. Disjoint jobs:
//   nul-byte-edit-guard : is the file I am about to PATCH safe to patch?
//   this guard          : is the content I am about to WRITE legal?
//
// CONTRACT
//   - Scope: Codex apply_patch, Edit | Write | MultiEdit and their MCP capability
//     equivalents, on paths inside this repo that `lint:no-control-bytes` actually scans.
//   - Policy is IMPORTED from scripts/check-no-control-bytes.mjs
//     (isForbiddenControlByte / isScannedPath) — never re-derived here. That
//     import is what makes "safe by construction" below true, and it is why the
//     lint's ALLOW_PREFIXES escape hatch keeps working with no second copy.
//   - Trigger: the INCOMING content only — apply_patch added lines, Write.content,
//     Edit.new_string, MultiEdit.edits[].new_string. Pre-existing bytes in the file
//     are NOT this guard's business (that is the sibling's), so it never blocks an
//     edit that merely touches an already-dirty file.
//   - On a hit: permissionDecision "deny" (JSON, exit 0), matching the
//     secrets-guard / content-lint / nul-byte sibling contract.
//   - FAIL-OPEN on any internal error (bad JSON, unreadable policy module,
//     stdin timeout). A bug here must never wedge an ordinary edit.
//   - `--self-test` runs the embedded cases and exits non-zero on failure.
//
// SAFE BY CONSTRUCTION: because the scanned-set and the byte policy are the
// gate's own, this hook can only refuse content that `lint:no-control-bytes`
// would already red the gate on. A "false positive" here is a change the fleet
// gate rejects anyway — so the cost of denying is a corrected escape sequence,
// while the cost of allowing is a fleet-wide red.
//
import process from 'node:process';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The hook is COPIED to ~/.papercusp/hooks/cc when installed, so its own location
// is not normally inside a checkout. Resolve the policy from the live hook cwd;
// keep the source-relative candidate only for direct in-tree execution/tests.
//
// WI-10811: it used to be a hardcoded absolute path to the staging checkout.
// green-checkpoint runs the suite from a DIFFERENT worktree (papercusp-checkpoint),
// where every incoming path fell outside that literal and the guard failed open.
// EI-21386458424818244: deriving only from import.meta.url reintroduced the SAME
// failure after installation — five parents above ~/.papercusp/hooks/cc is `/`,
// so the registered guard tried to import /scripts/check-no-control-bytes.mjs.
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (!isFileWritingTool(tool)) return done();

    const repoRoot = repoRootFrom(hook.cwd);
    if (!repoRoot) return done();
    const policy = await loadPolicy(repoRoot);
    if (!policy) return done(); // fail-open: cannot read the gate's own policy
    for (const write of incomingWrites(tool, hook.tool_input || {})) {
      const rel = toRepoRelative(write.filePath, hook.cwd, repoRoot);
      if (rel === null || !policy.isScannedPath(rel)) continue;
      const hit = firstControlByte(write.content, policy.isForbiddenControlByte);
      if (hit) return deny(rel, hit);
    }
  } catch {
    // fail-open: never wedge edits on a hook bug
  }
  done();
}

/** Every path + string this tool call would introduce into a file. */
function incomingWrites(tool, input) {
  const operation = capabilityOperation(tool) || String(tool).toLowerCase();
  if (operation === 'apply_patch') return applyPatchWrites(input);
  const filePath = input?.file_path || '';
  if (!filePath) return [];
  if (operation === 'write') return [{ filePath, content: [input.content] }];
  if (operation === 'edit') return [{ filePath, content: [input.new_string] }];
  if (operation === 'multiedit') {
    return [{ filePath, content: (input.edits || []).map((e) => (e || {}).new_string) }];
  }
  return [];
}

/** Codex may send apply_patch input as the raw patch string or wrap it under
 * `input` / `patch`. Find the first string that carries the native patch frame. */
function patchText(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.includes('*** ')) return value;
  }
  return '';
}

/** Extract only ADDED patch content, grouped by destination path.
 *
 * Context/deleted lines are deliberately ignored: they may contain the raw byte
 * an author is trying to repair. Scanning the whole patch would deny the repair
 * and make the guard an obstacle to its own remediation. */
function applyPatchWrites(input) {
  const writes = new Map();
  let currentPath = '';
  for (const line of patchText(input).split('\n')) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file) {
      currentPath = file[1].trim();
      if (!writes.has(currentPath)) writes.set(currentPath, []);
      continue;
    }
    if (/^\*\*\* Delete File: /.test(line)) {
      currentPath = '';
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && currentPath) {
      const nextPath = move[1].trim();
      const content = writes.get(currentPath) || [];
      writes.delete(currentPath);
      currentPath = nextPath;
      writes.set(currentPath, content);
      continue;
    }
    if (currentPath && line.startsWith('+') && !line.startsWith('+++')) {
      writes.get(currentPath).push(line.slice(1) + '\n');
    }
  }
  return [...writes].map(([filePath, content]) => ({ filePath, content }));
}

/** Native and MCP-projected file writers share the same content contract. */
function isFileWritingTool(tool) {
  const normalized = typeof tool === 'string' ? tool.toLowerCase() : '';
  return (
    normalized === 'edit' ||
    normalized === 'write' ||
    normalized === 'multiedit' ||
    normalized === 'apply_patch' ||
    capabilityOperation(tool) !== null
  );
}

/** Extract the operation from names such as mcp__papercusp-su__capability_edit. */
function capabilityOperation(tool) {
  if (typeof tool !== 'string') return null;
  const match = /(?:^|__)capability_(edit|write|multi_?edit)$/i.exec(tool);
  return match?.[1].toLowerCase().replace('_', '') ?? null;
}

/** First forbidden byte across the incoming strings, or null. Reports a CHARACTER
 *  index (what the author sees), plus a short printable excerpt for orientation. */
function firstControlByte(strings, isForbidden) {
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code > 0x1f) continue;
      if (!isForbidden(code)) continue; // TAB / LF / CR are legal
      return { code, index: i, excerpt: excerptAround(s, i) };
    }
  }
  return null;
}

function excerptAround(s, i) {
  const raw = s.slice(Math.max(0, i - 30), Math.min(s.length, i + 30));
  // Render control bytes visibly so the excerpt itself cannot smuggle one into a terminal.
  return raw.replace(/[\x00-\x1f]/g, (c) => `<0x${c.charCodeAt(0).toString(16).padStart(2, '0')}>`);
}

function repoRootFrom(cwd) {
  const candidates = [];
  if (typeof cwd === 'string' && cwd) candidates.push(resolve(cwd));
  candidates.push(SOURCE_ROOT);
  for (const candidate of candidates) {
    let dir = candidate;
    while (true) {
      if (existsSync(join(dir, 'scripts', 'check-no-control-bytes.mjs'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function toRepoRelative(filePath, cwd, repoRoot) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const absolute = resolve(typeof cwd === 'string' && cwd ? cwd : repoRoot, filePath);
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  if (!absolute.startsWith(root)) return null;
  return absolute.slice(root.length);
}

async function loadPolicy(repoRoot) {
  try {
    const mod = await import(pathToFileURL(join(repoRoot, 'scripts', 'check-no-control-bytes.mjs')).href);
    if (typeof mod.isForbiddenControlByte !== 'function') return null;
    if (typeof mod.isScannedPath !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

function deny(rel, hit) {
  const hex = `0x${hit.code.toString(16).padStart(2, '0')}`;
  const escape = `\\x${hit.code.toString(16).padStart(2, '0')}`;
  const reason =
    `🛑 control-bytes-content-guard (EI-19478121013052934): this edit would write a raw ` +
    `control byte ${hex} into ${rel} (at character ${hit.index} of the new content).\n\n` +
    `\`lint:no-control-bytes\` is a GREEN-CHECKPOINT leg, so this exact byte reds the ` +
    `fleet-wide release gate and freezes \`main\` for EVERY agent — typically an hour ` +
    `later, in someone else's triage queue. It already cost ~7h of gate red once.\n\n` +
    `Near the byte:\n  ${hit.excerpt}\n\n` +
    `FIX: write it as the ESCAPE \`${escape}\` instead of a raw byte. The runtime string is ` +
    `BYTE-IDENTICAL, so nothing about your test or fixture weakens — the source just stays ` +
    `greppable and diffable (a raw control byte makes ripgrep treat the file as binary and ` +
    `skip it silently; a NUL additionally makes git diff render it binary, so review goes ` +
    `blind too).\n\n` +
    `⚠ APPLY THE FIX WITH \`Write\`, NOT \`Edit\` (learned the hard way on WI-9059). \`Read\` ` +
    `NORMALISES control bytes away, so against an already-raw file an Edit's old_string never ` +
    `matches — and writing back what Read displayed SILENTLY DELETES the escapes, leaving a ` +
    `test that no longer tests ANSI parsing but still passes green. Compose the corrected ` +
    `content with explicit \`${escape}\` escapes and \`Write\` the whole file.\n\n` +
    `⚠ Watch the backslash: '${escape}' is a real ESC at runtime, but '\\${escape}' is INERT ` +
    `four-character text. If this content is a fixture asserting on ANSI/control output, the ` +
    `double-backslash form silently makes it vacuous — still green, testing nothing. After ` +
    `fixing, assert the runtime string actually contains the control byte.\n\n` +
    `This most often arrives from CAPTURED tool output (esbuild/vitest/tsc colour codes), ` +
    `pasted straight in. That capture is exactly what makes a fixture trustworthy, so keep ` +
    `it — just escape the control bytes.\n\n` +
    `Genuinely a generated/vendored artifact rather than hand-authored source? Add a narrow ` +
    `prefix to ALLOW_PREFIXES in scripts/check-no-control-bytes.mjs WITH A REASON; this ` +
    `guard reads that same list, so one entry covers both.`;
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

async function selfTest() {
  const repoRoot = repoRootFrom(process.cwd());
  const policy = repoRoot ? await loadPolicy(repoRoot) : null;
  if (!policy) {
    process.stdout.write('FAIL — could not import the gate policy module\n');
    process.exit(1);
  }
  const { isForbiddenControlByte, isScannedPath } = policy;
  const ESC = String.fromCharCode(0x1b);
  const NUL = String.fromCharCode(0x00);

  const cases = [
    // --- the real incident ---
    {
      name: 'ESC 0x1b from captured esbuild output (the EI-19478121013052934 case)',
      tool: 'Edit',
      rel: 'packages/operator-core/lib/__tests__/test-file-router.test.ts',
      strings: [`'${ESC}[31mError: Transform failed${ESC}[39m'`],
      expectDeny: true,
    },
    // --- the escaped fix must be accepted (else the guard is unfixable) ---
    {
      name: 'the prescribed escape fix is ACCEPTED',
      tool: 'Edit',
      rel: 'packages/operator-core/lib/__tests__/test-file-router.test.ts',
      strings: ["'\\x1b[31mError: Transform failed\\x1b[39m'"],
      expectDeny: false,
    },
    // --- legal whitespace must never trip it ---
    {
      name: 'TAB / LF / CR are legal',
      tool: 'Write',
      rel: 'scripts/x.mjs',
      strings: ['const a = 1;\n\tconst b = 2;\r\n'],
      expectDeny: false,
    },
    { name: 'NUL is caught too', tool: 'Write', rel: 'scripts/x.mjs', strings: [`a${NUL}b`], expectDeny: true },
    // --- tool coverage: Write is IN scope here (unlike the nul-byte sibling) ---
    { name: 'Write is in scope', tool: 'Write', rel: 'libs/x.ts', strings: [`x${ESC}y`], expectDeny: true },
    {
      name: 'MultiEdit scans EVERY edit, not just the first',
      tool: 'MultiEdit',
      rel: 'libs/x.ts',
      strings: ['clean', `dirty${ESC}`],
      expectDeny: true,
    },
    // --- scoping comes from the gate's own policy ---
    { name: 'non-source extension is out of scope', tool: 'Write', rel: 'x.bin', strings: [`a${ESC}b`], expectDeny: false },
    {
      name: 'ALLOW_PREFIXES artifact is out of scope',
      tool: 'Write',
      rel: 'papercusp-desktop/src-tauri/env-sidecars/serve.mjs',
      strings: [`a${ESC}b`],
      expectDeny: false,
    },
    // --- robustness ---
    { name: 'missing new_string does not throw', tool: 'Edit', rel: 'libs/x.ts', strings: [undefined], expectDeny: false },
  ];

  let failed = false;
  for (const c of cases) {
    let denied = false;
    try {
      denied = isScannedPath(c.rel) && firstControlByte(c.strings, isForbiddenControlByte) !== null;
    } catch {
      denied = false;
    }
    const ok = denied === c.expectDeny;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} — ${c.name}\n`);
  }

  // Falsifiability control: a deliberately-wrong policy (nothing forbidden) must
  // FAIL to catch the real incident. Without this, every case above could pass
  // while the detector is inert.
  const inert = firstControlByte([`x${ESC}y`], () => false);
  const controlOk = inert === null;
  if (!controlOk) failed = true;
  process.stdout.write(`${controlOk ? 'ok' : 'FAIL'} — control: an inert policy catches nothing (proves the cases above are load-bearing)\n`);

  process.exit(failed ? 1 : 0);
}
