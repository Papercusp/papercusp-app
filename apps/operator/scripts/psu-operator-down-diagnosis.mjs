/**
 * Explain WHY the operator psu dials is down, from systemd's own state (WI-10006057).
 *
 * When the operator behind the MCP proxy is down, the proxy holds psu's request
 * for its whole retry window (~90s) and then answers with a bare
 * `mcp_proxy_upstream_unavailable — connect ECONNREFUSED 127.0.0.1:3170`. That
 * names a port, not a cause. After the 2026-10-05 reboot the cause was
 * papercusp-staging-api's start job queued behind default.target, which was
 * waiting on papercusp-bg-host's timed-out rebuild: one `systemctl` call away,
 * invisible from psu.
 *
 * Everything here is fail-soft. No systemd, no unit serving the port, a remote
 * host, or any error yields null, and psu keeps its original message.
 */
import { spawnSync } from "node:child_process";
import { MCP_PROXY_LOCAL_HEALTH_PATH } from "../lib/mcp-proxy/budgets.mjs";

const SYSTEMCTL_TIMEOUT_MS = 3_000;
// apps/operator/bin/hono-host.ts binds PAPERCUSP_HONO_PORT ?? PORT ?? 3070.
const DEFAULT_HONO_PORT = 3070;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MAX_BLOCKER_DEPTH = 3;
const MAX_LEAVES_SHOWN = 3;

/** `systemctl --user <args>` → stdout, or null on any failure. */
export function runSystemctlUser(args) {
  try {
    const r = spawnSync("systemctl", ["--user", ...args, "--no-pager"], {
      encoding: "utf8",
      timeout: SYSTEMCTL_TIMEOUT_MS,
    });
    return r.error || r.status !== 0 ? null : String(r.stdout || "");
  } catch {
    return null;
  }
}

/** Parse `systemctl show` output (one blank-line-separated block per unit). */
export function parseShowBlocks(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((block) => {
      const props = {};
      for (const line of block.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        // ExecStart= repeats once per command line; keep them all.
        props[key] = key in props ? `${props[key]}\n${value}` : value;
      }
      return props;
    })
    .filter((props) => props.Id);
}

/** The port a unit's operator Hono host binds, or null when the unit does not run one. */
export function honoPortOfUnit(props) {
  const execStart = props?.ExecStart ?? "";
  if (!/hono-host/.test(execStart)) return null;
  const config = `${props.Environment ?? ""}\n${execStart}`;
  const hono = config.match(/(?:^|[\s;"'])PAPERCUSP_HONO_PORT=(\d+)/m);
  if (hono) return Number(hono[1]);
  const plain = config.match(/(?:^|[\s;"'])PORT=(\d+)/m);
  if (plain) return Number(plain[1]);
  return DEFAULT_HONO_PORT;
}

/** The user unit that runs the operator on `port`, derived from the unit configs systemd has loaded. */
export function findOperatorUnitForPort(port, { run = runSystemctlUser } = {}) {
  const out = run(["show", "--type=service", "--all", "-p", "Id", "-p", "Environment", "-p", "ExecStart"]);
  if (!out) return null;
  const match = parseShowBlocks(out).find((props) => honoPortOfUnit(props) === Number(port));
  return match ? match.Id : null;
}

export function readUnitState(unit, { run = runSystemctlUser } = {}) {
  const out = run([
    "show", unit,
    "-p", "Id", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState",
    "-p", "Result", "-p", "NRestarts", "-p", "StateChangeTimestamp",
  ]);
  const [props] = parseShowBlocks(out);
  if (!props || props.LoadState === "not-found") return null;
  return {
    unit: props.Id,
    activeState: props.ActiveState || "unknown",
    subState: props.SubState || "",
    result: props.Result || "",
    restarts: Number(props.NRestarts) || 0,
    since: String(props.StateChangeTimestamp || "").replace(/^[A-Z][a-z]{2} /, ""),
  };
}

/**
 * The unit's pending job and the jobs it is waiting on. `list-jobs --before`
 * prints, under each job, one `blocking job <id> (<unit>/<type>)` line per job
 * that must finish first.
 */
export function readUnitJob(unit, { run = runSystemctlUser } = {}) {
  const out = run(["list-jobs", "--before", "--no-legend", unit]);
  if (!out) return null;
  let job = null;
  for (const line of out.split("\n")) {
    const head = line.match(/^(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/);
    if (head) {
      job = head[2] === unit ? { id: Number(head[1]), type: head[3], state: head[4], blockedBy: [] } : null;
      continue;
    }
    const dep = line.match(/blocking job (\d+) \(([^/()]+)\/([^)]+)\)/);
    if (dep && job) job.blockedBy.push(dep[2]);
  }
  return job;
}

function describeState(state) {
  const parts = [state.subState ? `${state.activeState}: ${state.subState}` : state.activeState];
  if (state.restarts > 0) parts.push(`${state.restarts} automatic restart${state.restarts === 1 ? "" : "s"}`);
  return parts.join("; ");
}

/**
 * Follow a waiting job's blockers until reaching jobs that are actually running.
 * Returns `{ path, leaf }` chains: `path` is the waiting units in between (for
 * example default.target), `leaf` the running unit's state.
 */
export function findBlockingLeaves(unit, deps = {}, depth = 0, path = [], seen = new Set()) {
  if (depth >= MAX_BLOCKER_DEPTH || seen.has(unit)) return [];
  seen.add(unit);
  const job = readUnitJob(unit, deps);
  if (!job) return [];
  const leaves = [];
  for (const blocker of job.blockedBy) {
    if (seen.has(blocker)) continue;
    const blockerJob = readUnitJob(blocker, deps);
    if (blockerJob?.state === "waiting") {
      leaves.push(...findBlockingLeaves(blocker, deps, depth + 1, [...path, blocker], seen));
    } else {
      const state = readUnitState(blocker, deps);
      if (state) leaves.push({ path, leaf: state });
    }
  }
  return leaves;
}

/**
 * Diagnose the operator unit for a local `port`. Returns
 * `{ unit, summary, hint }`, or null when it cannot say anything useful.
 */
export function diagnoseOperatorPort(port, deps = {}) {
  const run = deps.run ?? runSystemctlUser;
  const unit = findOperatorUnitForPort(port, { run });
  if (!unit) return null;
  const state = readUnitState(unit, { run });
  if (!state) return null;
  const subject = `${unit} (:${port})`;
  const journal = (u) => `journalctl --user -u ${u} -n 50 --no-pager`;

  const job = readUnitJob(unit, { run });
  if (job?.state === "waiting") {
    const leaves = findBlockingLeaves(unit, { run });
    if (leaves.length === 0) {
      return {
        unit,
        summary: `${subject} has not started: its start job is queued behind ${job.blockedBy.join(", ") || "other boot jobs"}.`,
        hint: "systemctl --user list-jobs --before",
      };
    }
    const shown = leaves.slice(0, MAX_LEAVES_SHOWN);
    const via = shown[0].path.length ? `${shown[0].path.join(", which is waiting on ")}, which is waiting on ` : "";
    const named = shown.map(({ leaf }) => `${leaf.unit} (${describeState(leaf)})`).join(", ");
    const more = leaves.length > shown.length ? ` and ${leaves.length - shown.length} more` : "";
    return {
      unit,
      summary: `${subject} has not started: its start job is waiting on ${via}${named}${more}.`,
      hint: journal(shown[0].leaf.unit),
    };
  }
  if (state.activeState === "activating" && state.restarts > 0) {
    return {
      unit,
      summary: `${subject} is restarting in a loop (${describeState(state)}; last result: ${state.result || "unknown"}).`,
      hint: journal(unit),
    };
  }
  if (state.activeState === "activating") {
    return { unit, summary: `${subject} is still starting (${describeState(state)}, since ${state.since}).`, hint: journal(unit) };
  }
  if (state.activeState === "failed") {
    return {
      unit,
      summary: `${subject} failed (${state.result || "unknown result"}) at ${state.since} and is not restarting.`,
      hint: journal(unit),
    };
  }
  if (state.activeState === "active") {
    return {
      unit,
      summary: `systemd reports ${subject} ${describeState(state)}, but it is not accepting connections. It may still be binding, or it may be wedged.`,
      hint: journal(unit),
    };
  }
  return {
    unit,
    summary: `${subject} is stopped (${describeState(state)} since ${state.since}) and nothing is starting it.`,
    hint: journal(unit),
  };
}

/** Indented lines to append under a `psu: …` message. */
export function renderDiagnosis(diagnosis) {
  if (!diagnosis) return "";
  return `\n  ${diagnosis.summary}\n  Details: ${diagnosis.hint}`;
}

function localPortOf(url) {
  try {
    const parsed = new URL(url);
    if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
    return Number(parsed.port) || null;
  } catch {
    return null;
  }
}

/**
 * The operator port behind a psu target. A resilient MCP proxy answers its local
 * health path with the upstream it forwards to; anything else is the operator
 * itself.
 */
export async function resolveOperatorEndpoint(baseUrl, { fetchImpl = fetch, timeoutMs = 1_500 } = {}) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  try {
    const res = await fetchImpl(`${origin}${MCP_PROXY_LOCAL_HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const body = await res.json();
      const port = Number(body?.target?.port);
      const host = String(body?.target?.host || "");
      if (port > 0 && LOCAL_HOSTS.has(host)) return { port, url: `http://${host}:${port}`, proxyUrl: origin };
      if (port > 0) return null; // the proxy forwards to a remote operator; nothing local to inspect
    }
  } catch {
    /* not a proxy, or the proxy itself is down; fall through to the target's own port */
  }
  const port = localPortOf(origin);
  return port ? { port, url: origin, proxyUrl: null } : null;
}

/**
 * The early notice psu prints while a request is still pending: null unless the
 * operator really is refusing its health check, so a slow-but-healthy request
 * stays silent.
 */
export async function slowOperatorNotice(baseUrl, { fetchImpl = fetch, run = runSystemctlUser, timeoutMs = 1_500 } = {}) {
  const endpoint = await resolveOperatorEndpoint(baseUrl, { fetchImpl, timeoutMs });
  if (!endpoint) return null;
  try {
    const res = await fetchImpl(`${endpoint.url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return null;
  } catch {
    /* refused or timed out: the operator is down */
  }
  const where = endpoint.proxyUrl
    ? `The operator on :${endpoint.port} (behind the MCP proxy at ${endpoint.proxyUrl}) is not answering, ` +
      "so the proxy is holding this request while it retries (up to ~90s)."
    : `The operator on :${endpoint.port} is not answering; psu keeps retrying.`;
  return `psu: still waiting. ${where}${renderDiagnosis(diagnoseOperatorPort(endpoint.port, { run }))}\n`;
}

/**
 * Append the diagnosis to a final failure about a local operator port. A proxy's
 * `mcp_proxy_upstream_unavailable` names the refused upstream in its detail
 * (`connect ECONNREFUSED 127.0.0.1:3170`); a direct failure names the target URL.
 */
export function withOperatorDownDiagnosis(message, { detail = "", url = "" } = {}, deps = {}) {
  const fromDetail = String(detail).match(/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/);
  const port = fromDetail ? Number(fromDetail[1]) : localPortOf(url);
  if (!port) return message;
  try {
    return message + renderDiagnosis(diagnoseOperatorPort(port, deps));
  } catch {
    return message;
  }
}
