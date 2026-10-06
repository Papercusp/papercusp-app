/**
 * Parse `tsc --pretty false` output into structured diagnostics.
 *
 * Plan `bash-to-tool-substitution-2026-07-26`, P-024. Backs `build:typecheck`
 * the way `distillVitestRun` backs `testing:run` — the projection lives here so
 * it is unit-testable against real compiler output without spawning a compiler.
 *
 * ## Relationship to `scripts/lib/tsc-baseline-gate.mjs`
 *
 * That module already has a `parseTscErrors`, and this is deliberately NOT a
 * fork of it. The baseline gate needs exactly `{ file, code }` — it counts
 * errors per file against a committed baseline, so line/column/message would be
 * dead weight there. An AGENT needs the opposite: the message is the entire
 * point, because the whole cost this tool removes is the agent piping a
 * compiler log through `grep`/`tail` to read those messages. So this is a
 * widening of the same grammar for a different consumer, kept here rather than
 * pushed into the gate because loading a `scripts/**.mjs` at tool-dispatch time
 * would tie a hot agent surface to an untyped CLI helper.
 *
 * ## The no-op codes are the load-bearing part
 *
 * A tsc run that checked NOTHING exits non-zero and prints one line. Piped
 * through the `| grep <myfile>` that 42% of no-op runs in the corpus used, it
 * prints nothing at all — which reads as "no errors in my file". Naming those
 * codes ({@link NO_INPUT_CODES}) is what lets the tool refuse the run instead
 * of reporting a clean zero, the same way `testing:run` refuses a zero-match
 * Vitest run rather than passing vacuously.
 */

/** One compiler diagnostic. `file` is null for a global error (TS5057, TS6053, …). */
export interface TscDiagnostic {
  file: string | null;
  line: number | null;
  column: number | null;
  code: string;
  category: 'error' | 'warning';
  message: string;
}

/** Per-file error counts, most errors first — the `| grep -c` an agent writes by hand. */
export interface TscFileCount {
  file: string;
  count: number;
}

/**
 * Diagnostic codes meaning "this invocation checked no files at all".
 *
 * Verified live against TypeScript 6.0.3 at the papercusp repo root, which has
 * no root `tsconfig.json` (only `tsconfig.base.json`):
 *   - TS5057 — `tsc -p .`             → "Cannot find a tsconfig.json file at the specified directory"
 *   - TS5058 — `tsc -p tsconfig.json` → "The specified path does not exist"
 *   - TS18003 — a tsconfig that EXISTS but whose include/files match nothing
 *   - TS6053 — a file operand that does not exist
 */
export const NO_INPUT_CODES = new Set(['TS5057', 'TS5058', 'TS6053', 'TS18003']);

/**
 * NO COMPILER RAN AT ALL — the registry squatter `tsc@2.0.4` ran instead of the
 * real compiler (EI-22142032090978471).
 *
 * `npx <tool>` does not fail when the tool is missing from `node_modules/.bin` — it
 * downloads and runs whatever registry package carries that name. For `tsc` that is
 * `tsc@2.0.4` ("A deprecated release of the TypeScript compiler"), whose entire body
 * prints a banner and sets `process.exitCode = 1`. Measured 2026-09-02: it exits 1 in
 * every invocation shape, including a cold npx cache, so it never produced a false
 * green here — every caller's "nonzero exit with no diagnostics" guard already caught
 * it. What they all got wrong was the CAUSE, sending the reader after the project
 * operand or the tsconfig when the real condition is a missing/half-written
 * `node_modules`.
 *
 * This lives beside {@link NO_INPUT_CODES} because it answers the same question those
 * codes do — "did this run measure anything?" — one rung lower: those mean tsc ran and
 * found no inputs; this means tsc never ran.
 *
 * Deliberately NOT keyed on the banner's other line ("To get access to the TypeScript
 * compiler…"): that is ordinary English about TypeScript and could plausibly reach an
 * output buffer from a diagnostic message or a path. The Star Wars joke below is
 * emitted by nothing else, and a false positive here would mislabel a REAL failure.
 */
export const TSC_DECOY_BANNER = /This is not the tsc command you are looking for/;

/** `path/to/file.ts(12,5): error TS2322: message` */
const LOCATED = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;
/** `error TS5057: message` — a global failure with no file attribution. */
const GLOBAL = /^\s*(error|warning)\s+(TS\d+):\s*(.*)$/;
/** tsc's own trailing tally, used as a parser cross-check. */
const FOUND = /^Found (\d+) errors? in (\d+) files?\.?$/;
const FOUND_ZERO = /^Found 0 errors?\.?$/;

/**
 * Cap on how much of a multi-line diagnostic's nested detail is retained.
 *
 * The nested lines are usually where the actual cause is ("Types of property
 * 'a' are incompatible"), so dropping them entirely would hand back a message
 * an agent has to go re-read the raw log for — re-creating the pipe this tool
 * exists to remove. But an assignability error between two large object types
 * can nest for dozens of lines, so it is bounded rather than unbounded.
 */
const MAX_MESSAGE_CHARS = 400;

/**
 * Parse raw `tsc` output. Tolerates the `--pretty` layout being absent (we always
 * pass `--pretty false`) and ignores progress/version chatter.
 *
 * Nested continuation lines (leading whitespace) are folded into the preceding
 * diagnostic's message, whitespace-collapsed and capped.
 */
export function parseTscDiagnostics(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  let current: TscDiagnostic | null = null;
  let truncated = false;

  const flush = () => {
    if (current) {
      current.message = current.message.trim();
      diagnostics.push(current);
    }
    current = null;
    truncated = false;
  };

  for (const rawLine of String(output).split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    // A continuation line belongs to the diagnostic above it.
    if (current && /^\s+\S/.test(line)) {
      if (!truncated) {
        const next = `${current.message} ${line.trim()}`;
        if (next.length > MAX_MESSAGE_CHARS) {
          current.message = `${next.slice(0, MAX_MESSAGE_CHARS)}…`;
          truncated = true;
        } else {
          current.message = next;
        }
      }
      continue;
    }

    const located = LOCATED.exec(line);
    if (located) {
      flush();
      current = {
        file: located[1],
        line: Number(located[2]),
        column: Number(located[3]),
        code: located[5],
        category: located[4] as 'error' | 'warning',
        message: located[6],
      };
      continue;
    }

    const global = GLOBAL.exec(line);
    if (global) {
      flush();
      current = {
        file: null,
        line: null,
        column: null,
        code: global[2],
        category: global[1] as 'error' | 'warning',
        message: global[3],
      };
      continue;
    }

    flush();
  }
  flush();

  return diagnostics;
}

/**
 * tsc's own `Found N errors in M files.` tally, or null when absent.
 *
 * Used as a parser cross-check: if our count and tsc's disagree, the grammar has
 * drifted from the compiler's output format and the caller is told, rather than
 * silently reporting a wrong number. A compiler upgrade changing the diagnostic
 * layout is exactly the kind of change nothing else here would catch.
 */
export function parseFoundSummary(output: string): number | null {
  for (const rawLine of String(output).split('\n')) {
    const line = rawLine.trim();
    if (FOUND_ZERO.test(line)) return 0;
    const found = FOUND.exec(line);
    if (found) return Number(found[1]);
  }
  return null;
}

/** Errors only (warnings are not gating and would inflate the count). */
export function errorsOnly(diagnostics: TscDiagnostic[]): TscDiagnostic[] {
  return diagnostics.filter((d) => d.category === 'error');
}

/**
 * TypeScript parser/scanner diagnostic codes in the TS1xxx range.
 *
 * Do not classify the whole /^TS1\d{3}$/ range as syntax: TS1320 is a semantic
 * await/type diagnostic even though it shares that numeric range. This set is
 * derived from the parser and scanner's Diagnostics references in the
 * TypeScript 6.0.3 bundled compiler.
 */
const SYNTAX_DIAGNOSTIC_CODES = new Set(
  [
    1002, 1003, 1005, 1007, 1010, 1011, 1012, 1034, 1068, 1069, 1109, 1110, 1121, 1124, 1125,
    1126, 1127, 1128, 1129, 1130, 1131, 1132, 1134, 1135, 1136, 1137, 1138, 1139, 1140,
    1142, 1144, 1145, 1146, 1160, 1161, 1177, 1178, 1179, 1180, 1181, 1198, 1199, 1209,
    1223, 1228, 1260, 1351, 1352, 1353, 1357, 1359, 1369, 1381, 1382, 1385, 1386, 1387,
    1388, 1389, 1390, 1433, 1434, 1435, 1436, 1437, 1438, 1439, 1440, 1441, 1442, 1443,
    1472, 1477, 1478, 1487, 1488, 1489, 1490, 1499, 1500, 1501, 1502, 1503, 1504, 1505,
    1506, 1507, 1508, 1509, 1510, 1511, 1512, 1513, 1514, 1515, 1516, 1517, 1518, 1519,
    1520, 1521, 1522, 1523, 1524, 1525, 1526, 1527, 1528, 1529, 1530, 1531, 1532, 1533,
    1534, 1535, 1536, 1537, 1538,
  ].map((code) => `TS${code}`),
);

/**
 * Files with a parser/scanner error. Such a file fails to compile at all, so
 * tsc UNDER-REPORTS everything downstream of it — surfaced here so an agent
 * reading a small error count knows whether to trust it. The baseline gate
 * separately retains its broader TS1xxx hard-fail policy.
 */
export function syntaxBrokenFiles(diagnostics: TscDiagnostic[]): string[] {
  const files = new Set<string>();
  for (const d of diagnostics) {
    if (SYNTAX_DIAGNOSTIC_CODES.has(d.code)) files.add(d.file ?? '(unattributed)');
  }
  return [...files].sort();
}

/** Per-file error counts, most errors first, then alphabetically for stability. */
export function summariseByFile(diagnostics: TscDiagnostic[]): TscFileCount[] {
  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    const key = d.file ?? '(unattributed)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

/**
 * The diagnostic proving this invocation checked nothing, or null.
 *
 * Returned rather than a boolean so the caller can quote the compiler's own
 * wording back — "TS5057: Cannot find a tsconfig.json file at the specified
 * directory: '.'" explains the refusal far better than any message we could
 * write, and it is the compiler's word rather than our inference.
 */
export function noInputDiagnostic(diagnostics: TscDiagnostic[]): TscDiagnostic | null {
  return diagnostics.find((d) => NO_INPUT_CODES.has(d.code) && vanishedIncludeFile(d) === null) ?? null;
}

/**
 * tsc's own explanation that a missing file entered the program through an `include`
 * GLOB. Verified against TypeScript 6.0.3 by listing a file in the glob and deleting it
 * before the read; tsc prints, and parseTscDiagnostics folds into one message:
 *
 *   error TS6053: File '/r/lib/gone.ts' not found.
 *     The file is in the program because:
 *       Matched by include pattern 'lib/** /*.ts' in '/r/tsconfig.json'
 *
 * A missing CLI operand explains itself as "Root file specified for compilation" and a
 * missing `files` entry as "Part of 'files' list in tsconfig.json", so neither matches.
 */
const INCLUDE_MATCH_EXPLANATION = /\bThe file is in the program because:.*\bMatched by include pattern '/;
const NOT_FOUND_FILE = /^File '([^']+)' not found\./;

/**
 * The path of a file the program found through an include glob and could not read, or
 * null (EI-24801454238382823).
 *
 * That TS6053 is NOT "checked nothing": the glob listed the file, then it was deleted
 * before tsc read it, and every other file in the program WAS checked. On this shared
 * checkout that is ordinary tree churn (a peer's short-lived probe directory under
 * `lib/**` refused two consecutive operator-core typechecks as `nothing_typechecked`,
 * quoting "zero files were typechecked", which was false). A TS6053 without this
 * explanation keeps its no-input meaning: a missing operand really does check nothing.
 */
export function vanishedIncludeFile(d: TscDiagnostic): string | null {
  if (d.code !== 'TS6053' || d.file !== null) return null;
  if (!INCLUDE_MATCH_EXPLANATION.test(d.message)) return null;
  return NOT_FOUND_FILE.exec(d.message)?.[1] ?? null;
}

/**
 * Split out the include-glob files that vanished between listing and reading.
 * `rest` is every other diagnostic, in order; `vanished` is de-duplicated.
 */
export function splitVanishedIncludeFiles(diagnostics: TscDiagnostic[]): {
  vanished: string[];
  rest: TscDiagnostic[];
} {
  const vanished = new Set<string>();
  const rest: TscDiagnostic[] = [];
  for (const d of diagnostics) {
    const path = vanishedIncludeFile(d);
    if (path === null) rest.push(d);
    else vanished.add(path);
  }
  return { vanished: [...vanished], rest };
}

/**
 * Keep only diagnostics attributed to one of `files`.
 *
 * Matching is by path SUFFIX after normalising separators, because the caller
 * names a repo-root-relative path while tsc emits a path relative to the
 * tsconfig's own directory. Suffix matching is anchored at a segment boundary so
 * `lib/run.ts` cannot match `lib/prerun.ts`.
 */
export function filterToFiles(diagnostics: TscDiagnostic[], files: string[]): TscDiagnostic[] {
  const wanted = files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
  return diagnostics.filter((d) => {
    if (!d.file) return false;
    const path = d.file.replace(/\\/g, '/');
    return wanted.some((w) => path === w || path.endsWith(`/${w}`) || w.endsWith(`/${path}`) || w === path);
  });
}

/**
 * Keep only diagnostics whose file falls under one of `dirs` — a directory
 * PREFIX match, anchored at a path-segment boundary so `apps/operator` cannot
 * match `apps/operator-vite`. This is the server-side form of `grep -E
 * '^dir/'`, for the directory-ATTRIBUTION question `filterToFiles` (a suffix
 * match) cannot express: "does ANY error fall under apps/operator-vite/?"
 * (EI-22050606808498557) is not expressible as a set of full/suffix file
 * paths when the caller does not know — or does not want to enumerate —
 * every file the directory contains.
 */
export function filterToDirs(diagnostics: TscDiagnostic[], dirs: string[]): TscDiagnostic[] {
  const wanted = dirs.map((d) => d.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  return diagnostics.filter((d) => {
    if (!d.file) return false;
    const path = d.file.replace(/\\/g, '/');
    return wanted.some((w) => path === w || path.startsWith(`${w}/`));
  });
}
