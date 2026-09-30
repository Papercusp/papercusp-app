#!/usr/bin/env node
/**
 * pretooluse-apply-patch-duplicate-target-guard — the recurrence guard for the
 * apply_patch DUPLICATE-TARGET class (P-010,
 * fleet-friction-remediation-2026-08-21).
 *
 * THE TRAP: an apply_patch envelope may carry at most ONE operation per target
 * path. Two `*** Update File:` blocks for the same file — typically written
 * deliberately, to keep an unrelated edit visually separate, and often split by
 * an update to a THIRD file so the collision is not adjacent in the source —
 * are rejected wholesale:
 *
 *   apply_patch verification failed: invalid patch: multiple operations target <path>
 *
 * The rejection is atomic (nothing is written), so the cost is not corruption
 * but a wasted round-trip plus a re-derivation of a patch the author had already
 * finished. It has been filed independently at least five times —
 * EI-21353344120350526, EI-21354846297369687, EI-21565696681975825,
 * EI-21573638140720842, EI-22346861820470210 — and the last of those states the
 * gap precisely: "This is deterministic validation behavior but was not surfaced
 * before submission." Deterministic + pre-execution-detectable is exactly the
 * shape this hook exists for; the fix is mechanical, so the deny carries it.
 *
 * FAIL OPEN, ALWAYS. A PreToolUse hook that throws would wedge every edit on a
 * shared box. Every failure path here exits 0 (allow) rather than risk that; the
 * companion test asserts the negative cases so an over-eager guard — the kind an
 * agent learns to route around — is caught in review rather than in production.
 */
import { readFileSync } from 'node:fs';

main();

function main() {
  let hook;
  try {
    hook = JSON.parse(readStdin());
  } catch {
    return done(); // unreadable envelope — never block on our own parse failure
  }

  try {
    const tool = hook?.tool_name ?? hook?.toolName ?? '';
    if (!isApplyPatch(tool)) return done();

    const patch = patchText(hook?.tool_input ?? hook?.input ?? hook);
    if (!patch) return done();

    const duplicates = duplicateTargets(patch);
    if (duplicates.length === 0) return done();

    return deny(duplicates);
  } catch {
    return done(); // a bug in this guard must never stop an edit
  }
}

/** Codex's canonical file-edit tool. Edit/Write cannot express a duplicate
 *  target (they carry exactly one file_path), so they are deliberately not
 *  matched here — a guard that fires where the trap cannot occur is noise. */
function isApplyPatch(tool) {
  return typeof tool === 'string' && tool.toLowerCase() === 'apply_patch';
}

/** Codex may send apply_patch input as the raw patch string or wrap it under
 *  `input` / `patch`. Find the first string carrying the native patch frame.
 *  Mirrors pretooluse-control-bytes-content-guard.mjs so both guards agree on
 *  what "the patch" is. */
function patchText(input) {
  if (typeof input === 'string') return input.includes('*** ') ? input : '';
  if (!input || typeof input !== 'object') return '';
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.includes('*** ')) return value;
  }
  return '';
}

/**
 * Paths targeted by more than one operation, in first-seen order.
 *
 * Only column-0 `*** ` lines are operation headers. Patch CONTENT is always
 * prefixed (`+`, `-`, or a space), so a patch that documents apply_patch itself
 * — this repo does exactly that — writes `+*** Update File: x` and is correctly
 * ignored. That anchor is what keeps the guard from denying valid patches.
 *
 * `*** Move to:` is the destination of the Update it follows, not a second
 * operation on the source: the pair is counted once, against the destination as
 * well as the source, so a rename that collides with a separate edit to either
 * end is still caught.
 */
function duplicateTargets(patch) {
  const counts = new Map();
  const order = [];
  let current = '';

  const bump = (raw) => {
    const path = normalize(raw);
    if (!path) return;
    if (!counts.has(path)) {
      counts.set(path, 0);
      order.push(path);
    }
    counts.set(path, counts.get(path) + 1);
    return path;
  };

  for (const line of patch.split('\n')) {
    const op = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (op) {
      current = bump(op[2]) ?? '';
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      // The move destination is a distinct path that this patch also writes.
      // Count it, but do not re-count the source it renames.
      bump(move[1]);
      current = '';
      continue;
    }
    if (/^\*\*\* (?:Begin|End) Patch\s*$/.test(line)) current = '';
  }

  return order.filter((p) => counts.get(p) > 1).map((p) => ({ path: p, count: counts.get(p) }));
}

/** Light, predictable normalization so `./x` and `x` are recognised as one
 *  target. Deliberately does not resolve `..` or symlinks: this guard reports,
 *  it does not need to be a path authority, and surprising normalization would
 *  make its verdict hard to trust. */
function normalize(raw) {
  return String(raw)
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function deny(duplicates) {
  const list = duplicates.map((d) => `  • ${d.path} — ${d.count} operations`).join('\n');
  const reason =
    `🛑 apply-patch-duplicate-target-guard (P-010): this patch targets the same ` +
    `file more than once, and apply_patch will reject the WHOLE envelope before ` +
    `writing anything:\n\n${list}\n\n` +
    `  apply_patch verification failed: invalid patch: multiple operations target ` +
    `${duplicates[0].path}\n\n` +
    `An apply_patch envelope allows at most ONE operation per target path. This is ` +
    `deterministic validation, not a flake — retrying the same patch reproduces it ` +
    `exactly.\n\n` +
    `FIX: merge every edit for each path above into a SINGLE \`*** Update File: ` +
    `<path>\` block containing MULTIPLE \`@@\` hunks. One block per FILE, one hunk ` +
    `per REGION — the hunks stay as separate and as readable as the blocks were, ` +
    `so nothing about your change has to be restructured:\n\n` +
    `  *** Update File: ${duplicates[0].path}\n` +
    `  @@ <context for the first region>\n` +
    `  -old\n` +
    `  +new\n` +
    `  @@ <context for the second region>\n` +
    `  -old\n` +
    `  +new\n\n` +
    `⚠ Splitting one file's edits across blocks is usually deliberate — keeping an ` +
    `unrelated edit visually separate, often with a different file's block in ` +
    `between, which is why the collision rarely looks adjacent in the source. The ` +
    `intent is fine; only the envelope shape is wrong. Nothing has been written, so ` +
    `no cleanup is needed — re-send the merged patch.\n\n` +
    `Editing several DIFFERENT files in one patch remains correct and is unaffected.`;
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

/** Read stdin synchronously; an empty/absent payload yields '' and fails open. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}
