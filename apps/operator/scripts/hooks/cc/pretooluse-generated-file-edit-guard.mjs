#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-generated-file-edit-guard.mjs
//
// PreToolUse file-writer BLOCKING guard: refuse a hand-edit to a file
// that DECLARES ITSELF GENERATED in its own header, to the canonical tracked
// internal-docs build mirror, or to an installed Claude/Codex hook runtime copy.
// Plan claude-md-projection-from-pg-2026-08-10 P-006, extending the repo rule
// that already governs prompts — "edit the source, never the rendered output".
//
// WHY
//   Once CLAUDE.md / AGENTS.md are projected from Postgres
//   (`harness_shared.harness_doc_parts`, D-003/D-004), a hand-edit to either is
//   worse than useless: it is silently erased by the next projection and is
//   invisible to every other client. The same is already true of ~50 other
//   generated artifacts here (`gen:declarations` .d.mts files, style-dictionary
//   CSS, the doc-site reference projections). Every one of them says so in its
//   own first lines, and agents edit them anyway, because a banner is passive.
//
// THE KEY DESIGN CHOICE: the general trigger is the ARTIFACT, not a path list.
//   A broad hardcoded list of protected paths would be wrong in both directions.
//   Before the cutover CLAUDE.md is still HAND-AUTHORED and edited several times
//   an hour by this fleet — a path-keyed guard would have to be armed on a flag
//   day, in the right order, and would block legitimate edits if it landed early
//   (D-014.1 gates the cutover on exactly this ordering). Keying on the marker
//   instead makes the guard SELF-ARMING and SELF-DISARMING: it starts denying
//   the instant `--write` puts the GENERATED banner at the top of the file, and
//   it stops the instant a file legitimately goes back to being hand-authored.
//   There is no flag day and no ordering hazard, and a NEW generated file is
//   protected for free the moment it carries a banner. Files opt IN.
//
//   There are deliberately narrower path-scoped exceptions. Every existing file
//   beneath `apps/operator/public/internal/docs` is a git-tracked BUILD MIRROR,
//   and `~/.papercusp/hooks/cc` contains installed runtime copies that are
//   refreshed from `apps/operator/scripts/hooks/cc`. Neither necessarily carries
//   a generated-file marker. These trees are protected by realpath containment,
//   not lexical substrings, so lookalike paths are never denied.
//
// WHAT COUNTS AS THE MARKER (measured, not assumed)
//   A line within the first 10 lines / 4096 bytes that contains BOTH a
//   "generated" token AND a "do not edit" token, and is at most 300 chars.
//   Measured against all 21,267 tracked files on 2026-08-10: 54 match, and every
//   one is a genuine generated artifact that names its own regenerator
//   (AGENT-ENV.md, BORROWABLE.md, 5 doc-site reference projections + their
//   public/ copies, 5 style-dictionary CSS files, ~30 `gen:declarations` .d.mts
//   files, release-video.ts, the claude-md corpus). CLAUDE.md itself does NOT
//   match today, which is the correct pre-cutover behaviour.
//
//   Each clause of the predicate is load-bearing:
//   - BOTH tokens, on the SAME line — "do not edit" alone matches prose about
//     something else ("do not edit this test"), and "generated" alone matches
//     any file discussing generation. All 54 real banners put both on one line.
//   - The 300-char cap — without it the predicate also matched a minified
//     `.js.map` whose single 4096-char JSON line embeds a banner inside
//     `sourcesContent`. The cap drops exactly that one file and keeps all 54.
//     A human-readable banner is short prose; a false positive is a blob.
//
// THE DENY MESSAGE RELAYS THE FILE'S OWN LINE
//   The guard holds no per-file knowledge. It quotes the marker line back, and
//   that line already names the regenerator (`npm run gen:borrowable`,
//   `node scripts/project-doc-parts.mjs --write`, `npm run gen:declarations`…).
//   So a new generated file gets a correct, specific, actionable refusal with no
//   change here — the failure mode of a hardcoded message (drifting out of date
//   and sending agents to a command that no longer exists) cannot occur.
//
// SCOPE — this is FAST FEEDBACK, not enforcement, and the distinction is honest
//   D-003 puts enforcement in the STRUCTURE: whatever you hand-write is
//   overwritten by the next projection, which is what makes the invariant hold
//   without a hook fighting agents at write time. This guard exists to make that
//   loss immediate and legible instead of silent and delayed — you learn at the
//   edit, not when your work vanishes an hour later.
//   It follows that a determined write needs a separate, explicitly sanctioned
//   route: PreToolUse fires on Claude-CLI tool calls only, while the Bash-resource
//   gate mediates shell/interpreter writes into the tree. A hand-repair helper
//   under `<tree>/.papercusp/scratch/` (gitignored and module-resolution-friendly),
//   executed with `capability:bash`, or the `code:run` tool are the working routes.
//   Direct shell writes with literal tracked targets are denied; computed-path
//   writes remain the Bash-resource gate's advisory-only limitation. The
//   structural backstop still covers any route that slips past both guards.
//
// GENERATORS ARE STRUCTURALLY UNAFFECTED — VERIFIED, NOT ASSUMED
//   Every `gen:*` script writes with node:fs (`writeFileSync`), which is not a
//   tool call, so this hook never sees it. Confirmed by the strongest available
//   natural experiment rather than by reasoning alone: the projector WRITES a
//   file this guard PROTECTS (`claude-md-corpus.generated.md` carries the marker
//   and is written by `scripts/project-doc-parts.mjs --write-corpus`). If the
//   guard could reach generator writes at all, that command would fail. It does
//   not — re-run it to re-verify at any time.
//
// BYPASS (documented, per the item's requirement)
//   1. Preferred: DON'T. Edit the source and re-run the regenerator the marker
//      line names — that is the whole point, and the edit survives.
//   2. Per-call repair route: when a generator is broken and you must repair its
//      output by hand, create a temporary helper under `.papercusp/scratch/`
//      inside the tree and execute it with `capability:bash`, or use `code:run`.
//      The scratch directory is gitignored and resolves workspace imports. Direct
//      `node -e`, heredoc, or `sed -i` writes with literal tracked targets are
//      blocked by the Bash-resource gate.
//   3. Session-wide: launch with `PAPERCUSP_ALLOW_GENERATED_EDIT=1`, which makes
//      this guard warn instead of deny for the whole session. Env is read from
//      the CLI process the hook inherits, so it cannot be set per tool call.
//
// CONTRACT
//   - Scope: Edit / Write / MultiEdit / Codex apply_patch and their MCP writer
//     twins. Write IS included (unlike the nul-byte guard, whose bug is specific
//     to find/replace): a full-file overwrite of a generated artifact by hand is
//     precisely the thing being prevented.
//   - Trigger: the file ALREADY ON DISK carries the marker, or resolves beneath
//     the canonical internal-docs build mirror. A Write CREATING a new file is
//     always allowed — realpath resolution fails open until a target exists.
//   - On a hit: permissionDecision "deny" (JSON, exit 0) — the same contract as
//     the secrets-guard / content-lint / nul-byte-edit-guard siblings.
//   - FAIL-OPEN on any internal error (missing file, read error, bad JSON, stdin
//     timeout). A bug here must never wedge an ordinary edit.
//   - `--self-test` runs the embedded cases (no stdin needed) and exits non-zero
//     on failure; mirrors pretooluse-secrets-guard.mjs's own flag.
//
import { readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/** How much of the file's head may carry the banner. */
export const HEADER_LINES = 10;
export const HEADER_BYTES = 4096;
/** A banner is short prose. Above this a "line" is a minified blob — see header. */
export const MAX_MARKER_LINE = 300;

const GENERATED = /\b(?:auto[-\s]?)?generated\b/i;
// "do not edit" / "do NOT edit" / "don't edit" / "dont edit"
const DO_NOT_EDIT = /\bdo\s*n(?:o|')?t\s+edit\b/i;

const BYPASS_ENV = "PAPERCUSP_ALLOW_GENERATED_EDIT";
const INTERNAL_DOCS_MIRROR_REL = join(
  "apps",
  "operator",
  "public",
  "internal",
  "docs",
);
const SCRATCH_REMEDY =
  "If you genuinely must hand-repair this artifact (a broken generator blocking the fleet), " +
  "create a temporary helper under `.papercusp/scratch/` inside the tree and execute it with " +
  "`capability:bash`, or use `code:run`. The scratch directory is gitignored and resolves " +
  "workspace imports. Direct shell writes (`node -e`, heredoc, `sed -i`) with literal tracked " +
  "targets are blocked by the Bash-resource gate; computed-path writes remain advisory. Prefer " +
  "fixing the generator.";

/**
 * Run only when executed as the hook, never when imported (a test importing the
 * pure predicate must not be killed by main()'s process.exit).
 *
 * ⚠ Symlink-robust on purpose: node realpaths the entry module's
 * `import.meta.url` while `process.argv[1]` keeps the path as invoked, so
 * through this box's papercupai-workspace/papercup -> papercusp symlink a naive
 * string compare is FALSE for a genuine direct run — which would silently
 * disable the guard. Both sides are realpath'd, and an undecidable comparison
 * falls back to RUNNING: a guard that quietly no-ops is the worse failure.
 */
function invokedAsScript() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return true;
  }
}

if (invokedAsScript()) main();

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || "";
    if (!isFileWritingTool(tool)) return done();
    if (bypassed()) return done();
    for (const filePath of targetPathsForTool(tool, hook.tool_input)) {
      if (isPapercuspCcHookRuntimeMirror(filePath))
        return denyPapercuspCcHookRuntimeMirror(filePath, tool);
      if (isInternalDocsMirror(filePath))
        return denyInternalDocsMirror(filePath, tool);
      const marker = findGeneratedMarker(readHead(filePath));
      if (marker) return denyGenerated(filePath, marker, tool);
    }
  } catch {
    // fail-open: never wedge edits on a hook bug
  }
  done();
}

function bypassed() {
  const v = process.env[BYPASS_ENV];
  return v === "1" || v === "true";
}

/**
 * Does this tool_name WRITE a file's bytes? The native three are not the whole
 * set, and assuming they were left a hole this guard was built to close.
 *
 * This fleet also exposes `capability:edit` / `capability:write` as MCP tools
 * (`mcp__<server>__capability_edit`). They take the SAME `file_path` argument
 * and do the SAME thing under a different tool_name, so a name-keyed check that
 * listed only Edit/Write/MultiEdit let every one of them through silently.
 *
 * MEASURED, not theorised (2026-08-12): four projected docs under
 * apps/operator-docs/src/content/docs were hand-edited within ~20h WHILE this
 * guard was live, registered, and correctly denying native Edits against those
 * exact paths — `project-authored-docs.ts --check` went from exit 0 to exit 1
 * with 4 drifted files. Replaying the hook by hand confirmed the split: a
 * tool_name of `Edit` denies, `mcp__papercusp-su__capability_edit` on the same
 * path is allowed.
 *
 * The server segment is deliberately NOT pinned — renaming the MCP server must
 * not quietly re-open the hole. Matching is on the verb suffix only.
 *
 * NOT implemented by this hook (handled by the separate Bash-resource gate): a
 * write that is not a Claude file-edit tool call — `capability:bash` with
 * `sed -i`, a heredoc, `node -e`, or any other process. Direct writes targeting
 * tracked files are denied there; use the sanctioned scratch or `code:run`
 * route for a genuine repair. The structural backstop (the next projection
 * refuses to overwrite drift) remains what actually enforces the invariant.
 */
export function isFileWritingTool(tool) {
  if (
    tool === "Edit" ||
    tool === "Write" ||
    tool === "MultiEdit" ||
    tool === "apply_patch"
  )
    return true;
  return /(?:^|__)capability_(?:edit|write|multi_?edit)$/i.test(tool || "");
}

/** Every existing target whose bytes this call may alter or remove. Codex sends
 * apply_patch either as the raw patch frame or wrapped under `input` / `patch`.
 * Keep Add targets too: a new file fails open by contract, while a pre-existing
 * target must still receive the same protection as Write. */
export function targetPathsForTool(tool, input) {
  if (tool === "apply_patch") return applyPatchPaths(input);
  const filePath = input && typeof input === "object" ? input.file_path : "";
  return typeof filePath === "string" && filePath ? [filePath] : [];
}

function patchText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.includes("*** Begin Patch"))
      return value;
  }
  return "";
}

/** Parse the path-bearing native patch headers. A move touches both the existing
 * source and the destination; inspecting both keeps rename/delete from becoming
 * an escape hatch while preserving the existing fail-open rule for new paths. */
export function applyPatchPaths(input) {
  const paths = new Set();
  for (const line of patchText(input).split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (file) paths.add(file[1].trim());
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) paths.add(move[1].trim());
  }
  return [...paths].filter(Boolean);
}

/** The file's first HEADER_LINES lines, or null when absent/unreadable
 *  (fail-open — never deny on our own inability to read the target). */
function readHead(filePath) {
  let buf;
  try {
    buf = readFileSync(filePath);
  } catch {
    return null;
  }
  // A binary file has no banner to honour, and decoding it is meaningless.
  if (buf.indexOf(0) !== -1) return null;
  return buf
    .subarray(0, HEADER_BYTES)
    .toString("utf8")
    .split("\n")
    .slice(0, HEADER_LINES);
}

/**
 * The declaring line, or null. Exported for the test + for anything that needs
 * to ask "would the guard fire on this text?" without spawning the hook.
 */
export function findGeneratedMarker(headLines) {
  if (!headLines) return null;
  for (const raw of headLines) {
    const line = raw.replace(/\r$/, "");
    if (line.length > MAX_MARKER_LINE) continue;
    if (GENERATED.test(line) && DO_NOT_EDIT.test(line)) return line.trim();
  }
  return null;
}

/**
 * True only when an existing target resolves inside this checkout's canonical
 * internal-docs build mirror. Both roots and the target are realpath'd so a
 * symlink or a lookalike path cannot turn lexical path words into authority.
 * Any resolution failure is an allow: this hook must remain fail-open.
 */
export function isInternalDocsMirror(filePath) {
  try {
    const hookFile = realpathSync(fileURLToPath(import.meta.url));
    const repoRoot = realpathSync(
      resolve(dirname(hookFile), "..", "..", "..", "..", ".."),
    );
    const target = realpathSync(filePath);
    const rel = relative(repoRoot, target);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
      return false;
    return (
      rel === INTERNAL_DOCS_MIRROR_REL ||
      rel.startsWith(`${INTERNAL_DOCS_MIRROR_REL}${sep}`)
    );
  } catch {
    return false;
  }
}

export function isPapercuspCcHookRuntimeMirror(filePath) {
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;
    const runtimeDir = realpathSync(join(home, ".papercusp", "hooks", "cc"));
    const expandedPath =
      filePath === "~"
        ? home
        : filePath.startsWith("~/") || filePath.startsWith("~\\")
          ? join(home, filePath.slice(2))
          : filePath;
    const absolutePath = resolve(expandedPath);
    let target;
    try {
      target = realpathSync(absolutePath);
    } catch {
      target = resolve(realpathSync(dirname(absolutePath)), basename(absolutePath));
    }
    const rel = relative(runtimeDir, target);
    return Boolean(
      rel &&
        !isAbsolute(rel) &&
        rel !== ".." &&
        !rel.startsWith(`..${sep}`),
    );
  } catch {
    return false;
  }
}

function denyGenerated(filePath, marker, tool) {
  const base = filePath.split(/[/\\]/).pop();
  const reason =
    `🛑 generated-file-edit-guard (P-006): ${base} declares itself GENERATED, so this ${tool} ` +
    `would be silently erased by the next regeneration and is invisible to every other client.\n\n` +
    `The file's own header says:\n  ${marker}\n\n` +
    `Edit the SOURCE and re-run the generator that line names — that is the only edit that ` +
    `survives. This is the same rule that already governs prompts in this repo: edit the source, ` +
    `never the rendered output.\n\n` +
    SCRATCH_REMEDY +
    ` Or relaunch with ${BYPASS_ENV}=1 to downgrade this guard to a warning for the session.`;
  deny(reason);
}

function denyInternalDocsMirror(filePath, tool) {
  const base = filePath.split(/[/\\]/).pop();
  const reason =
    `🛑 generated-file-edit-guard (EI-18745869078408184): ${base} is inside ` +
    `\`apps/operator/public/internal/docs\`, the git-tracked internal-docs BUILD MIRROR. ` +
    `This ${tool} would change rendered output rather than its canonical source, and the next ` +
    `docs build can erase it.\n\n` +
    `For agent-insights and other datastore-authored internal docs, use \`docs:author\`. For ` +
    `filesystem-authored docs, edit \`apps/operator-docs/src/content/docs\` and rebuild the ` +
    `internal docs site. Never hand-edit the mirror.\n\n` +
    `${SCRATCH_REMEDY} Or relaunch with ${BYPASS_ENV}=1 to downgrade this guard to a warning ` +
    `for the session.`;
  deny(reason);
}

function denyPapercuspCcHookRuntimeMirror(filePath, tool) {
  const base = filePath.split(/[/\\]/).pop();
  const reason =
    `🛑 generated-file-edit-guard (EI-19917150867390319): ${base} is an installed ` +
    `runtime copy under \`~/.papercusp/hooks/cc\`. This ${tool} would edit the ` +
    `deployed mirror, which Papercusp refreshes from the repository and can silently erase.\n\n` +
    `Edit the canonical source \`apps/operator/scripts/hooks/cc/${base}\` in the ` +
    `papercusp staging checkout instead; the hook installer propagates that source.`;
  deny(reason);
}

function deny(reason) {
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }) + "\n",
    );
    process.stderr.write(reason + "\n");
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
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function selfTest() {
  const L = (s) => s.split("\n");
  const cases = [
    // ── the five real banner shapes in this tree (verbatim heads) ──────────
    {
      name: "projector banner (CLAUDE.md post-cutover)",
      head: L(
        "<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->\n<!-- Projected from Postgres -->",
      ),
      expectDeny: true,
    },
    {
      name: "AGENT-ENV.md",
      head: L(
        "<!-- GENERATED by npx tsx scripts/gen-agent-env.ts — do NOT edit by hand. Regenerate after",
      ),
      expectDeny: true,
    },
    {
      name: "BORROWABLE.md (marker on line 3)",
      head: L(
        "# Borrowable libraries\n\n> **Generated — do not edit by hand.** Run `npm run gen:borrowable`.",
      ),
      expectDeny: true,
    },
    {
      name: "release-video.ts",
      head: L(
        " * ⚠ GENERATED FILE — do not edit by hand. Run bin/gen-release-video.sh.",
      ),
      expectDeny: true,
    },
    {
      name: "style-dictionary CSS",
      head: L(" * Do not edit directly, this file was auto-generated."),
      expectDeny: true,
    },
    {
      name: "apostrophe form (don't edit)",
      head: L("// Generated by X. don't edit."),
      expectDeny: true,
    },
    // ── must NOT fire ──────────────────────────────────────────────────────
    {
      name: "hand-authored CLAUDE.md (pre-cutover)",
      head: L("# Papercup — agent guide\n\n> Invariants + pointers only."),
      expectDeny: false,
    },
    {
      name: "both tokens but on DIFFERENT lines",
      head: L("# Generated report\n\nPlease do not edit the fixture below."),
      expectDeny: false,
    },
    {
      name: '"do not edit" alone (prose about something else)',
      head: L("// Do not edit this test without reading the header."),
      expectDeny: false,
    },
    {
      name: '"generated" alone',
      head: L("// This module is generated at runtime from the registry."),
      expectDeny: false,
    },
    {
      name: "marker below the header window (line 11)",
      head: L(
        "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n<!-- GENERATED — do not edit -->",
      ).slice(0, HEADER_LINES),
      expectDeny: false,
    },
    {
      name: "minified blob line >300 chars (the .js.map false positive)",
      head: [`{"x":"${"y".repeat(400)} GENERATED do not edit"}`],
      expectDeny: false,
    },
    {
      name: "unreadable/absent file (fail-open)",
      head: null,
      expectDeny: false,
    },
  ];
  let failed = false;
  for (const c of cases) {
    const denied = findGeneratedMarker(c.head) !== null;
    const ok = denied === c.expectDeny;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? "ok" : "FAIL"} — ${c.name}\n`);
  }

  // ── which TOOL NAMES the guard inspects at all ─────────────────────────────
  // A marker predicate that is perfect is still worthless on a tool_name the
  // guard skips before it ever reads the file — the hole measured 2026-08-12.
  const toolCases = [
    { name: "native Edit", tool: "Edit", expect: true },
    { name: "native Write", tool: "Write", expect: true },
    { name: "native MultiEdit", tool: "MultiEdit", expect: true },
    {
      name: "MCP capability:edit (the measured bypass)",
      tool: "mcp__papercusp-su__capability_edit",
      expect: true,
    },
    {
      name: "MCP capability:write (the measured bypass)",
      tool: "mcp__papercusp-su__capability_write",
      expect: true,
    },
    {
      name: "MCP server renamed — must still match",
      tool: "mcp__some-other-server__capability_write",
      expect: true,
    },
    // must NOT fire — these do not write the target's bytes
    {
      name: "capability:read",
      tool: "mcp__papercusp-su__capability_read",
      expect: false,
    },
    {
      name: "capability:bash (documented accepted gap, not a tool-name miss)",
      tool: "mcp__papercusp-su__capability_bash",
      expect: false,
    },
    { name: "Read", tool: "Read", expect: false },
    {
      name: "a tool merely CONTAINING the word edit",
      tool: "mcp__x__plans_edit",
      expect: false,
    },
    { name: "empty / absent tool_name", tool: "", expect: false },
  ];
  for (const c of toolCases) {
    const ok = isFileWritingTool(c.tool) === c.expect;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? "ok" : "FAIL"} — tool: ${c.name}\n`);
  }

  const total = cases.length + toolCases.length;
  process.stdout.write(failed ? "SELF-TEST FAILED\n" : `ok — ${total} cases\n`);
  process.exit(failed ? 1 : 0);
}
