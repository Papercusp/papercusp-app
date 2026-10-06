#!/usr/bin/env node
/**
 * WI-39623 — the agent-facing WRITE path for ONE `harness_shared.harness_doc_parts` row.
 *
 * CLAUDE.md's own banner tells the reader: "To change a rule: edit its PART, then
 * re-project with `node scripts/project-doc-parts.mjs --write`." Until this script
 * existed the FIRST half named an operation nobody could perform — `dev:pg_query` is
 * read-only, no `docs:*`/`harness_docs:*` tool addresses a PART (they all operate on
 * whole DOCS), and the only writer in the tree was
 * `scripts/load-claude-md-doc-parts.mjs`, the one-time BOOTSTRAP that refuses to run
 * post-cutover on purpose (P-013). So the documented instruction was unexecutable and
 * the actual practice became hand-rolled UPDATE statements outside every guard.
 *
 * This is the other half of that sentence, and nothing more: it edits ONE part body.
 * It deliberately does NOT project — `project-doc-parts.mjs --write` stays the only
 * thing that may author CLAUDE.md / AGENTS.md (D-010), and this script prints that
 * command rather than absorbing it.
 *
 * THE RULES ARE IMPORTED, NEVER RE-SPELLED. `validateDocPart` is the pure mirror of
 * migration 781's CHECK constraints; a future `docs:set-part` MCP tool must import the
 * SAME function. That is the sibling pattern `scripts/project-authored-docs.ts` states
 * for itself: keeping the rules out of the CLI is what stops the tool and the CLI from
 * disagreeing about what a legal part IS. Re-spelling the constraints here would make
 * this script a second, drifting definition of the thing it exists to protect.
 *
 *   node --import tsx scripts/set-doc-part.ts --part-key <key> --body-file <path>
 *   node --import tsx scripts/set-doc-part.ts --part-key <key> --body-file <path> --write
 *   cat body.md | node --import tsx scripts/set-doc-part.ts --part-key <key> --body-stdin --write
 *   node --import tsx scripts/set-doc-part.ts --list <prefix>
 *   node --import tsx scripts/set-doc-part.ts --part-key <key> --show > body.md
 *
 * Exit codes: 0 ok (or dry run) · 1 refused (a guard fired) · 2 misuse.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  docPartHasChanges,
  validateDocPart,
  type DocPartKind,
  type SetDocPartInput,
} from "../packages/operator-core/lib/harness/docs/doc-record";
// identities-v1 P-022: the addressing vocabulary — registered slot ids and the built-in
// blueprint tier — so a `--stack-scope` token that nothing can ever wear is refused at
// the write seat rather than sitting unreachable forever.
import { SLOT_IDS, SU_STATIC_LAYERS } from "@papercusp/orchestrator/blueprint";
import { harnessRoot } from "@papercusp/harness/paths";
import {
  compareProseBudget,
  launchProseHeadroom,
  surfaceDeltasFromFileDeltas,
} from "../packages/operator-core/lib/launch-prose-budget";
import {
  applyEditInMemory,
  evictionDelta,
  identityProblemDelta,
  renderImpact,
  type IdentityProblem,
  type ProjectionRow,
} from "../packages/operator-core/lib/doc-projection/eviction-delta";
import { connectScriptPg } from "./lib/pg-url.mjs";
import {
  writeStderrSync,
  writeStdoutExactSync,
} from "./lib/write-stdout-sync.mjs";
// The projector's composition is IMPORTED, never re-implemented — the same reasoning
// that makes `validateDocPart` a shared import above. A second copy of the cut order or
// the budget arithmetic here would drift from the thing that actually authors the file,
// and this report's whole value is that it predicts what project-doc-parts will DO.
//
// It is loaded DYNAMICALLY on purpose. This script has no "type": "module" above it, so
// tsx compiles it to CJS, and project-doc-parts.mjs has top-level await inside its
// `import.meta.url` main-guard — which a CJS transform cannot express ("Top-level await
// is currently not supported with the cjs output format"). A dynamic import stays a real
// ESM load and crosses that boundary; a static one fails at startup. Loading it is
// otherwise safe: the main-guard means importing runs no projection.
type ProjectorModule = {
  CHARS_PER_TOKEN_KNOWN_MODEL: number;
  CLIENTS: { client: string; file: string; reader: string }[];
  memoryWarningThreshold: (o: {
    contextTokens: number;
    charsPerToken: number;
  }) => number;
  projectionBudget: () => number;
  projectClient: (
    parts: ProjectionRow[],
    opts: {
      client: string;
      docId: string;
      file: string;
      reader: string;
      budget: number;
    },
  ) => { text: string; kept: ProjectionRow[]; dropped: ProjectionRow[] };
  readProjectedParts: (
    client: { query: Function },
    docId: string,
  ) => Promise<ProjectionRow[]>;
  // Every LIVE part, projected or not. The identity rule is defined over the corpus,
  // not the projection: an `#evidence` row is unprojected but is still judged against
  // its projecting sibling, so checking `readProjectedParts` alone would silently skip
  // half the rule.
  readAllParts: (
    client: { query: Function },
    docId: string,
  ) => Promise<ProjectionRow[]>;
  docPartIdentityProblems: (rows: ProjectionRow[]) => IdentityProblem[];
};

const loadProjector = async (): Promise<ProjectorModule> => {
  // @ts-expect-error — the canonical .mjs projector has no declaration file; the
  // ProjectorModule cast above is this script's intentionally narrow runtime contract.
  return (await import("./project-doc-parts.mjs")) as unknown as ProjectorModule;
};

const WORKSPACE_ID =
  process.env.PAPERCUSP_WORKSPACE_ID ?? "papercusp-workspace";
const HARNESS_SLUG = process.env.PAPERCUSP_HARNESS_SLUG ?? "papercusp";

const MISUSE = 2;
const REFUSED = 1;

interface PartRow {
  part_key: string;
  kind: string;
  body: string;
  ordinal: number;
  tombstone: boolean;
  client_scope: string[];
  project_rank: number;
  target_section: string | null;
  rationale_part_key: string | null;
  /** P-022 addressing tokens; `{}` = unaddressed (the default file). */
  stack_scope: string[];
}

/**
 * P-022: does a `blueprint:<id>` token name something a launch can wear? The built-in
 * harness tier (`<harness>/blueprints/<id>/blueprint.yaml`) plus the su static layer
 * ids that have no directory of their own (`su.practice`). A hive-local identity the
 * script cannot see passes with `--allow-unknown-blueprint`.
 */
function builtInBlueprintExists(id: string): boolean {
  if (SU_STATIC_LAYERS.some((l) => l.id === id)) return true;
  return existsSync(join(harnessRoot(), "blueprints", id, "blueprint.yaml"));
}

function die(code: number, msg: string): never {
  // SYNCHRONOUS write, deliberately not console.error. Writes to a PIPE are async in
  // Node and process.exit() does not drain them, so `console.error(msg); process.exit()`
  // silently truncates whenever this script is piped (measured ~8 KiB, not the 64 KiB
  // pipe buffer — EI-20055889379250637). It survives a TTY and a `> file` redirect, so
  // the bug is invisible until someone composes with the tool.
  // `die` is typed `never`, which rules out the guard's preferred fix
  // (`process.exitCode = code` + natural return), so this is its option 3.
  // Enforced by scripts/check-undrained-stdout-exit.mjs, whose BASELINE is empty and
  // SHRINK-ONLY — do not re-introduce a console.* write on this path.
  writeStderrSync(msg);
  process.exit(code);
}

/** `--flag value` / `--flag=value` / bare `--flag`. */
function parseArgv(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.set(a.slice(2), next);
      i++;
    } else {
      out.set(a.slice(2), true);
    }
  }
  return out;
}

const str = (v: string | true | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

/**
 * A compact line-level diff. Not a real LCS — it reports the changed REGION (first and
 * last differing line) because the point is for a human to see WHICH rule text moves,
 * and a full diff of a 1,200-char part is noise on a terminal.
 */
function describeChange(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const oldSlice = a.slice(head, a.length - tail);
  const newSlice = b.slice(head, b.length - tail);
  const lines: string[] = [];
  lines.push(
    `    unchanged   ${head} leading line(s), ${tail} trailing line(s); ` +
      `${before.length} chars -> ${after.length} chars`,
  );
  for (const l of oldSlice) lines.push(`    \x1b[31m- ${l}\x1b[0m`);
  for (const l of newSlice) lines.push(`    \x1b[32m+ ${l}\x1b[0m`);
  return lines.join("\n");
}

function describeColumnChanges(
  before: Pick<
    PartRow,
    | "kind"
    | "ordinal"
    | "client_scope"
    | "project_rank"
    | "target_section"
    | "rationale_part_key"
    | "stack_scope"
  >,
  after: {
    kind: string;
    ordinal: number;
    clientScope: readonly string[];
    projectRank: number;
    targetSection: string | null;
    rationalePartKey: string | null;
    stackScope?: readonly string[];
  },
): string {
  const changes: string[] = [];
  if (before.kind !== after.kind)
    changes.push(`kind ${before.kind} -> ${after.kind}`);
  {
    const b = before.stack_scope ?? [];
    const a = after.stackScope ?? [];
    if (b.length !== a.length || b.some((t, i) => t !== a[i])) {
      changes.push(`stack_scope ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    }
  }
  if (before.ordinal !== after.ordinal)
    changes.push(`ordinal ${before.ordinal} -> ${after.ordinal}`);
  if (before.project_rank !== after.projectRank)
    changes.push(`project_rank ${before.project_rank} -> ${after.projectRank}`);
  if (before.target_section !== after.targetSection) {
    changes.push(
      `target_section ${JSON.stringify(before.target_section)} -> ${JSON.stringify(after.targetSection)}`,
    );
  }
  if (before.rationale_part_key !== after.rationalePartKey) {
    changes.push(
      `rationale_part_key ${JSON.stringify(before.rationale_part_key)} -> ${JSON.stringify(after.rationalePartKey)}`,
    );
  }
  if (
    before.client_scope.length !== after.clientScope.length ||
    before.client_scope.some(
      (scope, index) => scope !== after.clientScope[index],
    )
  ) {
    changes.push(
      `client_scope ${JSON.stringify(before.client_scope)} -> ${JSON.stringify(after.clientScope)}`,
    );
  }
  return changes.length > 0
    ? `    changed columns ${changes.join(", ")}`
    : "    columns unchanged";
}

function readBody(args: Map<string, string | true>): string {
  const file = str(args.get("body-file"));
  const stdin = args.get("body-stdin") === true;
  if (file && stdin)
    die(MISUSE, "misuse: pass exactly one of --body-file or --body-stdin.");
  if (file) return readFileSync(file, "utf8");
  if (stdin) return readFileSync(0, "utf8");
  die(
    MISUSE,
    "misuse: a body is required — pass --body-file <path> or --body-stdin.\n" +
      "  A part body is multi-line markdown; passing it through argv mangles quoting,\n" +
      "  which is how a rule silently acquires a stray backslash.",
  );
}

/**
 * The eviction-delta logic lives in `@papercusp/operator-core` so it is TYPECHECKED and
 * unit-tested (`lib/doc-projection/eviction-delta.test.ts`) — a script under `scripts/`
 * is neither. `projectClient` is injected into it rather than imported by it, so the
 * composition keeps exactly one definition: the projector's.
 */
function budgetFor(proj: ProjectorModule): number {
  // The SAME budget project-doc-parts' main() enforces, via the same imported function — a
  // hardcoded number here would silently stop predicting the real projection the day the
  // budget moves. It moved on 2026-08-26 (80,000 -> 160,000, owner-directed), which is
  // exactly the drift this indirection exists to survive: the dry-run's "projection impact"
  // block is only trustworthy while it is computed from the projector's own budget.
  return proj.projectionBudget();
}

/**
 * WI-10004682 — the edit-time launch-prose signal.
 *
 * The "projection impact" block above reports headroom against the projection CUT SET
 * (≈160,000 chars), which is a DIFFERENT budget from the lint ceilings on the written files
 * (`scripts/launch-prose-budget-baseline.json`, ≈116,600 B for the guide, tighter still for
 * the su-playbook renders that embed CLAUDE.md verbatim). The guide re-breached those
 * ceilings three times in three days, each found hours later at the gate, because nothing
 * here said so. This projects the edit's per-client byte delta onto the lint's OWN
 * measurement + ceilings (no second measurement) and prints the headroom per surface.
 *
 * A NOTICE, not a gate: the write that matters is project-doc-parts' (which gates and rolls
 * back). Never throws — a measurement that cannot run says so ("NOT checked"), because a
 * silent omission reads as "within budget".
 */
const LAUNCH_PROSE_NOTICE_TIMEOUT_MS = 40_000; // < the 60 s idle_in_transaction_session_timeout this runs under

async function launchProseNotice(
  proj: ProjectorModule,
  docId: string,
  beforeRows: ProjectionRow[],
  afterRows: ProjectionRow[],
): Promise<string> {
  const heading = "\n  launch-prose (lint ceiling, projected after this edit):";
  try {
    const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
    const budget = budgetFor(proj);
    const fileDeltaBytes: Record<string, number> = {};
    for (const spec of proj.CLIENTS) {
      const opts = { ...spec, docId, budget };
      fileDeltaBytes[spec.file] =
        bytes(proj.projectClient(afterRows, opts).text) -
        bytes(proj.projectClient(beforeRows, opts).text);
    }
    // Dynamic, like loadProjector: the lint script is an ESM-shaped CLI (import.meta.url),
    // and this file compiles to CJS — a static import would run its module scope at startup.
    const lint = await import("./check-launch-prose-budget");
    let timer: NodeJS.Timeout | undefined;
    const report = await Promise.race([
      (async () => compareProseBudget(await lint.measureLaunchProseSurfaces(), await lint.readBaseline()))(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`measurement exceeded ${LAUNCH_PROSE_NOTICE_TIMEOUT_MS / 1000}s`)),
          LAUNCH_PROSE_NOTICE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const headroom = launchProseHeadroom(report, {
      surfaceDeltaBytes: surfaceDeltasFromFileDeltas(fileDeltaBytes),
    });
    if (headroom.rows.length === 0) {
      return `${heading}\n  launch-prose headroom UNAVAILABLE: no projection-governed surface was measured — NOT checked.`;
    }
    const verdict = headroom.over.length
      ? `\n  ⚠ ${headroom.over.length} surface(s) would be OVER their lint ceiling — \`project-doc-parts --write\` will REFUSE (and roll back) unless you trim prose, raise the ceiling in scripts/launch-prose-budget-baseline.json WITH a note, or pass --allow-over.`
      : "";
    return `${heading}\n${headroom.lines.join("\n")}${verdict}`;
  } catch (e) {
    return `${heading}\n  launch-prose headroom UNAVAILABLE: ${e instanceof Error ? e.message : String(e)} — NOT checked.`;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgv(argv);

  if (args.has("help") || argv.length === 0) {
    console.log(
      [
        "set-doc-part — edit ONE harness_doc_parts row (the write half of CLAUDE.md's",
        '"edit its PART, then re-project" instruction).',
        "",
        "  --part-key <key>       (required) the part to edit",
        "  --doc-id <id>          default: claude-md",
        "  --body-file <path>     new body, read from a file",
        "  --body-stdin           new body, read from stdin",
        "  --write                actually write (default is a DRY RUN)",
        "  --author <id>          provenance; default $PAPERCUSP_SID",
        "  --list [prefix]        list part keys (optionally by prefix) and exit",
        "  --show                 print ONE part: body to stdout, metadata to stderr, then",
        "                         exit. `--part-key K --show > body.md` round-trips exactly",
        "                         back through --body-file. Refuses a missing key rather",
        "                         than printing nothing.",
        "",
        "  create/override (a NEW key requires --create plus the projection columns):",
        "  --create --kind <invariant|pointer|recipe|prose> --ordinal <n>",
        '  --target-section <heading> --client-scope <all|claude|codex|""> --project-rank <n>',
        '  --stack-scope <tok,…|"">  P-022 ADDRESSING: deliver this part ONLY to a launch',
        "                         whose stack matches a token — blueprint:<id> (e.g.",
        "                         blueprint:su.fleet-leader), slot:<slot> (e.g. slot:autonomy),",
        '                         role:<role>. "" (the default) = unaddressed = every reader,',
        "                         via the default CLAUDE.md. An addressed part LEAVES the",
        "                         default file and is spliced at launch instead.",
        "  --allow-unknown-blueprint  accept a blueprint:<id> the built-in tier cannot see",
        "                         (a hive-local identity)",
        "  --revive               un-tombstone a retired part",
        "  --accept-evictions     proceed with a --write that pushes OTHER parts out of",
        "                         the file. Every run reports the eviction delta; this",
        "                         flag is what makes causing one deliberate.",
        "  --accept-deprojection  proceed with a --write that empties THIS part's",
        "                         client_scope, so it stops reaching every client file",
        "                         and becomes corpus-only. A separate consent from",
        "                         --accept-evictions, which covers only OTHER parts.",
        "",
        "After a successful write, project it:  node scripts/project-doc-parts.mjs --write",
      ].join("\n"),
    );
    return;
  }

  const docId = str(args.get("doc-id")) ?? "claude-md";
  const client = await connectScriptPg();

  try {
    // ── --list: the discovery half. Finding a part_key was itself guesswork before.
    if (args.has("list")) {
      const prefixArg = args.get("list");
      const prefix = typeof prefixArg === "string" ? prefixArg : "";
      const { rows } = await client.query<PartRow & { body_len: number }>(
        `SELECT part_key, kind, ordinal, tombstone, client_scope, target_section, stack_scope,
                length(body) AS body_len
           FROM harness_shared.harness_doc_parts
          WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3
            AND part_key LIKE $4 || '%'
          ORDER BY ordinal, part_key`,
        [WORKSPACE_ID, HARNESS_SLUG, docId, prefix],
      );
      console.log(
        `${rows.length} part(s) in ${docId}${prefix ? ` matching "${prefix}*"` : ""}:`,
      );
      for (const r of rows) {
        console.log(
          `  ${r.tombstone ? "⊘" : " "} ${r.part_key}  [${r.kind}, ord ${r.ordinal}, ` +
            `${r.body_len} chars, scope ${JSON.stringify(r.client_scope)}` +
            `${r.stack_scope?.length ? `, addressed ${JSON.stringify(r.stack_scope)}` : ""}]`,
        );
      }
      return;
    }

    const partKey = str(args.get("part-key"));
    if (!partKey)
      die(
        MISUSE,
        "misuse: --part-key is required. Use --list <prefix> to find one.",
      );

    // ── --show: the READ half. Without it the only way to see what you are about to
    // overwrite was a hand-written SELECT against harness_doc_parts — which is the exact
    // raw-table access the write half exists to stop people doing (it is how `author`
    // used to end up NULL). Hit live on EI-20687080717457981.
    //
    // The BODY goes to stdout and everything else to stderr, so
    //   set-doc-part --part-key K --show > body.md
    // yields a file that round-trips byte-exactly back through --body-file. Written
    // synchronously because that redirect/pipe is the primary use: an async console.log
    // followed by exit truncates (EI-20055889379250637, see `die`).
    if (args.has("show")) {
      const { rows } = await client.query<PartRow>(
        `SELECT part_key, kind, body, ordinal, tombstone, client_scope, project_rank,
                target_section, rationale_part_key, stack_scope
           FROM harness_shared.harness_doc_parts
          WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3 AND part_key = $4`,
        [WORKSPACE_ID, HARNESS_SLUG, docId, partKey],
      );
      // A missing part must FAIL, never print nothing: empty stdout is indistinguishable
      // from a genuinely empty body, and "I read it and it was blank" is how a real part
      // gets clobbered by a write derived from a read that never happened.
      if (rows.length === 0) {
        die(
          REFUSED,
          `refused: no part "${partKey}" in ${docId}.\n` +
            `  An empty read must not look like an empty body, so this is an error, not "".\n` +
            `  Run --list <prefix> to find the real key.\n`,
        );
      }
      const r = rows[0];
      writeStderrSync(
        `${r.tombstone ? "⊘ TOMBSTONED " : ""}${r.part_key}  [${r.kind}, ord ${r.ordinal}, ` +
          `${r.body.length} chars, scope ${JSON.stringify(r.client_scope)}, ` +
          `rank ${r.project_rank}, section ${JSON.stringify(r.target_section)}` +
          `${r.stack_scope?.length ? `, addressed ${JSON.stringify(r.stack_scope)}` : ""}]\n`,
      );
      writeStdoutExactSync(r.body);
      return;
    }

    const body = readBody(args);
    const write = args.get("write") === true;
    const create = args.get("create") === true;
    const revive = args.get("revive") === true;
    const author = str(args.get("author")) ?? process.env.PAPERCUSP_SID ?? null;

    await client.query("BEGIN");

    // The parent doc must be COMPOSED or the parts are not canonical — editing a part of
    // a non-composed doc writes a row that nothing reads, while `harness_docs.content`
    // stays the truth. That reads as success and changes nothing, so it is refused.
    const { rows: docRows } = await client.query<{
      content_mode: string | null;
    }>(
      `SELECT content_mode FROM harness_shared.harness_docs
        WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3 FOR UPDATE`,
      [WORKSPACE_ID, HARNESS_SLUG, docId],
    );
    if (docRows.length === 0) {
      await client.query("ROLLBACK");
      die(REFUSED, `✗ refused: no harness_docs row for doc_id='${docId}'.`);
    }
    if (docRows[0].content_mode !== "composed") {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: doc '${docId}' has content_mode='${docRows[0].content_mode}', not 'composed'.\n` +
          `  Parts are canonical only for a composed doc (migration 781 / D-010). Editing a part\n` +
          `  here would write a row no reader consults while harness_docs.content stays the truth.`,
      );
    }

    // Read the CURRENT row inside the transaction: the merged result is what gets
    // validated, so a body-only edit cannot be validated against columns it never saw.
    const { rows: partRows } = await client.query<PartRow>(
      `SELECT part_key, kind, body, ordinal, tombstone, client_scope, project_rank,
              target_section, rationale_part_key, stack_scope
         FROM harness_shared.harness_doc_parts
        WHERE workspace_id = $1 AND harness_slug = $2 AND doc_id = $3 AND part_key = $4
        FOR UPDATE`,
      [WORKSPACE_ID, HARNESS_SLUG, docId, partKey],
    );
    const existing = partRows[0] ?? null;

    if (!existing && !create) {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: part '${partKey}' does not exist in ${docId}.\n` +
          `  A typo'd --part-key must never silently create an orphan part that projects\n` +
          `  nowhere. Pass --create (with --kind/--ordinal/--target-section) if it is new,\n` +
          `  or run --list <prefix> to find the real key.`,
      );
    }
    if (existing?.tombstone && !revive) {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: part '${partKey}' is TOMBSTONED (retired). Pass --revive to bring it back.`,
      );
    }

    // Merge: an omitted column keeps the existing value. A body-only edit must not
    // silently reset a part's ordinal, scope or rank to a default.
    const merged = {
      kind: (str(args.get("kind")) ??
        existing?.kind ??
        "invariant") as DocPartKind,
      ordinal: Number(str(args.get("ordinal")) ?? existing?.ordinal ?? 0),
      targetSection:
        str(args.get("target-section")) ?? existing?.target_section ?? null,
      projectRank: Number(
        str(args.get("project-rank")) ?? existing?.project_rank ?? 1000,
      ),
      clientScope: (() => {
        const raw = str(args.get("client-scope"));
        if (raw === undefined) return existing?.client_scope ?? [];
        return raw === ""
          ? []
          : raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
      })(),
      rationalePartKey:
        str(args.get("rationale-part-key")) ??
        existing?.rationale_part_key ??
        null,
      // P-022: omitted keeps the stored addressing; "" clears it (back to every reader).
      stackScope: (() => {
        const raw = str(args.get("stack-scope"));
        if (raw === undefined) return existing?.stack_scope ?? [];
        return raw === ""
          ? []
          : raw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
      })(),
    };

    if (
      !Number.isFinite(merged.ordinal) ||
      !Number.isFinite(merged.projectRank)
    ) {
      await client.query("ROLLBACK");
      die(MISUSE, "misuse: --ordinal and --project-rank must be numbers.");
    }

    // The imported rule, run against the MERGED row (mirrors migration 781's CHECKs).
    const invalid = validateDocPart({
      partKey,
      kind: merged.kind,
      clientScope: merged.clientScope,
      targetSection: merged.targetSection,
      rationalePartKey: merged.rationalePartKey,
      stackScope: merged.stackScope,
      stackVocabulary: {
        knownSlots: SLOT_IDS,
        blueprintExists:
          args.get("allow-unknown-blueprint") === true
            ? undefined
            : builtInBlueprintExists,
      },
    });
    if (invalid) {
      await client.query("ROLLBACK");
      die(REFUSED, `✗ refused by validateDocPart: ${invalid}`);
    }

    const nextComparable = {
      body,
      kind: merged.kind,
      ordinal: merged.ordinal,
      clientScope: merged.clientScope,
      projectRank: merged.projectRank,
      targetSection: merged.targetSection,
      rationalePartKey: merged.rationalePartKey,
      stackScope: merged.stackScope,
    };

    // A no-op that reports success is a FALSE CONFIRMATION — the caller believes the rule
    // changed and moves on. Same reasoning as mutation-probe.sh refusing a no-op mutation.
    // Compare the merged columns too: a body-identical rank/ordinal/scope edit is real work.
    if (
      existing &&
      !docPartHasChanges(
        {
          body: existing.body,
          kind: existing.kind,
          ordinal: existing.ordinal,
          clientScope: existing.client_scope,
          projectRank: existing.project_rank,
          targetSection: existing.target_section,
          rationalePartKey: existing.rationale_part_key,
          stackScope: existing.stack_scope ?? [],
        },
        nextComparable,
      ) &&
      !revive
    ) {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: the new body and columns are IDENTICAL to the stored row for '${partKey}'.\n` +
          `  Nothing would change. Reporting success here would tell you a rule was updated\n` +
          `  when it was not.`,
      );
    }

    console.log(`set-doc-part: ${WORKSPACE_ID}/${HARNESS_SLUG}/${docId}`);
    console.log(
      `  part         ${partKey}${existing ? "" : "  (NEW — --create)"}`,
    );
    console.log(
      `  columns      kind=${merged.kind} ordinal=${merged.ordinal} rank=${merged.projectRank} ` +
        `scope=${JSON.stringify(merged.clientScope)}` +
        `${merged.stackScope.length ? ` addressed=${JSON.stringify(merged.stackScope)}` : ""}`,
    );
    console.log(`  section      ${merged.targetSection ?? "(none)"}`);
    if (existing) {
      console.log(describeChange(existing.body, body));
      console.log(describeColumnChanges(existing, nextComparable));
    } else console.log(`    new body    ${body.length} chars`);

    // ── projection impact ────────────────────────────────────────────────────
    // Computed IN MEMORY from the pre-edit rows this open transaction can still see,
    // so the author learns what their edit displaces from the command that makes it.
    // Before this, the only eviction signal was project-doc-parts' absolute `⚠ cut:`
    // line — a DIFFERENT command, run later, if at all.
    const proj = await loadProjector();
    const beforeRows: ProjectionRow[] = await proj.readProjectedParts(
      client,
      docId,
    );
    const afterRows = applyEditInMemory(
      beforeRows,
      partKey,
      merged.clientScope.length > 0
        ? {
            part_key: partKey,
            kind: merged.kind,
            body,
            ordinal: merged.ordinal,
            client_scope: merged.clientScope,
            target_section: merged.targetSection,
            project_rank: merged.projectRank,
            stack_scope: merged.stackScope,
          }
        : null,
    );
    const impacts = evictionDelta({
      before: beforeRows,
      after: afterRows,
      clients: proj.CLIENTS,
      docId,
      budget: budgetFor(proj),
      projectClient: proj.projectClient,
      partKey,
    });
    console.log(renderImpact(impacts, partKey));
    console.log(await launchProseNotice(proj, docId, beforeRows, afterRows));

    // A NEW part that projects nowhere is the create-side of the same blind spot: the
    // row is written, `✓ written` is printed, and the text reaches no agent — which is
    // how rule-shaped content ends up filed as corpus-only prose and stays there. This
    // is a NOTICE, not a gate: corpus-only parts are legitimate and numerous, so the
    // author is told what they got, not stopped (EI-22179257919368370).
    if (!existing && merged.clientScope.length === 0) {
      console.log(
        `\n  ⓘ '${partKey}' is CORPUS-ONLY — client_scope is empty, so it projects into\n` +
          `    no client file and no agent's launch context will carry it. It is still\n` +
          `    searchable in the corpus. If you meant this to be a RULE, pass\n` +
          `    --client-scope all (and a --kind other than 'prose', which may never project).`,
      );
    }

    // ── canonical identity ───────────────────────────────────────────────────
    // The projector REFUSES to write any client file while a canonical row disagrees
    // with its own generated key, and that refusal is GLOBAL — one bad row blocks
    // CLAUDE.md, AGENTS.md and the corpus for every part in the batch. Checking it only
    // there meant this script printed `✓ written` for a body the very next command
    // rejects, leaving canonical Postgres ahead of every file that projects it, with a
    // clean-looking `projection impact` report in between (EI-21968678099053129).
    //
    // The rule is IMPORTED, never re-spelled — the same reasoning that makes
    // `validateDocPart` a shared import above. It stays in the projector rather than
    // moving into `validateDocPart` because it is a statement about how the PROJECTOR
    // generates keys, and because its `#evidence` half is defined over sibling rows;
    // `validateDocPart` judges ONE row in isolation and mirrors migration 781's column
    // CHECKs, neither of which can express it.
    //
    // Unlike the projection rows above, the edited part is passed even when its
    // client_scope is empty: an unprojected part is still a live canonical row, and
    // dropping it would hide the sibling relationships the rule is defined over.
    const identityBefore = await proj.readAllParts(client, docId);
    const { introduced, preexisting } = identityProblemDelta({
      before: identityBefore,
      after: applyEditInMemory(identityBefore, partKey, {
        part_key: partKey,
        kind: merged.kind,
        body,
        ordinal: merged.ordinal,
        client_scope: merged.clientScope,
        target_section: merged.targetSection,
        project_rank: merged.projectRank,
        stack_scope: merged.stackScope,
      }),
      detect: proj.docPartIdentityProblems,
    });

    // Not this author's doing — but it IS silently blocking their projection, which is
    // the whole complaint: three legal edits sat unprojected behind somebody's fourth.
    if (preexisting.length > 0) {
      console.log(
        `\n  ⚠ projection is ALREADY blocked by ${preexisting.length} pre-existing identity ` +
          `problem(s)\n    not introduced by this edit. Until they are fixed, ` +
          `project-doc-parts writes NO client\n    file — including this part's:`,
      );
      for (const p of preexisting) {
        console.log(`      ${p.part_key} [${p.code}] ${p.detail}`);
      }
    }

    if (introduced.length > 0) {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: this edit would leave ${introduced.length} canonical row(s) disagreeing\n` +
          `  with their generated key, and project-doc-parts REFUSES TO WRITE ANY CLIENT FILE\n` +
          `  while that is true — CLAUDE.md, AGENTS.md and the corpus would all stay stale,\n` +
          `  including every OTHER part edited alongside this one.\n\n` +
          introduced
            .map((p) => `    ${p.part_key} [${p.code}] ${p.detail}`)
            .join("\n") +
          `\n\n  Keep one of the named tokens in the body, or rename the part (--part-key).`,
      );
    }

    if (!write) {
      await client.query("ROLLBACK");
      console.log(
        "\n  ✓ dry run — nothing written. Re-run with --write to apply.",
      );
      return;
    }

    // De-projection is gated SEPARATELY from eviction, and first, because it is the
    // more silent of the two and it is a DIFFERENT consent. `--accept-evictions` means
    // "I accept crowding OTHER parts out"; it must not double as blanket permission to
    // delete the rule I am editing from every agent's context — which is what a single
    // shared flag would make it, including when the empty scope was a typo.
    //
    // Nothing else in the pipeline reports this. The projector's `⚠ cut:` list covers
    // budget cuts only, and this part is not cut — it is absent, so it appears in no
    // list at all while `project-doc-parts --write` still exits 0 (EI-22179257919368370).
    // P-022: an ADDRESSED part leaves the default file BY DESIGN — that is what
    // `--stack-scope` asks for — so the projector's "de-projected" verdict on the
    // default composition is the expected outcome, not the silent loss the guard below
    // exists to stop. It still has a client_scope, still projects, and still reaches
    // every launch whose stack matches; say so, and do not demand a second flag for
    // the thing the author just spelled out.
    const narrowedToAudience =
      merged.stackScope.length > 0 && merged.clientScope.length > 0;
    if (narrowedToAudience && (!existing || impacts.some((i) => i.deprojected))) {
      console.log(
        `\n  ⓘ '${partKey}' is ADDRESSED (${merged.stackScope.join(", ")}): it leaves the default\n` +
          `    ${impacts.filter((i) => i.deprojected).map((i) => i.file).join(" / ")} and is spliced at launch only into a\n` +
          `    session whose stack matches one of those tokens (role-launch-spec → composeProjectGuideForWearer).\n` +
          `    Preview what such a launch receives: node scripts/project-doc-parts.mjs --audience=${merged.stackScope.join(",")}`,
      );
    }
    const deprojecting = impacts.filter(
      (i) => i.deprojected && !narrowedToAudience,
    );
    if (
      deprojecting.length > 0 &&
      args.get("accept-deprojection") !== true
    ) {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: this edit empties '${partKey}'s client_scope, removing it from ` +
          `${deprojecting.map((i) => i.file).join(", ")}.\n` +
          `  The row would stay live and searchable (tombstone=false), so nothing\n` +
          `  downstream would read as broken — and no agent's launch context would ever\n` +
          `  carry this rule again. That is the failure this guard exists to stop, not a\n` +
          `  budget eviction, so --accept-evictions does NOT cover it.\n\n` +
          `  Keep it projecting with --client-scope all, or re-run with\n` +
          `  --accept-deprojection to demote it to corpus-only on purpose.`,
      );
    }

    // Eviction is gated, growth is not. A net-negative headroom change is ordinary and
    // harmless; a rule DISAPPEARING from every agent's context is the actual damage, and
    // it is the one outcome an author never intends silently. Same shape as the
    // dark-flags watermark: the write is not forbidden, it is made deliberate.
    const evicting = impacts.filter((i) => i.evicted.length > 0);
    if (evicting.length > 0 && args.get("accept-evictions") !== true) {
      await client.query("ROLLBACK");
      die(
        REFUSED,
        `✗ refused: this edit would evict ${evicting
          .map((i) => `${i.evicted.length} part(s) from ${i.file}`)
          .join(", ")}.\n` +
          `  The evicted rules are listed above — they would vanish from every agent's\n` +
          `  context, and nothing else in the pipeline would report it as YOUR doing.\n` +
          `  Shorten this body, or re-run with --accept-evictions to do it on purpose.`,
      );
    }

    const input: SetDocPartInput = {
      harnessSlug: HARNESS_SLUG,
      docId,
      partKey,
      workspaceId: WORKSPACE_ID,
      kind: merged.kind,
      body,
      ordinal: merged.ordinal,
      tombstone: false,
      author,
      clientScope: merged.clientScope,
      projectRank: merged.projectRank,
      targetSection: merged.targetSection,
      rationalePartKey: merged.rationalePartKey,
      stackScope: merged.stackScope,
    };

    // `author` is set on purpose: the hand-rolled UPDATEs this script replaces left it
    // null, so who changed a fleet-wide rule was unrecoverable. The projector's cache
    // columns (content/content_hash/generated_from_sha) are NOT touched here — they
    // belong to project-doc-parts.mjs, and writing them would corrupt the very values
    // its overwrite guard trusts to recognise its own output.
    await client.query(
      `INSERT INTO harness_shared.harness_doc_parts
         (workspace_id, harness_slug, doc_id, part_key, kind, body, ordinal, client_scope,
          target_section, project_rank, rationale_part_key, author, stack_scope, tombstone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)
       ON CONFLICT (workspace_id, harness_slug, doc_id, part_key)
       DO UPDATE SET kind = EXCLUDED.kind, body = EXCLUDED.body, ordinal = EXCLUDED.ordinal,
                     client_scope = EXCLUDED.client_scope, target_section = EXCLUDED.target_section,
                     project_rank = EXCLUDED.project_rank,
                     rationale_part_key = EXCLUDED.rationale_part_key,
                     author = EXCLUDED.author, stack_scope = EXCLUDED.stack_scope, tombstone = false,
                     updated_at = (EXTRACT(epoch FROM now()) * 1000)::bigint`,
      [
        input.workspaceId,
        input.harnessSlug,
        input.docId,
        input.partKey,
        input.kind,
        input.body,
        input.ordinal,
        input.clientScope,
        input.targetSection,
        input.projectRank,
        input.rationalePartKey,
        input.author,
        input.stackScope,
      ],
    );
    await client.query("COMMIT");

    console.log(`\n  ✓ written (author=${author ?? "null"}).`);
    console.log(
      "  The FILE is still the old projection — parts are canonical, files are output.",
    );
    console.log(
      "  Project it now:   node scripts/project-doc-parts.mjs --write",
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
