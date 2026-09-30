#!/usr/bin/env node
/**
 * proc-guard — a process-liveness check that CANNOT self-match.
 *
 * WHY THIS EXISTS (EI-18666147162251862): the Bash tool (and admin-commands.ts's
 * SSE command runner) invoke every command as `bash -c '<the whole command
 * string>'` / `bash -lic '<...>'`, so the COMMAND STRING ITSELF is a live line in
 * the process table for as long as that shell runs. A bare `pgrep -f <pattern>` /
 * `pkill -f <pattern>` matches against FULL cmdlines *system-wide* — not just
 * descendants — so any pattern that appears literally anywhere in your own
 * invocation (inside the pgrep call's own argument, an echo, a comment) matches
 * your own wrapper. This is trivially reproducible and has nothing to do with
 * whether the real target process is running:
 *
 *   bash -c 'if pgrep -f "definitely-not-a-real-process-zzqq" >/dev/null; \
 *              then echo MATCHED; else echo NOMATCH; fi'
 *   # => MATCHED, even though nothing by that name exists anywhere — pgrep
 *   #    matched its OWN invoking bash -c process, whose cmdline contains the
 *   #    pattern text literally (as the pgrep argument itself).
 *
 * A guard built on this pattern fails in BOTH directions: it can report "already
 * running" when it isn't (a destructive start is skipped) and, via `pkill -f`,
 * can kill the CALLING shell itself (the pattern matches the caller's own
 * ancestor, not just the intended target) — see the work-item for a live repro
 * of both.
 *
 * THE FIX: walk the CALLER's own ancestor chain (parent, grandparent, ... up to
 * pid 1) and exclude every pid in it before matching, so a caller running inside
 * a `bash -c` / `-lic` wrapper whose own command line happens to contain the
 * pattern text is never mistaken for a real match — while a genuinely unrelated
 * external process with the same pattern in its cmdline still matches.
 *
 * A second, independent false-positive class is agent launchers: their argv can
 * carry a long `PAPERCUSP_KICKOFF_PROMPT=...` shell assignment or a turn prompt
 * as the final argument. Those are operator prose, not the executable or its
 * runtime arguments. Matching the raw joined cmdline therefore reports a live
 * agent as a running gate/script whenever its prompt happens to name that gate.
 * `getOperationalArgv` removes those known prompt payload arguments while
 * retaining the executable and all other process arguments (including qemu's
 * image/path arguments). The detailed matcher reports both views so a caller can
 * audit what was ignored instead of mistaking a raw argv count for liveness.
 *
 * A THIRD false-positive class, and the one that grows with fleet size, is a
 * PEER's structured payload (EI-20303820187580514). Agent hook and tool
 * processes are invoked as `python3 - '<json>'` / `node <tool> '<json>'`, where
 * the JSON argument carries whatever that agent is currently working on — so a
 * peer writing a checkpoint ABOUT the green-checkpoint gate puts the literal
 * text "green-checkpoint" in its argv. Ancestor-exclusion above cannot help:
 * those peers are unrelated third parties, not the caller's ancestors. Marker
 * matching could not help either, because the payload carries no fixed marker.
 * The discriminator is STRUCTURAL — an argv entry that parses as a JSON
 * object/array is data the process was handed, never the process's identity —
 * and it was validated against this box's live /proc rather than assumed:
 * across 3,288 processes plus a 20s sweep of transient hook processes, all 49
 * observed JSON-shaped payloads (`{"session_id":…}` hook envelopes up to 12KB,
 * `claude --settings {…}`, `ptool` checkpoint bodies) parsed cleanly, and ZERO
 * argv entries started like JSON but failed to parse — so no length heuristic
 * or truncation fallback is warranted.
 *
 * Note the failure direction this protects: a false NEGATIVE is corrected by
 * the very next check, but a false POSITIVE reports "4 gate processes running"
 * when one is, which reads as a stampede and invites an agent to intervene
 * against a healthy run — or to stand down from a stalled one.
 *
 * CLI:
 *   node scripts/proc-guard.mjs check <pattern>
 *     Exit 0 + print every operationally matching row (pid + bounded cmdline) when
 *     at least one EXTERNAL (non-self, non-ancestor) process matches. Exit 1 + a
 *     "no match" line otherwise. The output includes the full-argv count and
 *     argv-text-only count so prompt collisions are visible but cannot turn a
 *     liveness check into a permanent YES. Pass --verbose to print the full
 *     command line instead of the bounded display form.
 *   node scripts/proc-guard.mjs tree <pid> [--max-nodes=<n>] [--max-depth=<n>] [--budget-ms=<n>]
 *     Print one PID-rooted process tree without enumerating the host process
 *     table. Child discovery reads only the target's per-thread `children`
 *     files under /proc/<pid>/task and is
 *     bounded by node count, depth, and wall-clock budget.
 *
 * Library (unit-tested against a fixture /proc — see proc-guard.test.ts;
 * `procRoot` / `selfPid` are both injectable for that reason):
 *   listProcesses(procRoot?)              -> [{ pid, ppid, argv, cmdline }]
 *   getAncestryChain(pid, byPid)           -> Set<pid> (pid + every ancestor, incl. pid 1)
 *   isStructuredPayloadArg(arg)           -> is this argv entry a JSON payload (data, not identity)?
 *   getOperationalArgv(argv)              -> argv with prompt + structured payloads removed
 *   matchesAdjacentArgvSequence(argv, seq) -> interpreter-backed literal argv adjacency match
 *   matchExternalProcesses(pattern, opts) -> operational/identity matching rows, self + ancestors excluded
 *   matchExternalProcessesDetailed(...)   -> operational, full, and argv-text-only rows
 */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import path from "node:path";

const DEFAULT_PROC_ROOT = "/proc";
const SANDBOX_PID_ONE_RE = /(?:@anthropic-ai\/sandbox-runtime|\/sandbox-runtime\/).*\/apply-seccomp(?:\s|$)/;
const GREEN_CHECKPOINT_PATTERN = /green(?:\\?[-_])checkpoint/i;
const GREEN_CHECKPOINT_CGROUP =
  /(?:^|\/)(?:papercup|papercusp)-green-checkpoint(?:[-./]|$)/i;

/**
 * One live process, as read out of `/proc`.
 *
 * @typedef {object} ProcRow
 * @property {number} pid
 * @property {number | null} ppid - null when `/proc/<pid>/stat` was unreadable or unparseable.
 * @property {string[]} argv - Raw process arguments, decoded from NUL-separated cmdline.
 * @property {string} cmdline - Full command line, NUL separators replaced by spaces.
 * @property {{ ownerId: string | null; greenCheckpointMarker: boolean; releaseGateMarker: boolean; cgroupPath: string | null; integrationRoot: string | null }} [identity]
 *   Non-secret identity evidence read from PAPERCUSP_SID, known gate markers,
 *   and PAPERCUSP_INTEGRATION_ROOT (which tree this process is working on).
 */

/**
 * A successful cgroup CPU sample. The literal status is load-bearing: callers
 * narrow on it before reading the measurement-only fields.
 *
 * @typedef {object} CgroupBusyOk
 * @property {'ok'} status
 * @property {number} cores
 * @property {number | null} procs
 * @property {number} elapsedMs
 * @property {string} cgroupPath
 */

/**
 * An indeterminate cgroup CPU sample. Missing measurement fields are explicit
 * so callers may render them as absent without collapsing UNKNOWN into zero.
 *
 * @typedef {object} CgroupBusyUnknown
 * @property {'unknown'} status
 * @property {string} reason
 * @property {string | null} [cgroupPath]
 * @property {number} [elapsedMs]
 * @property {undefined} [cores]
 * @property {undefined} [procs]
 */

/** @typedef {CgroupBusyOk | CgroupBusyUnknown} CgroupBusySample */

const PROMPT_ARG_MARKERS = ["PAPERCUSP_KICKOFF_PROMPT=", "⟦turn-origin:"];
const PROMPT_ARG_PREFIXES = ["--kickoff=", "--label="];
const CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV =
  "PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID";
const CAPABILITY_BASH_SLICE = "papercusp-bash-job.slice";
const DEFAULT_INTERPRETER_BASENAMES = new Set([
  "node",
  "nodejs",
  "npx",
  "npm",
  "gitnexus",
  "gitnexus.js",
]);
const DEFAULT_PROCESS_CMDLINE_MAX_CHARS = 200;

/**
 * Parse a NUL-separated /proc/<pid>/cmdline buffer into a display string (space-joined args).
 *
 * @param {Buffer | string} raw
 * @returns {string}
 */
export function parseCmdline(raw) {
  return parseArgv(raw).join(" ");
}

/**
 * Parse a NUL-separated `/proc/<pid>/cmdline` buffer into argv entries.
 *
 * @param {Buffer | string} raw
 * @returns {string[]}
 */
export function parseArgv(raw) {
  return raw
    .toString("utf8")
    .split("\0")
    .filter((s) => s.length > 0);
}

/**
 * Format a process command line for human-facing output without flooding a
 * terminal with a launcher's embedded work-item brief.
 *
 * @param {string} cmdline
 * @param {{ verbose?: boolean }} [opts]
 * @returns {string}
 */
export function formatProcessCmdline(cmdline, opts = {}) {
  const text = String(cmdline);
  if (opts.verbose || text.length <= DEFAULT_PROCESS_CMDLINE_MAX_CHARS)
    return text;
  return `${text.slice(0, DEFAULT_PROCESS_CMDLINE_MAX_CHARS - 1)}…`;
}

/**
 * Is this argv entry a structured payload the process was HANDED, rather than
 * part of the process's own identity?
 *
 * An argument that parses as a JSON object/array is by construction data — a
 * hook envelope, a settings blob, a tool-call body. Its contents name whatever
 * the emitting agent was working on, so matching against it reports a peer's
 * SUBJECT as if it were a running process (EI-20303820187580514).
 *
 * The check is deliberately strict: it requires balanced object/array
 * delimiters AND a successful parse, so a shell/jq argument that merely starts
 * with `{` (e.g. jq's `{a:1}`, which is not valid JSON) stays operational.
 *
 * @param {string} arg
 * @returns {boolean}
 */
export function isStructuredPayloadArg(arg) {
  const trimmed = arg.trim();
  if (trimmed.length < 2) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]")))
    return false;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function isPromptPayloadArg(arg) {
  return (
    PROMPT_ARG_MARKERS.some((marker) => arg.includes(marker)) ||
    PROMPT_ARG_PREFIXES.some((prefix) => arg.startsWith(prefix))
  );
}

/**
 * Remove agent prompt payloads and peers' structured (JSON) payloads from argv
 * before process matching. The executable and every real argument remain
 * eligible, so commands such as `qemu-system-x86_64 ... mac_hdd_ng.img` retain
 * their target args.
 *
 * Index 0 is always kept: the executable is the process's identity even in the
 * pathological case of a binary whose path parses as JSON.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function getOperationalArgv(argv) {
  return argv.filter(
    (arg, index) =>
      index === 0 || (!isPromptPayloadArg(arg) && !isStructuredPayloadArg(arg)),
  );
}

function argvBasename(arg) {
  return path.basename(String(arg).replaceAll("\\", "/"));
}

/**
 * Is this the transient-service client that capability:bash launched for the
 * CURRENT command?
 *
 * A confined capability:bash payload runs in a transient service, while the
 * `systemd-run --pipe --wait` client remains a sibling of that payload from
 * the payload's point of view. Its command string therefore contains the
 * proc-guard pattern and defeats ancestor exclusion. The task marker is set by
 * the capability:bash handler after caller env input is applied, so matching
 * the exact current task id plus the managed unit/slice and service-only
 * `--pipe --wait` shape is the narrow identity boundary. PAPERCUSP_SID alone
 * is intentionally not used: every process in the same agent session may
 * carry it, including a real target that must remain visible.
 *
 * @param {string[]} argv
 * @param {string | null | undefined} taskId
 * @returns {boolean}
 */
export function isCapabilityBashSystemdRunWrapper(argv, taskId) {
  if (typeof taskId !== "string" || !taskId) return false;
  const operationalArgv = getOperationalArgv(argv);
  const expectedUnit = `--unit=pc-${taskId}.service`;
  return (
    argvBasename(operationalArgv[0] ?? "") === "systemd-run" &&
    operationalArgv.includes("--user") &&
    operationalArgv.includes("--pipe") &&
    operationalArgv.includes("--wait") &&
    operationalArgv.includes(expectedUnit) &&
    operationalArgv.includes(`--slice=${CAPABILITY_BASH_SLICE}`)
  );
}

function isCommandToken(arg, commandName, commandBasenames) {
  const normalized = String(arg).replaceAll("\\", "/");
  if (commandBasenames.has(path.posix.basename(normalized))) return true;

  const pathSegments = normalized.split("/");
  return pathSegments.some(
    (segment, index) =>
      segment === "node_modules" && pathSegments[index + 1] === commandName,
  );
}

/**
 * Match a literal command sequence at argv-token boundaries.
 *
 * The first sequence token is compared by basename, so an installed binary
 * such as `/repo/node_modules/.bin/gitnexus` is equivalent to `gitnexus`.
 * Interpreter-launched package entrypoints are also recognized when their
 * token lives under `node_modules/<command>/`, for example
 * `/repo/node_modules/gitnexus/dist/cli/index.js`.
 * Every following token is compared literally and must be immediately
 * adjacent. The argv[0] basename must also be an interpreter that could
 * execute the command. This prevents prose in a JSON/tool payload or a
 * `node -e 'gitnexus analyze'` script from becoming a process match.
 *
 * @param {string[]} argv
 * @param {string[]} sequence - e.g. ['gitnexus', 'analyze']
 * @param {{ interpreterBasenames?: string[]; commandBasenames?: string[] }} [opts]
 * @returns {boolean}
 */
export function matchesAdjacentArgvSequence(argv, sequence, opts = {}) {
  if (
    !Array.isArray(sequence) ||
    sequence.length < 2 ||
    sequence.some((token) => typeof token !== "string" || !token)
  ) {
    return false;
  }

  const operationalArgv = getOperationalArgv(argv);
  const interpreterBasenames = new Set(
    opts.interpreterBasenames ?? DEFAULT_INTERPRETER_BASENAMES,
  );
  if (!interpreterBasenames.has(argvBasename(operationalArgv[0] ?? "")))
    return false;

  const commandBasenames = new Set(
    opts.commandBasenames ?? [sequence[0], `${sequence[0]}.js`],
  );
  for (
    let start = 0;
    start <= operationalArgv.length - sequence.length;
    start += 1
  ) {
    if (!isCommandToken(operationalArgv[start], sequence[0], commandBasenames))
      continue;
    if (
      sequence
        .slice(1)
        .every((token, offset) => operationalArgv[start + offset + 1] === token)
    )
      return true;
  }
  return false;
}

/**
 * Read only the non-secret identity signals that distinguish an agent or
 * green-checkpoint process from a peer that happens to mention the target in its
 * argv. Environment values themselves are deliberately not retained or
 * returned: PAPERCUSP_SID, the two gate marker names, and the cgroup path are
 * the evidence, not the rest of the process env.
 *
 * @param {string} procRoot
 * @param {number} pid
 * @param {{ readCgroup?: boolean }} [opts]
 * @returns {{ ownerId: string | null; greenCheckpointMarker: boolean; releaseGateMarker: boolean; cgroupPath: string | null; integrationRoot: string | null }}
 */
function readProcessIdentity(procRoot, pid, opts = {}) {
  let ownerId = null;
  let greenCheckpointMarker = false;
  let releaseGateMarker = false;
  let integrationRoot = null;
  try {
    const environment = String(
      readFileSync(path.join(procRoot, String(pid), "environ")),
    );
    for (const entry of environment.split("\0")) {
      const separator = entry.indexOf("=");
      if (separator === -1) continue;
      const key = entry.slice(0, separator);
      const value = entry.slice(separator + 1);
      if (key === "PAPERCUSP_SID" && value) ownerId = value;
      if (key === "GREEN_CHECKPOINT" && value === "1")
        greenCheckpointMarker = true;
      if (key === "PC_HEAVY_RELEASE_GATE" && value === "1")
        releaseGateMarker = true;
      // EI-21295926764996833: every pot runs the SAME green-checkpoint.ts out of
      // the papercusp tree, so script path, node binary and tsx loader flags are
      // byte-identical across pots and the printed row cannot say WHOSE gate it
      // is. This is the one field that can: the launcher sets it explicitly on
      // the detached spawn (release-checkpoint-launch.ts's `inner`) and the
      // periodic routine inherits it from the operator's unit env, so it is
      // present on both paths. It is also exactly what green-checkpoint's own
      // `cfg.integrationRoot` resolves from, so the attribution agrees with the
      // run's own idea of which tree it is judging. Free to collect: `environ`
      // is already being read for the fields above.
      if (key === "PAPERCUSP_INTEGRATION_ROOT" && value) integrationRoot = value;
    }
  } catch {
    // Processes can exit between cmdline and identity reads. argv remains useful.
  }

  let cgroupPath = null;
  if (opts.readCgroup) {
    try {
      cgroupPath = parseCgroupPath(
        readFileSync(path.join(procRoot, String(pid), "cgroup"), "utf8"),
      );
    } catch {
      // cgroup identity is supplementary; an unreadable file is not a match.
    }
  }
  return {
    ownerId,
    greenCheckpointMarker,
    releaseGateMarker,
    cgroupPath,
    integrationRoot,
  };
}

/**
 * Resolve WHICH TREE a matched process belongs to, so one pot's gate cannot be
 * read as another pot retrying (EI-21295926764996833).
 *
 * Two sources, strongest first, and the source is RETURNED rather than folded
 * away: `PAPERCUSP_INTEGRATION_ROOT` is the launcher's own explicit statement of
 * the root being judged, while `cwd` is an inference that merely happens to be
 * right for a run started from its own tree. A caller that filters on the tree
 * needs to know which one it got.
 *
 * `null` means UNKNOWN — the process exited, or /proc was unreadable. It is
 * deliberately NOT collapsed into "not my tree": an unreadable row is a failed
 * measurement, and treating it as a confident exclusion is the false-negative
 * this whole tool exists to prevent.
 *
 * Called only for rows that already matched, so the extra `cwd` readlink is
 * bounded by the match count and never paid per-process across all of /proc.
 *
 * @param {string} procRoot
 * @param {ProcRow} processRow
 * @returns {{ path: string; source: 'integration-root-env' | 'cwd' } | null}
 */
export function resolveOwningTree(procRoot, processRow) {
  const declared = processRow.identity?.integrationRoot;
  if (typeof declared === "string" && declared)
    return { path: declared, source: "integration-root-env" };
  try {
    const cwd = readlinkSync(
      path.join(procRoot, String(processRow.pid), "cwd"),
    );
    if (cwd) return { path: cwd, source: "cwd" };
  } catch {
    // Exited between match and readlink, or /proc/<pid>/cwd unreadable (it is
    // owner-restricted). UNKNOWN, not "no tree".
  }
  return null;
}

/**
 * Compare two tree paths for the `--integration-root` filter. Trailing slashes
 * and `..` segments are normalised away so a caller passing `$PWD/` or a
 * relative path still matches the launcher's absolute form. Symlinks are NOT
 * resolved here: `realpath` would touch the filesystem for every row, and the
 * paths being compared are both produced by the same launcher.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameTreePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Narrow a matched population to ONE tree (EI-21295926764996833).
 *
 * The load-bearing rule is what happens to a row that could NOT be attributed:
 * it is RETAINED, not dropped. Exclusion requires positive evidence that the
 * row belongs to a DIFFERENT tree. Dropping unattributable rows would let this
 * filter answer "nothing is running for your tree" while a live process it
 * merely failed to read keeps running — turning a liveness check into a false
 * negative, which is the entire failure class proc-guard exists to prevent.
 *
 * Both discarded populations are returned as counts rather than silently
 * folded away, matching this module's existing `argvTextOnly` posture: a caller
 * can always audit what was set aside.
 *
 * @param {string} procRoot
 * @param {ProcRow[]} matches - already-matched rows
 * @param {string} integrationRoot - the tree to keep
 * @returns {{ selected: ProcRow[]; excludedOtherTree: number; unattributedRetained: number; owningTree: Map<number, { path: string; source: 'integration-root-env' | 'cwd' } | null> }}
 */
export function filterByOwningTree(procRoot, matches, integrationRoot) {
  /** @type {Map<number, { path: string; source: 'integration-root-env' | 'cwd' } | null>} */
  const owningTree = new Map(
    matches.map((m) => [m.pid, resolveOwningTree(procRoot, m)]),
  );
  let unattributedRetained = 0;
  const selected = matches.filter((m) => {
    const tree = owningTree.get(m.pid);
    if (!tree) {
      unattributedRetained += 1;
      return true; // UNKNOWN is never an exclusion.
    }
    return sameTreePath(tree.path, integrationRoot);
  });
  return {
    selected,
    excludedOtherTree: matches.length - selected.length,
    unattributedRetained,
    owningTree,
  };
}

function isGreenCheckpointPattern(pattern) {
  return GREEN_CHECKPOINT_PATTERN.test(pattern);
}

function matchesGreenCheckpointIdentity(processRow) {
  const identity = processRow.identity;
  if (!identity) return false;
  // Environment markers are inherited by descendants, including long-lived
  // sidecars that outlive the gate. The cgroup is the authoritative lifetime
  // boundary; marker-only (or marker + non-checkpoint-cgroup) matches are not
  // evidence that a green-checkpoint run is alive.
  return (
    identity.cgroupPath !== null &&
    GREEN_CHECKPOINT_CGROUP.test(identity.cgroupPath)
  );
}

/**
 * Match the stable owner identity carried by psu-launched processes. This is
 * intentionally separate from argv matching: a launcher may omit the owner id
 * from argv while its descendants still expose PAPERCUSP_SID in /proc.
 *
 * @param {string} pattern
 * @param {ProcRow} processRow
 * @returns {boolean}
 */
function matchesOwnerIdentity(pattern, processRow) {
  const ownerId = processRow.identity?.ownerId;
  return typeof ownerId === "string" && new RegExp(pattern).test(ownerId);
}

/**
 * Parse the ppid out of a /proc/<pid>/stat line. The comm field (2nd field) is
 * parenthesized and may itself contain spaces/parens, so field-splitting must
 * resume from the LAST `)` rather than naively splitting on whitespace — the
 * kernel guarantees fields after that point never contain unescaped `)`.
 *
 * @param {string} statLine
 * @returns {number | null}
 */
export function parsePpid(statLine) {
  const closeParen = statLine.lastIndexOf(")");
  if (closeParen === -1) return null;
  const rest = statLine
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  // rest[0] = state, rest[1] = ppid
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) ? ppid : null;
}

/**
 * Enumerate every live process as { pid, ppid, argv, cmdline }, from a /proc root (real or a test fixture).
 *
 * @param {string} [procRoot] - Defaults to `/proc`; a fixture directory in tests.
 * @param {{ readIdentity?: boolean; readGateIdentity?: boolean }} [opts] - Read PAPERCUSP_SID and, when requested, known-workload identity markers.
 * @returns {ProcRow[]}
 */
export function listProcesses(procRoot = DEFAULT_PROC_ROOT, opts = {}) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  /** @type {ProcRow[]} */
  const out = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let argv;
    try {
      argv = parseArgv(readFileSync(path.join(procRoot, name, "cmdline")));
    } catch {
      continue; // process exited between readdir and read (or fixture has no cmdline) — skip
    }
    const cmdline = argv.join(" ");
    if (!cmdline) continue; // kernel threads / zombies have empty cmdline — never a real match
    let ppid = null;
    try {
      ppid = parsePpid(readFileSync(path.join(procRoot, name, "stat"), "utf8"));
    } catch {
      ppid = null;
    }
    const row = { pid, ppid, argv, cmdline };
    if (opts.readIdentity)
      row.identity = readProcessIdentity(procRoot, pid, {
        readCgroup: opts.readGateIdentity === true,
      });
    out.push(row);
  }
  return out;
}

/** Refuse a host-liveness answer when /proc belongs to the capability:bash sandbox. */
export function hostProcessVisibility(procRoot = DEFAULT_PROC_ROOT) {
  let pidOne;
  try {
    pidOne = parseCmdline(readFileSync(path.join(procRoot, "1", "cmdline")));
  } catch {
    return { visible: false, reason: "pid-1-unreadable" };
  }
  if (!pidOne) return { visible: false, reason: "pid-1-unreadable" };
  if (SANDBOX_PID_ONE_RE.test(pidOne)) {
    return { visible: false, reason: "sandbox-pid-namespace" };
  }
  return { visible: true, reason: null };
}

/**
 * pid + every ancestor up to (and including) pid 1, by walking `ppid` via
 * `byPid` (a Map<pid, ppid|null>). Cycle/depth-guarded so a corrupt or
 * adversarial ppid chain can't loop forever.
 *
 * @param {number} pid
 * @param {Map<number, number | null>} byPid
 * @param {number} [maxHops]
 * @returns {Set<number>}
 */
export function getAncestryChain(pid, byPid, maxHops = 512) {
  /** @type {Set<number>} */
  const chain = new Set();
  let cur = pid;
  let hops = 0;
  while (cur != null && !chain.has(cur) && hops < maxHops) {
    chain.add(cur);
    cur = byPid.has(cur) ? byPid.get(cur) : null;
    hops += 1;
  }
  return chain;
}

/**
 * Read a PID-rooted process tree without a host-wide /proc scan. Linux records
 * children per thread, so every bounded per-thread `children` file is consulted.
 * Races are fail-soft: a process that exits while being read is omitted.
 *
 * @param {number} rootPid
 * @param {{ procRoot?: string; maxNodes?: number; maxDepth?: number; budgetMs?: number; now?: () => number }} [opts]
 * @returns {{ rows: Array<ProcRow & { depth: number }>; truncated: boolean; reason: string | null }}
 */
export function walkProcessTree(rootPid, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const maxNodes = opts.maxNodes ?? 256;
  const maxDepth = opts.maxDepth ?? 32;
  const budgetMs = opts.budgetMs ?? 1_000;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const queue = [{ pid: rootPid, depth: 0 }];
  const seen = new Set();
  const rows = [];
  let truncated = false;
  let reason = null;

  while (queue.length > 0) {
    if (rows.length >= maxNodes) {
      truncated = true;
      reason = "max-nodes";
      break;
    }
    if (now() - startedAt >= budgetMs) {
      truncated = true;
      reason = "budget";
      break;
    }
    const current = queue.shift();
    if (!current || seen.has(current.pid)) continue;
    seen.add(current.pid);
    const pidDir = path.join(procRoot, String(current.pid));
    let argv;
    let ppid = null;
    try {
      argv = parseArgv(readFileSync(path.join(pidDir, "cmdline")));
      ppid = parsePpid(readFileSync(path.join(pidDir, "stat"), "utf8"));
    } catch {
      continue;
    }
    rows.push({
      pid: current.pid,
      ppid,
      argv,
      cmdline: argv.join(" "),
      depth: current.depth,
    });
    if (current.depth >= maxDepth) {
      truncated = true;
      reason ??= "max-depth";
      continue;
    }
    let tids = [];
    try {
      tids = readdirSync(path.join(pidDir, "task"))
        .filter((name) => /^\d+$/.test(name))
        .slice(0, maxNodes);
    } catch {
      continue;
    }
    for (const tid of tids) {
      let children = "";
      try {
        children = readFileSync(
          path.join(pidDir, "task", tid, "children"),
          "utf8",
        );
      } catch {
        continue;
      }
      for (const token of children.trim().split(/\s+/)) {
        if (/^\d+$/.test(token))
          queue.push({ pid: Number(token), depth: current.depth + 1 });
      }
    }
  }
  return { rows, truncated, reason };
}

/**
 * Processes matching `pattern` (a RegExp source) against operational argv or
 * PAPERCUSP_SID identity, EXCLUDING the caller's own pid and its whole ancestor
 * chain. Operational argv keeps the executable and real process arguments but
 * excludes agent prompt payloads and peers' structured (JSON) payloads. A
 * genuinely unrelated external process with the same pattern in a real argument
 * still matches.
 *
 * @param {string} pattern - A RegExp source, matched against operational argv.
 * @param {{ procRoot?: string; selfPid?: number; argvSequence?: string[]; interpreterBasenames?: string[]; commandBasenames?: string[]; capabilityBashTaskId?: string | null }} [opts]
 * Agent identity is read from PAPERCUSP_SID so a live agent whose owner id is
 * absent from argv is not reported absent. For the known `green-checkpoint`
 * workload, checkpoint-cgroup identity is also accepted so argv-blind
 * descendants are not missed. Gate environment markers alone are deliberately
 * insufficient because they can be inherited by long-lived sidecars.
 * @returns {ProcRow[]}
 */
export function matchExternalProcesses(pattern, opts = {}) {
  return matchExternalProcessesDetailed(pattern, opts).matches;
}

/**
 * Return both the liveness-safe matches and the raw-argv matches for audit.
 * `argvTextOnly` contains external processes where the pattern appears only in
 * a prompt payload or a structured (JSON) payload; those must never make a
 * liveness check positive. They stay visible in the counts so a caller can
 * audit what was ignored — nothing is silently dropped.
 *
 * @param {string} pattern - A RegExp source.
 * @param {{ procRoot?: string; selfPid?: number; argvSequence?: string[]; interpreterBasenames?: string[]; commandBasenames?: string[]; capabilityBashTaskId?: string | null }} [opts]
 * `identityMatches` includes PAPERCUSP_SID owner matches and checkpoint-cgroup
 * matches. Gate markers are diagnostic evidence only; they are not sufficient
 * without the checkpoint cgroup. The owner id itself is retained only in the
 * in-memory identity evidence and is never printed as environment data.
 *
 * @returns {{ matches: ProcRow[]; fullMatches: ProcRow[]; argvTextOnly: ProcRow[]; identityMatches: ProcRow[] }}
 */
export function matchExternalProcessesDetailed(pattern, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const selfPid = opts.selfPid ?? process.pid;
  const knownIdentity = isGreenCheckpointPattern(pattern);
  // PAPERCUSP_SID is the stable identity channel for psu-launched agents. A
  // launcher can omit the owner id from argv entirely, while every descendant
  // still carries it in /proc/<pid>/environ. Read only the bounded identity
  // fields, never the full environment, for every check so an absence in argv
  // cannot become a false liveness negative.
  const all = listProcesses(procRoot, {
    readIdentity: true,
    readGateIdentity: knownIdentity,
  });
  const byPid = new Map(all.map((p) => [p.pid, p.ppid]));
  const excluded = getAncestryChain(selfPid, byPid);
  const capabilityBashTaskId =
    opts.capabilityBashTaskId ??
    process.env[CAPABILITY_BASH_BACKGROUND_TASK_ID_ENV] ??
    null;
  const capabilityBashWrapperPids = new Set(
    all
      .filter((p) => isCapabilityBashSystemdRunWrapper(p.argv, capabilityBashTaskId))
      .map((p) => p.pid),
  );
  const re = new RegExp(pattern);
  const external = all.filter(
    (p) => !excluded.has(p.pid) && !capabilityBashWrapperPids.has(p.pid),
  );
  const fullMatches = external.filter((p) => re.test(p.cmdline));
  const operationalMatches = opts.argvSequence
    ? external.filter((p) =>
        matchesAdjacentArgvSequence(p.argv, opts.argvSequence, {
          interpreterBasenames: opts.interpreterBasenames,
          commandBasenames: opts.commandBasenames,
        }),
      )
    : external.filter((p) => re.test(getOperationalArgv(p.argv).join(" ")));
  const matchedOperationalPids = new Set(operationalMatches.map((p) => p.pid));
  const identityMatches = external.filter(
    (p) =>
      ((!opts.argvSequence && matchesOwnerIdentity(pattern, p)) ||
        (knownIdentity && matchesGreenCheckpointIdentity(p))),
  );
  const matchedIdentityPids = new Set(identityMatches.map((p) => p.pid));
  const matches = external.filter(
    (p) => matchedOperationalPids.has(p.pid) || matchedIdentityPids.has(p.pid),
  );
  const argvTextOnly = fullMatches.filter(
    (p) => !matchedOperationalPids.has(p.pid),
  );
  return { matches, fullMatches, argvTextOnly, identityMatches };
}

const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
const DEFAULT_SAMPLE_MS = 10_000;
// One normal 10s measurement plus a measured-latency cushion. The shared
// deadline is intentionally independent of the number of matching processes:
// `--busy` must not multiply a health-hold budget by serialising one sample per
// row (EI-20949036178670253).
const DEFAULT_BUSY_BUDGET_MS = DEFAULT_SAMPLE_MS + 5_000;
/** Below this, report the reading as near-zero and print its falsifier. */
const NEAR_ZERO_CORES = 0.05;

/**
 * Parse the cgroup-v2 path out of a `/proc/<pid>/cgroup` body (`0::<path>`).
 *
 * @param {Buffer | string} raw
 * @returns {string | null} null when there is no v2 line (cgroup v1-only host).
 */
export function parseCgroupPath(raw) {
  for (const line of String(raw).split("\n")) {
    const m = /^0::(.*)$/.exec(line.trim());
    if (m) return m[1] || "/";
  }
  return null;
}

/**
 * Parse `usage_usec <n>` out of a cgroup `cpu.stat` body. This counter is
 * MONOTONIC, which is what makes a two-sample delta a true rate even as
 * children spawn and exit between the samples.
 *
 * @param {Buffer | string} raw
 * @returns {number | null}
 */
export function parseUsageUsec(raw) {
  const m = /^usage_usec\s+(\d+)/m.exec(String(raw));
  return m ? Number(m[1]) : null;
}

/**
 * Cores busy = Δusage_usec / elapsed.
 *
 * ⚠ Divide by the MEASURED elapsed time, never by the requested sleep: a
 * loaded box oversleeps, and dividing by the request inflates the rate.
 *
 * @param {number} deltaUsec
 * @param {number} elapsedMs
 * @returns {number | null} null when elapsed is non-positive (rate undefined).
 */
export function computeCoresBusy(deltaUsec, elapsedMs) {
  if (!(elapsedMs > 0)) return null;
  return deltaUsec / 1000 / elapsedMs;
}

/**
 * Two-sample CPU rate over a pid's WHOLE cgroup — the answer to "is it
 * actually WORKING", as opposed to `check`'s "is it RUNNING".
 *
 * The cgroup is the instrument on purpose (EI-20425164406230624): it accounts
 * for EVERY descendant at ANY depth, so nothing can hide below a walk bound.
 * A hand-rolled /proc tree walk reports a confident FALSE IDLE two ways — a
 * depth-bounded walk halts on a 0-tick shell wrapper (this repo's test
 * entrypoint is ~8 levels deep), and one pid's utime+stime+cutime+cstime
 * credits `c*` only on wait(), which vitest never does for its own workers.
 *
 * Returns a discriminated result: an unreadable cgroup is `unknown`, NEVER 0
 * cores — "could not measure" and "measured, idle" must not render alike.
 *
 * @param {number} pid
 * @param {{ procRoot?: string; cgroupRoot?: string; sampleMs?: number;
 *           budgetMs?: number; deadlineAt?: number;
 *           sleep?: (ms: number) => Promise<void>; now?: () => number }} [opts]
 * @returns {Promise<CgroupBusySample>}
 */
export async function sampleCgroupBusy(pid, opts = {}) {
  const procRoot = opts.procRoot ?? DEFAULT_PROC_ROOT;
  const cgroupRoot = opts.cgroupRoot ?? DEFAULT_CGROUP_ROOT;
  const sampleMs = opts.sampleMs ?? DEFAULT_SAMPLE_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  if (!(sampleMs > 0) || !Number.isFinite(sampleMs)) {
    return { status: "unknown", reason: "invalid-sample-window" };
  }
  if (
    opts.budgetMs !== undefined &&
    (!(opts.budgetMs >= 0) || !Number.isFinite(opts.budgetMs))
  ) {
    return { status: "unknown", reason: "invalid-budget" };
  }
  if (opts.deadlineAt !== undefined && !Number.isFinite(opts.deadlineAt)) {
    return { status: "unknown", reason: "invalid-deadline" };
  }
  const budgetDeadline =
    opts.budgetMs === undefined ? null : startedAt + opts.budgetMs;
  const deadlineAt =
    opts.deadlineAt === undefined
      ? budgetDeadline
      : budgetDeadline === null
        ? opts.deadlineAt
        : Math.min(opts.deadlineAt, budgetDeadline);
  const budgetExceeded = (
    cgroupPath,
    elapsedMs = Math.max(0, now() - startedAt),
  ) => ({
    status: "unknown",
    reason: "budget-exhausted",
    cgroupPath,
    elapsedMs,
  });

  // Do not begin a partial measurement. A short remainder would only produce
  // an incomparable rate and, more importantly, spend the caller's remaining
  // hold budget without yielding a useful answer.
  if (deadlineAt !== null && now() >= deadlineAt) return budgetExceeded(null);

  let cgPath = null;
  try {
    cgPath = parseCgroupPath(
      readFileSync(path.join(procRoot, String(pid), "cgroup"), "utf8"),
    );
  } catch {
    return { status: "unknown", reason: "no-cgroup-entry" };
  }
  if (!cgPath) return { status: "unknown", reason: "not-cgroup-v2" };
  if (deadlineAt !== null && now() >= deadlineAt) return budgetExceeded(cgPath);

  const statPath = path.join(cgroupRoot, cgPath, "cpu.stat");
  const readUsage = () => {
    try {
      return parseUsageUsec(readFileSync(statPath, "utf8"));
    } catch {
      return null;
    }
  };

  const a = readUsage();
  if (a === null)
    return {
      status: "unknown",
      reason: "cpu-stat-unreadable",
      cgroupPath: cgPath,
    };
  if (deadlineAt !== null && deadlineAt - now() < sampleMs)
    return budgetExceeded(cgPath);
  const t0 = now();
  await sleep(sampleMs);
  const elapsedMs = now() - t0;
  if (deadlineAt !== null && now() >= deadlineAt)
    return budgetExceeded(cgPath, elapsedMs);
  const b = readUsage();
  if (b === null)
    return {
      status: "unknown",
      reason: "cpu-stat-unreadable",
      cgroupPath: cgPath,
    };
  if (deadlineAt !== null && now() >= deadlineAt)
    return budgetExceeded(cgPath, elapsedMs);
  const cores = computeCoresBusy(b - a, elapsedMs);
  if (cores === null)
    return { status: "unknown", reason: "zero-elapsed", cgroupPath: cgPath };

  let procs = null;
  try {
    procs = readFileSync(path.join(cgroupRoot, cgPath, "cgroup.procs"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
  } catch {
    /* the proc count is a nicety; the rate is the answer */
  }
  if (deadlineAt !== null && now() >= deadlineAt)
    return budgetExceeded(cgPath, elapsedMs);
  return { status: "ok", cores, procs, elapsedMs, cgroupPath: cgPath };
}

/**
 * Sample matched process cgroups concurrently under one wall-clock budget.
 *
 * A caller that wants a bounded health hold must budget the whole batch, not
 * multiply the per-process interval by the number of rows. All samples share
 * one absolute deadline, so a large match set cannot turn a 10-second sample
 * into an unbounded serial wait.
 *
 * @param {{ pid: number }[]} matches
 * @param {{ procRoot?: string; cgroupRoot?: string; sampleMs?: number;
 *           budgetMs?: number; deadlineAt?: number;
 *           sleep?: (ms: number) => Promise<void>; now?: () => number }} [opts]
 * @returns {Promise<CgroupBusySample[]>}
 */
export async function sampleBusyMatches(matches, opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();
  const deadlineAt =
    opts.deadlineAt !== undefined
      ? opts.deadlineAt
      : opts.budgetMs === undefined
        ? undefined
        : startedAt + opts.budgetMs;
  const sampleOpts = { ...opts, now, deadlineAt };
  delete sampleOpts.budgetMs;
  return Promise.all(
    matches.map((match) => sampleCgroupBusy(match.pid, sampleOpts)),
  );
}

/** Render one `--busy` line (+ its falsifier when near-zero). Pure, so the
 *  wording is pinned by tests rather than by eyeballing terminal output. */
export function formatBusy(sample) {
  if (sample.status !== "ok") {
    return [
      `busy: UNKNOWN (${sample.reason}) — this is NOT "idle"; the cgroup could not be read`,
    ];
  }
  const secs = (sample.elapsedMs / 1000).toFixed(1);
  const out = [
    `busy: ${sample.cores.toFixed(2)} core(s) over ${secs}s across ${sample.procs ?? "?"} proc(s) in ${sample.cgroupPath}`,
  ];
  if (sample.cores < NEAR_ZERO_CORES) {
    out.push(
      `⚠ near-zero — before calling this STALLED: if the pid is a SUPERVISOR its children may sit in a DIFFERENT cgroup, so check the proc count above (1 proc often means you measured the wrapper, not the work).`,
    );
  }
  return out;
}

async function main(argv) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [cmd, pattern] = positional;
  const argvSequenceFlag = flags.find((f) => f.startsWith("--argv-sequence="));
  const argvSequence = argvSequenceFlag
    ? argvSequenceFlag
        .slice("--argv-sequence=".length)
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
    : undefined;
  const busy = flags.includes("--busy");
  const verbose = flags.includes("--verbose");
  const integrationRootFlag = flags.find((f) =>
    f.startsWith("--integration-root="),
  );
  const integrationRootFilter = integrationRootFlag
    ? integrationRootFlag.slice("--integration-root=".length).trim()
    : undefined;
  const sampleMsFlag = flags.find((f) => f.startsWith("--sample-ms="));
  const sampleMs = sampleMsFlag
    ? Number(sampleMsFlag.slice("--sample-ms=".length))
    : DEFAULT_SAMPLE_MS;
  const budgetMsFlag = flags.find((f) => f.startsWith("--budget-ms="));
  const budgetMs = budgetMsFlag
    ? Number(budgetMsFlag.slice("--budget-ms=".length))
    : DEFAULT_BUSY_BUDGET_MS;
  const maxNodesFlag = flags.find((f) => f.startsWith("--max-nodes="));
  const maxNodes = maxNodesFlag
    ? Number(maxNodesFlag.slice("--max-nodes=".length))
    : 256;
  const maxDepthFlag = flags.find((f) => f.startsWith("--max-depth="));
  const maxDepth = maxDepthFlag
    ? Number(maxDepthFlag.slice("--max-depth=".length))
    : 32;
  if (cmd === "check" || cmd === "tree") {
    const visibility = hostProcessVisibility();
    if (!visibility.visible) {
      console.error(
        `proc-guard: cannot observe host processes (${visibility.reason}); ` +
          "use processes:list { live:true } for managed tasks or a host-visible process tool."
      );
      process.exit(2);
      return;
    }
  }
  if (cmd === "tree") {
    const rootPid = Number(pattern);
    if (
      !Number.isInteger(rootPid) ||
      rootPid <= 0 ||
      !Number.isInteger(maxNodes) ||
      maxNodes <= 0 ||
      !Number.isInteger(maxDepth) ||
      maxDepth < 0 ||
      !(budgetMs > 0)
    ) {
      console.error(
        "usage: node scripts/proc-guard.mjs tree <pid> [--max-nodes=<n>] [--max-depth=<n>] [--budget-ms=<n>]",
      );
      process.exit(2);
      return;
    }
    const tree = walkProcessTree(rootPid, { maxNodes, maxDepth, budgetMs });
    if (tree.rows.length === 0) {
      console.log(`proc-guard: pid ${rootPid} unavailable`);
      process.exit(1);
      return;
    }
    for (const row of tree.rows)
      console.log(
        `${"  ".repeat(row.depth)}${row.pid}  ${formatProcessCmdline(row.cmdline, { verbose })}`,
      );
    if (tree.truncated)
      console.log(`proc-guard: tree truncated (${tree.reason})`);
    process.exit(0);
    return;
  }
  if (
    cmd !== "check" ||
    !pattern ||
    (argvSequenceFlag && (!argvSequence || argvSequence.length < 2)) ||
    (integrationRootFlag && !integrationRootFilter) ||
    !(sampleMs > 0) ||
    !Number.isFinite(sampleMs) ||
    !(budgetMs > 0) ||
    !Number.isFinite(budgetMs)
  ) {
    console.error(
      "usage: node scripts/proc-guard.mjs check <pattern> [--argv-sequence=<first,second>] [--integration-root=<path>] [--busy] [--verbose] [--sample-ms=<n>] [--budget-ms=<n>]\n" +
        "  --argv-sequence=<csv>  require literal adjacent argv tokens; the first token is matched by basename\n" +
        "  --integration-root=<path>  keep only processes working on THIS tree. Every pot runs the\n" +
        "          same script out of the papercusp tree, so an unfiltered population mixes pots and\n" +
        "          reads as one pot retrying. A row is dropped ONLY when it is positively attributed\n" +
        "          to a different tree; an unattributable row is RETAINED and counted, so this can\n" +
        "          never turn a live process into a false 'nothing is running'.\n" +
        '  --busy  also answer "is it WORKING" — a two-sample cgroup CPU rate per match,\n' +
        "          which sees every descendant at any depth (a /proc tree walk does not).\n" +
        "  --verbose  print each matching process's full command line (default: first 200 chars)\n" +
        "  --budget-ms=<n>  shared wall-clock budget for all --busy samples (default 15s).",
    );
    process.exit(2);
    return;
  }
  const report = matchExternalProcessesDetailed(pattern, { argvSequence });
  const { fullMatches, argvTextOnly, identityMatches } = report;
  const allMatches = report.matches;
  if (allMatches.length === 0) {
    if (fullMatches.length > 0) {
      console.log(
        `proc-guard: no external process matches /${pattern}/ (${fullMatches.length} full-argv match(es), all ${argvTextOnly.length} argv-text-only; ignored)`,
      );
    } else {
      console.log(`proc-guard: no external process matches /${pattern}/`);
    }
    process.exit(1);
    return;
  }
  // EI-21295926764996833: attribute every match to its owning tree BEFORE
  // printing. Resolved per match (not per process across all of /proc), so the
  // extra cwd readlink is bounded by the match count.
  // Same code path the tests lock, so the retention property cannot hold in
  // `filterByOwningTree` while the CLI quietly does something else.
  const filtered = filterByOwningTree(
    DEFAULT_PROC_ROOT,
    allMatches,
    integrationRootFilter ?? "",
  );
  const owningTree = filtered.owningTree;
  const matches = integrationRootFilter ? filtered.selected : allMatches;
  const excludedOtherTree = integrationRootFilter
    ? filtered.excludedOtherTree
    : 0;
  const unattributedRetained = integrationRootFilter
    ? filtered.unattributedRetained
    : 0;
  if (matches.length === 0) {
    console.log(
      `proc-guard: no external process matches /${pattern}/ for tree ${path.resolve(String(integrationRootFilter))} ` +
        `(${excludedOtherTree} match(es) attributed to another tree; 0 unattributable)`,
    );
    process.exit(1);
    return;
  }
  const rawSuffix =
    fullMatches.length === allMatches.length && identityMatches.length === 0
      ? ""
      : ` (${fullMatches.length} full-argv match(es), ${identityMatches.length} identity match(es) via PAPERCUSP_SID or checkpoint cgroup; ${argvTextOnly.length} argv-text-only ignored)`;
  const treeSuffix = integrationRootFilter
    ? ` for tree ${path.resolve(integrationRootFilter)}` +
      ` (${excludedOtherTree} attributed to another tree` +
      (unattributedRetained > 0
        ? `; ${unattributedRetained} unattributable, RETAINED`
        : "") +
      ")"
    : "";
  console.log(
    `proc-guard: ${matches.length} external process(es) match /${pattern}/${treeSuffix}${rawSuffix}:`,
  );
  const samples = busy
    ? await sampleBusyMatches(matches, { sampleMs, budgetMs })
    : [];
  for (const [index, m] of matches.entries()) {
    console.log(`  ${m.pid}  ${formatProcessCmdline(m.cmdline, { verbose })}`);
    if (identityMatches.some((identityMatch) => identityMatch.pid === m.pid)) {
      console.log(
        matchesOwnerIdentity(pattern, m)
          ? "         identity: PAPERCUSP_SID owner identity"
          : "         identity: green-checkpoint checkpoint cgroup",
      );
    }
    // The column that ends the cross-pot ambiguity. The SOURCE is printed, not
    // folded away: a declared root is the launcher's own statement of the tree
    // it is judging, while cwd is an inference. UNKNOWN is printed as UNKNOWN.
    const tree = owningTree.get(m.pid);
    console.log(
      tree
        ? `         tree: ${tree.path}${
            tree.source === "integration-root-env"
              ? " (declared: PAPERCUSP_INTEGRATION_ROOT)"
              : " (inferred from cwd)"
          }`
        : "         tree: UNKNOWN — unattributable (exited, or /proc unreadable)",
    );
    if (!busy) continue;
    for (const line of formatBusy(samples[index]))
      console.log(`         ${line}`);
  }
  process.exit(0);
}

const isMain =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // main() is async now (--busy samples over time); without this catch a throw
  // becomes an unhandled rejection whose exit code is NOT the guard's contract.
  main(process.argv.slice(2)).catch((e) => {
    console.error(`proc-guard: ${e?.message ?? e}`);
    process.exit(2);
  });
}
