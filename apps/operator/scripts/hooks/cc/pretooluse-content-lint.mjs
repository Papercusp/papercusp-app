#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs
//
// PreToolUse (Edit|Write|MultiEdit) ADVISORY content-lint — git-sync-dx-hardening-2026-06-17 P-013.
//
// WI-5543: previously lived at repo-root scripts/cc-hooks/ and was never wired into
// CC_HOOK_FILES / mergeClaudeHookSettings / install-standalone-mcp.sh (same orphaned-dir
// shape as EI-16981's guard-operator-desktop.mjs) — its curly-quote advisory never fired.
// Moved here + wired below.
//
// TWO RULES, SAME REASON: a cheap check at EDIT time beats the same check hours later.
//
// RULE 1 — curly/"smart" quotes in CODE position (.ts/.tsx)
//   The git-sync content-guard quarantines a .ts/.tsx file containing a curly quote in CODE
//   position (a HARD tsc/esbuild parse failure) only AFTER commit — feedback the author sees
//   ~10-50 min later, buried in coord.
//
// RULE 2 — the IDENTITY-LEAK FAMILY, all three classes (EI-18670296139788697,
//   EI-18759401203875869), any text file. Each class has a green-checkpoint lint leg, so ONE
//   line of any of them REDS THE GATE and freezes `main` for everyone:
//     class 1  `[owner:<name> …]` / `OWNER MANDATE (<Name>, …)`  → lint:no-owner-name-tags
//     class 2  a hardcoded `/home/<user>/…` path                 → lint:no-box-identity
//     class 3  this box's bare git name/email, hostname, account → lint:no-identity-literals
//
//   Class 1 alone cost 4h10m with 41 commits buffered on 2026-07-26 (20 findings, 10 files, all
//   authored that day), which is why it got edit-time coverage first. Classes 2 and 3 stayed
//   gate-only — and then cost FIVE consecutive red gates and 60 stranded commits on 2026-07-27
//   over a single `/home/<user>/CLAUDE.md` written into one documentation file, with every one of
//   40,469 tests passing. The cheapest possible detector (a string match) was reachable only from
//   the most expensive and most shared mechanism in the repo, ~20 minutes later, for the whole
//   fleet. All three classes now run HERE, in the author's own turn, while the fix is one word.
//
//   WHY NOT IN `npm run test:affected` INSTEAD (the obvious-looking alternative — do not "fix"
//   this by moving it there): those lints scan a FILE SET, and on this shared tree no file set
//   available to a local runner is the caller's own work. affected-tests.mjs derives its changed
//   set from `git diff origin/main...HEAD` plus every uncommitted edit in the tree, so with `main`
//   behind it is the whole fleet's recent work — agent B's routine check would red on a leak agent
//   A committed hours ago. Un-actionable, mis-attributed, and it teaches agents to distrust the one
//   check they actually run. This hook has no such problem: it lints the CONTENT BEING WRITTEN, so
//   it is author-scoped by construction. (`lint:tsc --mine` hits the same wall and documents it.)
//
//   The matchers are IMPORTED from the repo's scripts/lib/identity-leak-patterns.mjs — the same
//   module all three check-no-*.mjs gate lints use — resolved by walking up from the edited
//   file. That indirection is deliberate: this hook runs from an INSTALLED copy in
//   ~/.papercusp/hooks/cc/, so an inlined copy of the patterns would drift from the gate and
//   the advisory would start green-lighting what the gate later rejects. Importing from the
//   tree being edited makes divergence impossible. Every matcher is called behind a
//   `typeof === 'function'` probe so an older installed hook against a newer tree — or this hook
//   against a checkout predating a class — stays silent instead of throwing.
//
// CONTRACT (advisory — NEVER blocks, FAIL-OPEN)
//   - On a hit: prints additionalContext (model-facing) + exit 0 (the edit PROCEEDS).
//   - FAIL-OPEN: any error / timeout / missing module -> exit 0, silent. A bug here must NEVER
//     block an edit; the green-checkpoint lints + post-commit content-guard remain the real
//     backstops. Blocking would also be the wrong trade fleet-wide: a false positive would
//     wedge every agent's edits, and this class is trivially fixable once SEEN.
//   - FAST: a file with no curly-quote byte never loads `typescript`; the identity matcher
//     applies its own cheap whole-text pre-filter before scanning.
//
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CURLY = /[‘’“”]/;
const CURLY_G = /[‘’“”]/g;
const SMART_LABEL = { '‘': 'U+2018 ‘', '’': 'U+2019 ’', '“': 'U+201C “', '”': 'U+201D ”' };

/** How far up from the edited file to look for the repo that owns the detector. */
const MAX_REPO_WALK = 12;

main();

async function main() {
  const notes = [];
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    const input = hook.tool_input || {};
    const filePath = input.file_path || '';
    if (!filePath) return done();

    const content = extractContent(tool, input);
    if (!content) return done();

    // RULE 3 — SQL-comment backtick. FIRST and BLOCKING: rules 1/2 are advisories about a
    // gate red later, this one is about the fleet's staging host failing to build the moment
    // the file is saved. Fail-open like the others — a guard that cannot load must never
    // wedge every edit on the box.
    try {
      const denyReason = await checkSqlCommentBacktick(filePath, content, tool, input);
      if (denyReason) denyEdit(denyReason);
    } catch {
      /* fail-open */
    }

    // RULE 2 — identity leaks. Any text file: a named tag leaks the same from .md as from .ts.
    try {
      const note = await checkIdentityLeaks(filePath, content);
      if (note) notes.push(note);
    } catch {
      /* fail-open: never let the identity check block an edit */
    }

    // RULE 1 — curly quotes in code position. .ts/.tsx only, and only when one is present.
    try {
      if (/\.tsx?$/.test(filePath) && CURLY.test(content)) {
        const mod = await import('typescript');
        const ts = mod.default ?? mod;
        const hits = findCodePositionCurlyQuotes(ts, filePath, content);
        if (hits.length) notes.push(curlyNote(filePath, hits));
      }
    } catch {
      /* fail-open */
    }

    if (notes.length) emit(notes.join('\n\n'));
  } catch {
    // fall through to silent allow (fail-open)
  }
  done();
}

function extractContent(tool, input) {
  if (tool === 'Write') return input.content || '';
  if (tool === 'Edit') return input.new_string || '';
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => e && e.new_string).filter(Boolean).join('\n');
  }
  return '';
}

/**
 * Resolve the identity-leak detector from the repo that CONTAINS the edited file, so this
 * installed hook always runs the same matcher as the gate lint. Returns null (silent) outside
 * a repo that has it — e.g. editing a file in an unrelated project.
 */
async function loadIdentityDetector(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < MAX_REPO_WALK; i++) {
    const candidate = path.join(dir, 'scripts', 'lib', 'identity-leak-patterns.mjs');
    if (existsSync(candidate)) {
      return { mod: await import(pathToFileURL(candidate).href), repoRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The shared consequence paragraph. Every class has the same one, and stating it is most of the
 * advisory's value: an author who knows a one-word edit freezes `main` fixes it in that turn.
 */
const GATE_CONSEQUENCE =
  'This is SHIPPED SOURCE. Left in, it reds the green-checkpoint identity-lint leg the tick it ' +
  'lands and FREEZES `main` for the whole fleet until someone hunts it down — the 2026-07-26 ' +
  'instance cost 4h10m and 41 buffered commits, and the 2026-07-27 one cost five consecutive red ' +
  'gates and 60 stranded commits over a single hardcoded home path in a doc. Fix it now, while it ' +
  'is one word.';

/**
 * Render the offending TEXT, never a line number: for an Edit we only see the incoming fragment,
 * so any line number computed here would be wrong relative to the real file.
 */
function renderHits(leaks, label) {
  const shown = leaks.slice(0, 4).map((f) => `    ${label(f)}  in: ${f.text}`).join('\n');
  return leaks.length > 4 ? `${shown}\n    … and ${leaks.length - 4} more` : shown;
}

/**
 * Run every identity-leak class the resolved detector module offers against this edit's content.
 * Each class is independently guarded and independently fail-open, so a module that predates a
 * class — or one whose matcher throws — silently contributes nothing rather than suppressing the
 * others. Returns the joined advisory text, or null when everything is clean.
 */
async function checkIdentityLeaks(filePath, content) {
  const detector = await loadIdentityDetector(filePath);
  if (!detector) return null;
  const { mod, repoRoot } = detector;

  // Skip the same paths the gate skips: on a CARRY surface (work items, plans, .papercusp/)
  // the named form is CORRECT, and nagging there teaches agents to ignore this advisory.
  const rel = path.relative(repoRoot, path.resolve(filePath)).split(path.sep).join('/');
  const skipped = typeof mod.isSkippedPath === 'function' ? mod.isSkippedPath(rel) : false;
  const where = `this edit to ${path.basename(filePath)} (tracked as ${rel})`;
  const notes = [];

  // CLASS 1 — named owner-provenance tags.
  try {
    if (!skipped && typeof mod.findOwnerNameLeaks === 'function') {
      const leaks = mod.findOwnerNameLeaks(content);
      if (leaks.length) {
        const label = typeof mod.renderLeak === 'function' ? mod.renderLeak : (f) => `(${f.name})`;
        const fix = typeof mod.FIX_HINT === 'string' ? mod.FIX_HINT : 'Strip the name; keep the date.';
        notes.push(
          `⚠️ identity-leak (EI-18670296139788697): ${leaks.length} named owner-provenance tag(s) in ` +
            `${where}.\n${renderHits(leaks, label)}\n\n${GATE_CONSEQUENCE}\n\n${fix}\n` +
            `(Advisory — the edit proceeds.)`,
        );
      }
    }
  } catch {
    /* fail-open per class */
  }

  // CLASS 2 — hardcoded home paths. Machine-agnostic: a path shape, not a value.
  try {
    if (!skipped && typeof mod.findBoxIdentityPaths === 'function') {
      const leaks = mod.findBoxIdentityPaths(content);
      if (leaks.length) {
        const fix =
          typeof mod.BOX_IDENTITY_FIX_HINT === 'string'
            ? mod.BOX_IDENTITY_FIX_HINT
            : 'Derive the path (os.homedir() / "$HOME" / %h) instead of hardcoding it.';
        notes.push(
          `⚠️ identity-leak (EI-18759401203875869): ${leaks.length} hardcoded home path(s) in ` +
            `${where}.\n${renderHits(leaks, (f) => `(user "${f.user}")`)}\n\n` +
            `A hardcoded home path is ALSO simply wrong on every machine but this one, so this is ` +
            `not only a privacy rail. ${GATE_CONSEQUENCE}\n\n${fix}\n(Advisory — the edit proceeds.)`,
        );
      }
    }
  } catch {
    /* fail-open per class */
  }

  // CLASS 3 — this box's bare identity literals (git name/email, hostname, OS account). Unlike
  // class 2 this must resolve what "this box" IS at run time, exactly as the release audit does —
  // two `git config --get` calls, which is noise next to this hook's own process spawn. It has its
  // OWN skip predicate (a wider path set than its siblings), so it is computed separately.
  try {
    const skippedForLiterals =
      typeof mod.isSkippedPathForIdentityLiterals === 'function'
        ? mod.isSkippedPathForIdentityLiterals(rel)
        : skipped;
    if (
      !skippedForLiterals &&
      typeof mod.findIdentityLiterals === "function" &&
      typeof mod.resolveIdentityLiteralScopes === "function"
    ) {
      const scopes = mod.resolveIdentityLiteralScopes();
      const ownerScoped =
        typeof mod.isSidecarCopiedIdentityPath === "function" &&
        mod.isSidecarCopiedIdentityPath(rel);
      const entries = Object.entries(ownerScoped ? scopes.all : scopes.box);
      const vendor =
        typeof mod.isVendorPath === "function" ? mod.isVendorPath(rel) : false;
      const leaks = mod.findIdentityLiterals(content, entries, { vendor });
      if (leaks.length) {
        const fix =
          typeof mod.IDENTITY_LITERAL_FIX_HINT === "string"
            ? mod.IDENTITY_LITERAL_FIX_HINT
            : "Remove the literal — never add an exception to make the build pass.";
        notes.push(
          `⚠️ identity-leak (EI-18759401203875869): ${leaks.length} bare build-box identity ` +
            `literal(s) in ${where}.\n${renderHits(leaks, (f) => `[${f.key}]`)}\n\n` +
            `${GATE_CONSEQUENCE}\n\n${fix}\n(Advisory — the edit proceeds.)`,
        );
      }
    }
  } catch {
    /* fail-open per class */
  }

  return notes.length ? notes.join('\n\n') : null;
}

// Ported from packages/operator-core/lib/content-lint/smart-quotes.ts (kept in sync in spirit):
// flag a curly quote ONLY when the TS parser emits a syntactic diagnostic at (or just after)
// its offset — i.e. it is genuinely in code position. Curly quotes in strings/comments/JSX
// text parse cleanly and are NOT flagged (zero false positives).
function findCodePositionCurlyQuotes(ts, fileName, text) {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind);
  const diags = sf.parseDiagnostics ?? [];
  const diagStarts = new Set();
  for (const d of diags) {
    if (typeof d.start === 'number') diagStarts.add(d.start);
  }
  const hits = [];
  for (const m of text.matchAll(CURLY_G)) {
    const offset = m.index;
    if (diagStarts.has(offset) || diagStarts.has(offset + 1)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(offset);
      hits.push({ line: line + 1, col: character + 1, ch: m[0] });
    }
  }
  return hits;
}

function curlyNote(filePath, hits) {
  const base = filePath.split(/[/\\]/).pop();
  const where = hits
    .slice(0, 5)
    .map((h) => `line ${h.line}:${h.col} ${SMART_LABEL[h.ch] ?? h.ch}`)
    .join(', ');
  return (
    `⚠️ content-lint (P-013): ${hits.length} curly/"smart" quote(s) in CODE position in ${base} ` +
    `(${where}${hits.length > 5 ? ', …' : ''}). These are a HARD tsc/esbuild parse failure — the ` +
    `git-sync content-guard WILL quarantine this file after commit. Replace each curly quote with a ` +
    `straight ' or " before committing. (Advisory — the edit proceeds.)`
  );
}

function emit(msg) {
  try {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg } }) + '\n',
    );
  } catch {
    /* ignore */
  }
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

// ── RULE 3 — backtick-quoted identifier inside a SQL comment (BLOCKING) ──────
//
// EI-19457273276133433. Unlike rules 1 and 2 this one DENIES the edit, because
// its blast radius is not "a red gate later" but "the whole fleet's staging host
// is down NOW": :3170 bundles the WORKING TREE, so the poisoning is immediate on
// SAVE. On 2026-08-03 a single such backtick crash-looped papercup-staging-api 6x
// until systemd gave up. Every pre-existing path that runs this detector (CI, the
// git-sync content guard, green-checkpoint) fires at COMMIT time or later — i.e.
// strictly after the damage. This is the only enforcement point that precedes it.
//
// The predicate is NOT reimplemented here: it is imported from
// scripts/lib/sql-comment-backtick-scan.mjs, the same module the TypeScript
// detector's tree is pinned to by an equivalence test. Reimplementing it is what
// D-003 forbids, and the smart-quotes rule above is already a hand-port "kept in
// sync in spirit" — the drift this import exists to avoid.

/** Locate the shared scanner by walking up from the edited file (as loadIdentityDetector does). */
async function loadSqlBacktickScanner(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  for (let i = 0; i < MAX_REPO_WALK; i++) {
    const candidate = path.join(dir, 'scripts', 'lib', 'sql-comment-backtick-scan.mjs');
    if (existsSync(candidate)) {
      return { mod: await import(pathToFileURL(candidate).href), repoRoot: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The text the FILE WILL HOLD once this edit lands — NOT the fragment in isolation.
 *
 * WHY THIS EXISTS (EI-19492748262630855). The shared scanner opens with
 * `if (!USES_SQL_TAG.test(text) && !HAS_RAW_DDL.test(text)) return null;`. An Edit that
 * inserts a comment into an ALREADY-EXISTING sql`...` template carries neither marker in
 * its `new_string` — the opener sits elsewhere in the file (65 lines above the offending
 * line in the founding incident). So scanning the fragment returned null for EVERY such
 * edit, and this rule was inert against the single most common way the defect is written.
 * That is not hypothetical: the guard shipped 2026-08-03T14:34-04:00 and the class still
 * took papercup-staging-api down at 2026-08-04T02:03:50Z, 7.4h later.
 *
 * Reconstructing the resulting file gives the predicate the context its gate requires, and
 * makes the reported line/col REAL file coordinates instead of fragment-relative ones.
 *
 * Best-effort by construction — this runs in a fail-open guard, so it must never throw and
 * never wedge an edit: an unreadable file (a NEW file) degrades to the fragment, and an
 * `old_string` that does not appear (a stale edit the tool itself will reject) degrades to
 * base+fragment, which still carries the file's sql-tag context. Both degrade toward
 * CATCHING rather than missing.
 */
function resultingFileText(tool, input, filePath, fragment) {
  if (tool === 'Write') return input.content || ''; // already the whole file
  let base;
  try {
    base = readFileSync(filePath, 'utf8');
  } catch {
    return fragment; // new file — the fragment IS the file
  }
  const applyOne = (text, e) => {
    const oldS = e && typeof e.old_string === 'string' ? e.old_string : '';
    const newS = e && typeof e.new_string === 'string' ? e.new_string : '';
    if (!oldS) return text;
    const at = text.indexOf(oldS);
    // Not found ⇒ keep the file's context AND the incoming bytes, so a violation the tool
    // is about to write is still seen. Missing it is the expensive direction.
    return at === -1 ? `${text}\n${newS}` : text.slice(0, at) + newS + text.slice(at + oldS.length);
  };
  if (tool === 'Edit') return applyOne(base, input);
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.reduce(applyOne, base);
  return fragment;
}

/**
 * @returns {Promise<string|null>} a deny reason, or null to allow.
 */
async function checkSqlCommentBacktick(filePath, content, tool, input) {
  // Cheap byte pre-filter, deliberately still on the FRAGMENT: only an edit that itself
  // introduces a backtick beside a `--` marker can introduce this defect, so unrelated
  // edits stay free AND are never blamed for a pre-existing violation elsewhere in the file.
  if (!content.includes('`') || !/(?:^|\s)--\s/.test(content)) return null;

  const loaded = await loadSqlBacktickScanner(filePath);
  if (!loaded) return null;
  const { mod, repoRoot } = loaded;
  if (typeof mod.findSqlCommentBacktick !== 'function') return null;

  const rel = path.relative(repoRoot, path.resolve(filePath)).split(path.sep).join('/');
  if (typeof mod.sqlCommentBacktickScopeMatches === 'function' && !mod.sqlCommentBacktickScopeMatches(rel)) {
    return null;
  }

  // Scan the RESULTING FILE, not the fragment — see resultingFileText above.
  const scanned = resultingFileText(tool, input, filePath, content);
  const hit = mod.findSqlCommentBacktick(rel, scanned);
  if (!hit) return null;

  return (
    `BLOCKED — backtick-quoted identifier inside a SQL comment in ${path.basename(filePath)} ` +
    `at line ${hit.line}:${hit.col} (${hit.backticks} unescaped backticks).\n\n` +
    `  ${hit.text}\n\n` +
    `That backtick ENDS the enclosing template literal. This is blocked at edit time rather ` +
    `than reported later because :3170 bundles the WORKING TREE: the moment this file is ` +
    `saved, the fleet's staging host fails to BUILD and crash-loops for everyone ` +
    `(EI-19457273276133433 — it did exactly that on 2026-08-03, 6 restarts until systemd gave up). ` +
    `Every other guard for this class runs at commit time, which is strictly too late.\n\n` +
    `Fix: rephrase the comment without backticks — write the 'closed_ts' column with straight ` +
    `quotes rather than backtick-quoting the name.`
  );
}

function denyEdit(reason) {
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
