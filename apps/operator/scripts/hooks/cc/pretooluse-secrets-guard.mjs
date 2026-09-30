#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-secrets-guard.mjs
//
// PreToolUse (Edit|Write|MultiEdit) BLOCKING secrets guard — su-papercusp-way-gate-2026-07-06 P-006.
//
// WHY
//   The persona's credentials row routes agents ("setup:save_key for the 4 platform provider
//   keys; ANY other secret: never into a tree file") — but a prompt is a route, not a wall.
//   A key written into a git-sync-owned shared tree is auto-committed within minutes and
//   then lives in history. This hook is the hard backstop: it DENIES the write BEFORE the
//   key-shaped string reaches a shared-tree file.
//
// Wired via mergeClaudeHookSettings (packages/operator-core/lib/desktop-
// install/papercusp-files.ts) + the install-standalone-mcp.sh sibling
// (merge_secrets_guard_hook) — KEEP THE TWO IN SYNC (knowledge-pack-loop-integrity
// sibling bug pattern, EI-16981: this hook previously lived at repo-root
// scripts/cc-hooks/ and was NEVER wired into either installer, so the deny this
// header claims never actually fired — see the fix that moved it here).
//
// CONTRACT
//   - Scope: writes whose file_path is inside a shared git-sync tree (built-in:
//     ~/papercupai-workspace/ and ~/.papercusp-workspaces/clones/; override via
//     PAPERCUSP_SECRETS_GUARD_TREES, ':'-separated prefixes). Everything else exits 0.
//   - Allowlist: PAPERCUSP_SECRETS_GUARD_ALLOW (':'-separated path substrings) for
//     legitimate secrets paths — empty by default; prefer keeping secrets OUT of trees
//     over allowlisting.
//   - On a key-shaped hit: permissionDecision "deny" (JSON, exit 0) with a reason that
//     names the papercusp way. The matched token is MASKED in the reason (never echoed).
//   - Placeholder-shaped matches (xxx / example / YOUR / redacted / ...) are exempt.
//   - FAIL-OPEN on internal errors: a bug here must never wedge every edit. The deny on a
//     genuine match is the point and is not an error path.
//   - Known limitation (by design, recorded in the plan): Bash heredoc/redirect writes are
//     not covered — this hook pairs with the persona row, it does not replace review.
//   - `--self-test` runs the embedded cases (no stdin needed) and exits non-zero on failure.
//
import { homedir } from 'node:os';
import process from 'node:process';

const HOME = process.env.HOME || homedir();
const DEFAULT_TREES = [`${HOME}/papercupai-workspace/`, `${HOME}/.papercusp-workspaces/clones/`];

// WI-6643 — THIS SET MUST COVER packages/operator-core/lib/sync/pot-git/secrets-guard.ts's
// RULES. That guard runs at PUBLISH time and, on a hit, refuses the own-head publish
// FOREVER: its baseline never advances past a refused range, so the offending blob is
// rescanned and re-refused on every later tick. Editing the file afterwards does not help
// — the bad blob is already in history. So anything the publish guard would refuse has to
// be refused HERE, at write time, while the file is still editable and nothing has been
// committed. When the two sets diverge, an author is green-lit here and the publish plane
// freezes hours later with no signal to whoever caused it (that is exactly what happened
// on 2026-07-28: `api_key:`-style fixtures in a redactor test froze the plane ~8h, because
// the generic `secret-assignment` rule below existed ONLY in the publish guard).
//
// Parity is enforced behaviourally by secrets-guard-hook-parity.test.ts, which feeds a
// shared corpus through both scanners and fails if the guard flags anything this hook
// misses. `--dump-patterns` exists for that test (this file stays import-free BY DESIGN —
// install-standalone-mcp.sh COPIES it out of the repo, so it cannot require a sibling).
// The hook may be STRICTER than the guard (it is: `sk-…` and `github_pat_…` below have no
// publish-side equivalent); it must never be laxer.
// `shared: true` ⇒ this rule mirrors a publish-guard RULE, so its suppression must mirror
// the guard's too (see findSecret). `shared: false` ⇒ hook-only, stricter than the publish
// side by design, and free to use the broad PLACEHOLDER exemption so docs and prose that
// merely cite a key prefix stay writable.
const PATTERNS = [
  { id: 'sk-key', shared: false, name: 'OpenAI/Anthropic-style key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'github-pat-fine', shared: false, name: 'GitHub fine-grained PAT (github_pat_…)', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  // Classic/app/oauth/server/refresh tokens in ONE rule, mirroring the publish guard's
  // `gh[posru]_[A-Za-z0-9]{36,255}`. The previous split rules pinned the suffix at exactly
  // {36}, so a longer token failed the trailing \b and slipped through entirely.
  { id: 'github-token', shared: true, name: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_…)', re: /\bgh[posru]_[A-Za-z0-9]{36,255}\b/g },
  // AKIA = long-lived, ASIA = temporary session credentials. ASIA was missing here.
  { id: 'aws-access-key-id', shared: true, name: 'AWS access key id (AKIA…/ASIA…)', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'slack-token', shared: true, name: 'Slack token (xox…)', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-secret-key', shared: true, name: 'Stripe live secret key (sk_live_/rk_live_…)', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'google-api-key', shared: true, name: 'Google API key (AIza…)', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { id: 'private-key-pem', shared: true, name: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/** The publish guard's ONLY carve-out for a shape match (isDocumentedExample): AWS
 *  reserves the literal `EXAMPLE` suffix for its non-functional docs keys, and a real
 *  issued key never ends in it. Shared rules may suppress on THIS and nothing else — the
 *  broad PLACEHOLDER below is wider than the guard's, and using it on a shared rule is a
 *  parity hole: a genuine token that merely CONTAINS a placeholder substring (a Slack
 *  token with `1234567890` in it — caught by secrets-guard-hook-parity.test.ts) would be
 *  allowed here and then refused forever at publish time, which is this bug exactly. */
function isDocumentedExample(id, match) {
  return id === 'aws-access-key-id' && match.endsWith('EXAMPLE');
}

// Generic rule: a secret-NAMED assignment whose value is long and high-entropy. Kept
// separate because it alone needs the entropy + placeholder gates (a bare shape match is
// judged by PLACEHOLDER below). Mirrors the publish guard's `secret-assignment` rule,
// including both gates — this is the rule whose absence caused the 2026-07-28 freeze.
const SECRET_ASSIGNMENT =
  /\b(?:secret|password|passwd|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"]?([A-Za-z0-9+/_\-]{20,})['"]?/gi;

// Min entropy (bits/char) for an assignment VALUE to count as a secret. Must match the
// publish guard's SECRET_ASSIGNMENT_MIN_ENTROPY, or the two disagree on the exact rule
// that caused this bug.
const SECRET_ASSIGNMENT_MIN_ENTROPY = 3.2;

// Placeholder markers for the assignment rule's VALUE. Mirrors the publish guard's
// PLACEHOLDER_RE (broader than the shape-match PLACEHOLDER below) so the hook suppresses
// exactly what the guard suppresses — being stricter here would block writes the publish
// plane would have accepted, which is its own kind of breakage.
const ASSIGNMENT_PLACEHOLDER =
  /your|here|goes|example|changeme|change-me|placeholder|dummy|sample|redacted|xxxx|<[a-z]|\btest\b|todo|fixme|none|null|undefined/i;

/** Shannon entropy (bits/char). Mirrors the publish guard's shannonEntropy. */
function shannonEntropy(s) {
  if (!s) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// A match that is visibly a placeholder is not a secret. AWS reserves the literal
// `EXAMPLE` suffix for its published docs keys, so `example` here also covers the
// publish guard's isDocumentedExample() carve-out.
const PLACEHOLDER = /xxx|\.\.\.|<|example|placeholder|your[-_]|redacted|1234567890/i;

main();

async function main() {
  if (process.argv.includes('--dump-patterns')) return dumpPatterns();
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    const input = hook.tool_input || {};
    const filePath = input.file_path || '';
    if (!inSharedTree(filePath) || isAllowlisted(filePath)) return done();

    const content = extractContent(tool, input);
    if (!content) return done();

    const hit = findSecret(content);
    if (hit) return deny(filePath, hit);
  } catch {
    // fail-open: never wedge edits on a hook bug
  }
  done();
}

function inSharedTree(filePath) {
  if (!filePath) return false;
  const trees = (process.env.PAPERCUSP_SECRETS_GUARD_TREES || '').split(':').filter(Boolean);
  return (trees.length ? trees : DEFAULT_TREES).some((t) => filePath.startsWith(t));
}

function isAllowlisted(filePath) {
  const allow = (process.env.PAPERCUSP_SECRETS_GUARD_ALLOW || '').split(':').filter(Boolean);
  return allow.some((a) => filePath.includes(a));
}

function extractContent(tool, input) {
  if (tool === 'Write') return input.content || '';
  if (tool === 'Edit') return input.new_string || '';
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.map((e) => e && e.new_string).filter(Boolean).join('\n');
  }
  return '';
}

function findSecret(content) {
  for (const { id, shared, name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) {
      // Shared rules mirror the publish guard's suppression exactly; hook-only rules keep
      // the broader, docs-friendly PLACEHOLDER exemption.
      if (shared ? isDocumentedExample(id, m[0]) : PLACEHOLDER.test(m[0])) continue;
      const line = content.slice(0, m.index).split('\n').length;
      return { name, masked: m[0].slice(0, 8) + '…(' + m[0].length + ' chars)', line };
    }
  }
  // Generic secret-named assignment, gated on the VALUE (group 1) exactly as the publish
  // guard gates it: high entropy AND not an obvious placeholder.
  SECRET_ASSIGNMENT.lastIndex = 0;
  for (const m of content.matchAll(SECRET_ASSIGNMENT)) {
    const value = m[1] ?? '';
    if (shannonEntropy(value) < SECRET_ASSIGNMENT_MIN_ENTROPY) continue;
    if (ASSIGNMENT_PLACEHOLDER.test(value)) continue;
    const line = content.slice(0, m.index).split('\n').length;
    return {
      name: 'secret-named assignment with a high-entropy value',
      masked: value.slice(0, 4) + '…(' + value.length + ' chars)',
      line,
    };
  }
  return null;
}

/** Emit this hook's rule inventory as JSON, for the cross-scanner parity test
 *  (secrets-guard-hook-parity.test.ts). Kept as a CLI flag rather than an export
 *  because this file is COPIED out of the repo by install-standalone-mcp.sh and
 *  must stay import-free — see the note on PATTERNS. */
function dumpPatterns() {
  const payload = {
    patterns: PATTERNS.map((p) => ({ name: p.name, source: p.re.source, flags: p.re.flags })),
    secretAssignment: { source: SECRET_ASSIGNMENT.source, flags: SECRET_ASSIGNMENT.flags },
    minEntropy: SECRET_ASSIGNMENT_MIN_ENTROPY,
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

function deny(filePath, hit) {
  const base = filePath.split(/[/\\]/).pop();
  const reason =
    `🛑 secrets-guard (P-006): ${hit.name} detected at line ${hit.line} of the content being ` +
    `written to ${base} — a shared git-sync tree file (auto-committed to history within minutes). ` +
    `Matched token: ${hit.masked}. The papercusp way: a platform provider key ` +
    `(openai/anthropic/zeroentropy/github_pat) goes to setup:save_key; ANY other secret goes in ` +
    `injected config OUTSIDE the repo — never a tree file. If this file is a legitimate secrets ` +
    `path, the owner can allowlist it via PAPERCUSP_SECRETS_GUARD_ALLOW.\n\n` +
    `⚠ If these are deliberate FIXTURES (a redaction/detection test, a documented example), do ` +
    `NOT just retry the write: the same shapes also trip the pot-git PUBLISH guard, which then ` +
    `refuses every own-head publish FOREVER — its baseline never advances past a refused range, ` +
    `so the blob is re-scanned and re-refused on every later tick, and editing the file afterwards ` +
    `does not remove it from history. Freezing the hive publish plane that way has cost hours ` +
    `more than once. Register the path FIRST, then write: ` +
    `pot_git:secrets_exemptions { action:'add', path:'<repo-relative path>', reason:'<why these ` +
    `are fixtures>' } — reachable from an ordinary workspace-scoped session as of WI-6641, no ` +
    `restart, applies on the next git-sync tick.`;
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

// ─── self-test ─────────────────────────────────────────────────────────

function selfTest() {
  const TREE = `${HOME}/papercupai-workspace/papercup/some/file.ts`;
  const OUT = `/tmp/scratch/notes.md`;
  const FAKE_SK = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
  const FAKE_GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
  const FAKE_AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const cases = [
    { name: 'real-shaped sk- key in tree file → DENY', path: TREE, content: `const k = "${FAKE_SK}";`, expectDeny: true },
    { name: 'ghp_ token in tree file → DENY', path: TREE, content: `token: ${FAKE_GHP}`, expectDeny: true },
    { name: 'AKIA id in tree file → DENY', path: TREE, content: `aws_access_key_id=${FAKE_AKIA}`, expectDeny: true },
    { name: 'PEM header in tree file → DENY', path: TREE, content: '-----BEGIN RSA PRIVATE KEY-----', expectDeny: true },
    { name: 'placeholder sk-xxx… → allow', path: TREE, content: 'use sk-xxxxxxxxxxxxxxxxxxxxxxxx here', expectDeny: false },
    { name: 'placeholder sk-your-key → allow', path: TREE, content: 'sk-your-key-goes-here-ok-now', expectDeny: false },
    { name: 'real-shaped key OUTSIDE trees → allow', path: OUT, content: `const k = "${FAKE_SK}";`, expectDeny: false },
    { name: 'prose mentioning sk- prefix only → allow', path: TREE, content: 'keys start with sk- and ghp_ prefixes', expectDeny: false },
  ];
  let failed = 0;
  for (const c of cases) {
    const denied = !!(inSharedTree(c.path) && !isAllowlisted(c.path) && findSecret(c.content));
    const ok = denied === c.expectDeny;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  console.log(failed ? `${failed} case(s) FAILED` : 'all cases passed');
  process.exit(failed ? 1 : 0);
}
