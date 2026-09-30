/**
 * Agent-run metadata helpers — shared scan of `.papercusp/logs/` + PG mirror.
 *
 *   probeRunLiveness   — cheap "is this jsonl still being written?" check (tails last 4 KB
 *                        for a terminal marker + mtime guard). Backend-aware: claude
 *                        `{"type":"result"}`, codex `{"type":"turn.completed"}`, omp
 *                        `{"type":"agent_end"}`, and the `papercusp.run_meta` stamp
 *                        invoke.ts appends at subprocess exit (the authoritative marker).
 *   scanAgentRuns      — walks the logs dir, parses filename + reads windowed JSONL through
 *                        the shared `extractRunUsage` (all three backend stream shapes);
 *                        returns full agent_runs row shape incl. backend/model and
 *                        estimated-vs-provider cost labeling (cross-backend-cost-capture
 *                        D-005 — codex reports tokens only, so its cost is priced from
 *                        `@papercusp/model-pricing` and flagged `costIsEstimate`).
 *   scanAgentRunsCached — 2 s memoization keyed on dir mtime+size; the dashboard polls /agents every 5 s, so multiple concurrent panels share the file-walk cost.
 *   syncAgentRunsToPg  — fire-and-forget mirror of the scan results into `harness_<slug>.agent_runs` (INSERT … ON CONFLICT … + DELETE-not-in to keep the table in sync with the filesystem), workspace-scoped (migration 170).
 *
 * NOTE: in PG-canonical mode invoke.ts writes NO log files, so this FS-scan layer only
 * sees CLI-fallback / PAPERCUSP_KEEP_FILES runs — per-harness *spend* reads
 * `agent_usage_samples` (see harness-insights/load-spend.ts), not this mirror.
 *
 * Relocated from `app/api/_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 35 — prereq for `/agents`, `/usage`, `/streams` route migrations
 * which all share these helpers).
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { extractRunUsage } from "@papercusp/orchestrator";
import { costFromTokens } from "@papercusp/model-pricing";
import { harnessQuery } from "@papercusp/db-org";
import { activeWorkspaceId } from "./workspace-registry";
import { harnessDir } from "./harness-core";
import { type ProjectEntry } from "./harness-registry";
import { pinModuleState } from "@papercusp/module-singleton";

// A run is "live" when its jsonl has no terminal marker AND its mtime is
// recent. The mtime guard prevents orphaned runs (harness SIGKILLed
// mid-stream) from being reported as forever-running.
const LIVE_MTIME_GRACE_MS = 10 * 60_000;

// Terminal markers per backend stream format. `papercusp.run_meta` is appended by
// invoke.ts at subprocess exit and is the authoritative end-of-run stamp; the
// per-backend terminal events cover files written before the stamp existed.
// (codex `turn.completed` fires per turn — our `codex exec` spawns are single-turn,
// and the run_meta stamp disambiguates any future multi-turn shape.)
const TERMINAL_MARKERS = [
  '"type":"result"',
  '"type":"turn.completed"',
  '"type":"agent_end"',
  '"type":"papercusp.run_meta"',
];

export function probeRunLiveness(
  jsonlPath: string,
  now: number,
): { running: boolean; lastEventTs: number } {
  if (!existsSync(jsonlPath)) return { running: false, lastEventTs: 0 };
  const stat = statSync(jsonlPath);
  const lastEventTs = stat.mtimeMs;
  const size = stat.size;
  if (size === 0) {
    return { running: now - lastEventTs < LIVE_MTIME_GRACE_MS, lastEventTs };
  }
  const tailSize = Math.min(size, 4096);
  const fd = openSync(jsonlPath, "r");
  try {
    const buf = Buffer.allocUnsafe(tailSize);
    readSync(fd, buf, 0, tailSize, size - tailSize);
    const tail = buf.toString("utf8");
    const lines = tail
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (TERMINAL_MARKERS.some((m) => lines[i].includes(m))) {
        return { running: false, lastEventTs };
      }
    }
    return { running: now - lastEventTs < LIVE_MTIME_GRACE_MS, lastEventTs };
  } finally {
    closeSync(fd);
  }
}

export interface AgentRunFull {
  runId: string;
  role: string;
  featureId: string | null;
  ts: number;
  sizeBytes: number;
  durationMs: number;
  costUsd: number;
  /** True when costUsd was priced from tokens × list price (codex), not provider-reported. */
  costIsEstimate: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Backend/model attribution from the stream (run_meta stamp or stream-derived); null pre-stamp. */
  backend: string | null;
  model: string | null;
  running: boolean;
  lastEventTs: number;
}

// Windowed read for the usage parse: head window catches claude's `system:init`
// (model id), the tail window catches every terminal event + the run_meta stamp
// (and omp's `agent_end`, which carries the full per-turn usage list — so a
// missing mid-file `message_end` never undercounts a *finished* run). Whole-file
// read below the threshold.
const HEAD_WINDOW = 16384;
const TAIL_WINDOW = 65536;

function readUsageWindows(jsonlPath: string, size: number): string {
  if (size <= HEAD_WINDOW + TAIL_WINDOW) return readFileSync(jsonlPath, "utf8");
  const fd = openSync(jsonlPath, "r");
  try {
    const head = Buffer.allocUnsafe(HEAD_WINDOW);
    readSync(fd, head, 0, HEAD_WINDOW, 0);
    const tail = Buffer.allocUnsafe(TAIL_WINDOW);
    readSync(fd, tail, 0, TAIL_WINDOW, size - TAIL_WINDOW);
    // Drop the partial line at each cut edge so the line parser skips cleanly.
    const headStr = head.toString("utf8");
    const tailStr = tail.toString("utf8");
    const headCut = headStr.slice(0, headStr.lastIndexOf("\n") + 1);
    const tailCut = tailStr.slice(tailStr.indexOf("\n") + 1);
    return `${headCut}\n${tailCut}`;
  } finally {
    closeSync(fd);
  }
}

export function scanAgentRuns(project: ProjectEntry): AgentRunFull[] {
  const logDir = join(harnessDir(project), "logs");
  if (!existsSync(logDir)) return [];
  const now = Date.now();
  const out: AgentRunFull[] = [];
  for (const f of readdirSync(logDir)) {
    if (!f.endsWith(".jsonl")) continue;
    const base = f.replace(/\.jsonl$/, "");
    // Filename: <ts>-<role>[-<featureId>] e.g. 1777000000-worker-F-FIX-009
    const match = base.match(/^(\d+)-([a-z]+)(?:-(F-[A-Z0-9-]+))?$/);
    const jsonlPath = join(logDir, f);
    let jsonlMtime = 0;
    try {
      jsonlMtime = Math.floor(statSync(jsonlPath).mtimeMs);
    } catch {}
    const outPath = join(logDir, `${base}.out`);
    let outSize = 0;
    try {
      if (existsSync(outPath)) outSize = statSync(outPath).size;
    } catch {}
    const { running, lastEventTs } = probeRunLiveness(jsonlPath, now);
    let costUsd = 0,
      costIsEstimate = false,
      inputTokens = 0,
      outputTokens = 0,
      cacheReadTokens = 0,
      cacheCreationTokens = 0,
      durationMs = 0;
    let backend: string | null = null,
      model: string | null = null;
    // Backend-aware usage parse (claude result / codex turn.completed / omp
    // message_end+agent_end / run_meta stamp) over a bounded windowed read.
    try {
      const stat = statSync(jsonlPath);
      if (stat.size > 0) {
        const usage = extractRunUsage(readUsageWindows(jsonlPath, stat.size));
        if (usage) {
          inputTokens = usage.inputTokens ?? 0;
          outputTokens = usage.outputTokens ?? 0;
          cacheReadTokens = usage.cacheReadTokens ?? 0;
          cacheCreationTokens = usage.cacheCreationTokens ?? 0;
          durationMs = usage.durationMs ?? 0;
          backend = usage.backend ?? null;
          model = usage.model ?? null;
          if (usage.costUsd !== undefined) {
            costUsd = usage.costUsd; // provider-reported (claude / omp)
          } else if (usage.model) {
            const est = costFromTokens(usage.model, usage);
            if (est.priced) {
              costUsd = est.usd; // tokens × list price (codex) — labeled below
              costIsEstimate = true;
            }
          }
        }
      }
    } catch {}
    out.push({
      runId: base,
      role: match ? match[2] : "unknown",
      featureId: (match && match[3]) || null,
      ts: match ? Number(match[1]) * 1000 : jsonlMtime,
      sizeBytes: outSize,
      durationMs,
      costUsd,
      costIsEstimate,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      backend,
      model,
      running,
      lastEventTs: Math.floor(lastEventTs || jsonlMtime),
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

// 2 s memoization keyed on logDir + dir-mtime + dir-size. The dashboard
// polls /agents every 5 s and frequently fans out across panels
// concurrently; raw scanAgentRuns walks 200+ jsonl files per call (4 KB
// tail-read each). With this cache, the first concurrent caller pays the
// file-walk cost; the rest reuse the result. Invalidation: dir
// mtime/size signature; appending to an existing jsonl does NOT bump
// mtime (we tolerate a 2 s lag on liveness/cost in exchange for
// throughput).
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair. Hand-rolling shares the map correctly,
// but the key is invisible to listModuleDuplications(), which then answers a
// confident `[]` while this module is split (EI-19479108855357092). The key
// string is unchanged, so a record loaded through a different seam still lands
// on the same cache.
type AgentScanCacheEntry = { sig: string; expires: number; value: AgentRunFull[] };
const __agentScanState = pinModuleState<{ cache: Map<string, AgentScanCacheEntry> }>(
  "papercusp.harnessAgentScanCache",
  () => ({ cache: new Map() }),
);
const __agentScanCache = __agentScanState.cache;

export function scanAgentRunsCached(
  project: ProjectEntry,
  ttlMs = 2000,
): AgentRunFull[] {
  const logDir = join(harnessDir(project), "logs");
  let sig = "no-dir";
  try {
    if (existsSync(logDir)) {
      const st = statSync(logDir);
      sig = `${st.mtimeMs}:${st.size}`;
    }
  } catch {}
  const now = Date.now();
  const cached = __agentScanCache.get(logDir);
  if (cached && cached.sig === sig && cached.expires > now) return cached.value;
  const value = scanAgentRuns(project);
  __agentScanCache.set(logDir, { sig, expires: now + ttlMs, value });
  return value;
}

/**
 * Mirror agent-run metadata into `harness_<slug>.agent_runs`. Cheap
 * because row count is bounded by .jsonl file count (~200). Fire-and-forget.
 * Workspace-scoped (migration 170): rows carry workspace_id and the
 * DELETE-not-in never reaps another workspace's rows under a shared slug.
 */
export async function syncAgentRunsToPg(
  project: ProjectEntry,
  runs: AgentRunFull[],
): Promise<void> {
  const ws = activeWorkspaceId();
  const now = Date.now();
  const ids = runs.map((r) => r.runId);
  // C1-2: one harnessQuery() so the upsert + reconcile DELETE share one
  // transaction (and per-tx search_path) under PgBouncer. Param `sql` keeps refs.
  await harnessQuery(project.slug, async (sql) => {
    if (runs.length > 0) {
      const rows = runs.map((r) => ({
        workspace_id: ws,
        harness_slug: project.slug,
        run_id: r.runId,
        role: r.role,
        feature_id: r.featureId ?? null,
        ts: r.ts,
        size_bytes: r.sizeBytes,
        duration_ms: r.durationMs,
        cost_usd: r.costUsd,
        cost_is_estimate: r.costIsEstimate,
        input_tokens: r.inputTokens,
        output_tokens: r.outputTokens,
        cache_read_tokens: r.cacheReadTokens,
        cache_creation_tokens: r.cacheCreationTokens,
        backend: r.backend ?? null,
        model: r.model ?? null,
        running: r.running,
        last_event_ts: r.lastEventTs,
        created_ts: now,
        updated_ts: now,
      }));
      await sql`
      INSERT INTO agent_runs ${sql(rows, "workspace_id", "harness_slug", "run_id", "role", "feature_id", "ts", "size_bytes", "duration_ms", "cost_usd", "cost_is_estimate", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "backend", "model", "running", "last_event_ts", "created_ts", "updated_ts")}
      ON CONFLICT (harness_slug, run_id) DO UPDATE SET
        workspace_id            = EXCLUDED.workspace_id,
        role                    = EXCLUDED.role,
        feature_id              = EXCLUDED.feature_id,
        ts                      = EXCLUDED.ts,
        size_bytes              = EXCLUDED.size_bytes,
        duration_ms             = EXCLUDED.duration_ms,
        cost_usd                = EXCLUDED.cost_usd,
        cost_is_estimate        = EXCLUDED.cost_is_estimate,
        input_tokens            = EXCLUDED.input_tokens,
        output_tokens           = EXCLUDED.output_tokens,
        cache_read_tokens       = EXCLUDED.cache_read_tokens,
        cache_creation_tokens   = EXCLUDED.cache_creation_tokens,
        backend                 = EXCLUDED.backend,
        model                   = EXCLUDED.model,
        running                 = EXCLUDED.running,
        last_event_ts           = EXCLUDED.last_event_ts,
        updated_ts              = EXCLUDED.updated_ts
    `;
      await sql`
      DELETE FROM agent_runs
      WHERE harness_slug = ${project.slug}
        AND workspace_id = ${ws}
        AND run_id NOT IN ${sql(ids)}
    `;
    } else {
      await sql`DELETE FROM agent_runs WHERE harness_slug = ${project.slug} AND workspace_id = ${ws}`;
    }
  });
}
