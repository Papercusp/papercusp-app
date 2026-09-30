/**
 * residual-carry-pass-live — the LIVE legs of P-019 (deterministic-context-carry-
 * 2026-07-14, Phase 6/7), deferred by D-010 to ride the Phase-7 cold-boot drills
 * (P-020): the reserved-maintenance-lane LLM call that fills the `ResidualLlmFn`
 * seam in {@link runResidualCarryPass}, and a small durable sample ledger so
 * per-class miss-rate evidence accumulates across real compaction boundaries
 * instead of living only in one process's memory.
 *
 * Mirrors cold-boot-drill-live.ts's split: the PURE scorer/prompt/parser cores
 * stay in residual-carry-pass.ts; this module is the impure edge — a real fetch
 * to the gateway, and a bounded JSONL ledger under the same PSU_PTY_DIR the P-020
 * drill ledger already uses (one durable-state directory, not a second one).
 *
 * Lands DEFAULT-OFF in the sense D-010 describes: nothing here runs on a timer.
 * A caller must explicitly build the llmFn and invoke the pass (or feed a
 * pre-computed sample to the ledger) — this module performs no ambient sampling.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GATEWAY_PORT } from './inference-gateway/launch';
import { PSU_PTY_DIR } from './events/await/psu-pty-discovery';
import {
  RESIDUAL_MAX_TOKENS,
  DEFAULT_MISS_RATE_PARAMS,
  scoreResidualMissRate,
  type MissRateSample,
  type MissRateReport,
  type ResidualFinding,
  type ResidualLlmFn,
} from './residual-carry-pass';

const RESIDUAL_LEDGER_FILE = 'residual-carry-samples.events.jsonl';
const RESIDUAL_LEDGER_MAX_BYTES = 1024 * 1024;
const RESIDUAL_RETIRED_CLASSES_FILE = 'residual-carry-retired-classes.json';

/** Whole-call deadline for the reserved-lane request (loopback admission + upstream generation). */
export const RESIDUAL_LLM_TIMEOUT_MS = 30_000;

export interface MaintenanceResidualLlmOpts {
  /** Gateway base URL (default: loopback on the shared DEFAULT_GATEWAY_PORT). */
  baseUrl?: string;
  /** Test/alt seam — defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Whole-call timeout; defaults to {@link RESIDUAL_LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Build the `ResidualLlmFn` the pure core calls: POSTs `{ prompt, maxTokens }` to
 * the gateway's already-live `/maintenance/summarize` reserved lane (P-002) — the
 * SAME endpoint P-017's deterministic-carry branch answers from when a
 * `carryOwner` query param is present. We deliberately never send `carryOwner`
 * here, so the request always falls through to the endpoint's real LLM branch
 * (a cheap hosted model, tier-1 admission, never the caller's own backend) and
 * returns `{ summary }` — the raw model text `runResidualCarryPass` parses as
 * strict JSON findings. Fail-soft is the CALLER's job (`runResidualCarryPass`
 * already treats an llmFn throw as `parseError`, never a throw of its own) — this
 * function is allowed to throw on a non-2xx or network failure.
 */
export function buildMaintenanceResidualLlmFn(opts: MaintenanceResidualLlmOpts = {}): ResidualLlmFn {
  const baseUrl = (opts.baseUrl ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? RESIDUAL_LLM_TIMEOUT_MS;
  return async (prompt: string, callOpts: { maxTokens: number; sessionClass: string }): Promise<string> => {
    const maxTokens = Math.min(Math.max(1, callOpts.maxTokens), RESIDUAL_MAX_TOKENS);
    const r = await fetchImpl(`${baseUrl}/maintenance/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`residual-carry-pass-live: maintenance/summarize failed (${r.status}): ${text.slice(0, 300)}`);
    }
    const j = (await r.json()) as { summary?: unknown; ok?: boolean };
    if (typeof j.summary !== 'string' || !j.summary) {
      throw new Error('residual-carry-pass-live: maintenance/summarize returned no summary text');
    }
    return j.summary;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable sample ledger — one bounded JSONL file, mirrors cold-boot-drill-live's
// pattern so P-019/P-020 evidence lives in the same directory convention.
// ─────────────────────────────────────────────────────────────────────────────

export interface ResidualSampleLedgerEvent extends MissRateSample {
  ts: string;
  ownerId: string;
  /** Free-form provenance for where this boundary's stage-1/dropped-context came
   *  from (e.g. a drillId, a real self-compaction ownerId+ts, or a labeled smoke
   *  run) — never fed silently into the miss-rate corpus without one. */
  source: string;
  /** Findings, when the caller wants them preserved for a human audit later. */
  findingsCount?: number;
  /** Bounded copies of the findings themselves (text/provenance/anchor/material),
   *  so a material row is TRIAGEABLE later — "real builder gap → fix that carry
   *  slot" vs "spurious flag" — instead of an unactionable count. A strict-zero
   *  retirement gate (D-010) plus a deliberately over-flagging instrument can
   *  only converge if each flag can be turned into a builder fix. Absent on rows
   *  written before this field existed, and on clean rows. */
  findings?: ResidualLedgerFinding[];
}

/** Max findings persisted per ledger row + per-string char bound — triage needs
 *  the gist and the anchor, never the whole dropped context back. */
export const RESIDUAL_LEDGER_MAX_FINDINGS = 5;
export const RESIDUAL_LEDGER_FINDING_MAX_CHARS = 240;

export type ResidualLedgerFinding = Pick<ResidualFinding, 'provenance' | 'material'> & {
  text: string;
  anchor: string | null;
};

export function boundLedgerFindings(findings: ResidualFinding[]): ResidualLedgerFinding[] {
  return findings.slice(0, RESIDUAL_LEDGER_MAX_FINDINGS).map((f) => ({
    text: f.text.slice(0, RESIDUAL_LEDGER_FINDING_MAX_CHARS),
    provenance: f.provenance,
    anchor: f.anchor === null ? null : f.anchor.slice(0, RESIDUAL_LEDGER_FINDING_MAX_CHARS),
    material: f.material,
  }));
}

export function residualCarryLedgerPath(dir: string = PSU_PTY_DIR): string {
  return join(dir, RESIDUAL_LEDGER_FILE);
}

function parseJsonl<T>(body: string): T[] {
  const out: T[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row as T);
    } catch {
      // A concurrent writer mid-append can leave a partial final line; the next
      // read sees it once the append completes. Not a corruption.
    }
  }
  return out;
}

export async function readResidualCarryLedger(dir: string = PSU_PTY_DIR): Promise<ResidualSampleLedgerEvent[]> {
  try {
    return parseJsonl<ResidualSampleLedgerEvent>(await fs.readFile(residualCarryLedgerPath(dir), 'utf8'));
  } catch {
    return [];
  }
}

/** Bounded append — halves the file past ~1MB, same rule as the P-020 drill ledger. */
export async function appendResidualCarryLedgerEvent(
  event: ResidualSampleLedgerEvent,
  dir: string = PSU_PTY_DIR,
): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const path = residualCarryLedgerPath(dir);
    try {
      const stat = await fs.stat(path);
      if (stat.size > RESIDUAL_LEDGER_MAX_BYTES) {
        const body = await fs.readFile(path, 'utf8');
        await fs.writeFile(path, body.slice(Math.floor(body.length / 2)).replace(/^[^\n]*\n/, ''), { mode: 0o600 });
      }
    } catch {
      // First append creates the file.
    }
    await fs.appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await fs.chmod(path, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Score every persisted sample by session class — the same aggregator P-022 will
 *  read from once a class clears the retirement gate. */
export async function reportResidualCarrySamples(
  readLedger: () => Promise<ResidualSampleLedgerEvent[]> = readResidualCarryLedger,
  params = DEFAULT_MISS_RATE_PARAMS,
): Promise<MissRateReport> {
  return scoreResidualMissRate(await readLedger(), params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Retirement actuation (D-010's third live leg) — D-002/D-010: "the LLM residual
// pass is transitional and retires per session class on ~0 miss-rate evidence".
// Legs 1 (llmFn) and 2 (the real-boundary sampling harness, below) accumulate the
// corpus scoreResidualMissRate reads; THIS is the leg that actually STOPS paying
// for the pass on a class once that evidence clears the gate. Per D-001 ("changes
// are deliberate decisions, never runtime feedback"), scoreResidualMissRate's
// `retire` verdict is only ever a RECOMMENDATION — retiring a class is a discrete,
// explicit, evidence-gated action (session:carry-drill op:'retire' calls
// retireResidualClass only after independently confirming the class's live report
// says retire:true), never applied automatically off the raw score. A tiny bounded
// JSON map (not a JSONL ledger — retirements are rare, keyed, mutable state, not an
// append-only event stream) alongside the sample ledger in the SAME PSU_PTY_DIR
// convention this feature already established (one durable-state directory).
// ─────────────────────────────────────────────────────────────────────────────

/** One class's retirement record — the evidence pinned at the moment of the decision. */
export interface RetiredResidualClass {
  sessionClass: string;
  retiredAt: string;
  /** ownerId of the agent/operator that called the retirement (never automated). */
  retiredBy: string;
  /** The gate evidence snapshot that justified retiring (n, missRate, errorCount) —
   *  pinned so a later audit can see WHY without re-deriving it from a ledger that
   *  keeps growing. */
  evidence: { n: number; missRate: number; errorCount: number };
  note?: string;
}

export function residualRetiredClassesPath(dir: string = PSU_PTY_DIR): string {
  return join(dir, RESIDUAL_RETIRED_CLASSES_FILE);
}

/** Read the retired-class map. Fail-soft to {} — a missing/corrupt file means
 *  "nothing retired yet", never a throw that would silently re-enable sampling
 *  fleet-wide by crashing the caller. */
export async function readRetiredResidualClasses(
  dir: string = PSU_PTY_DIR,
): Promise<Record<string, RetiredResidualClass>> {
  try {
    const raw = await fs.readFile(residualRetiredClassesPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, RetiredResidualClass>;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeRetiredResidualClasses(
  map: Record<string, RetiredResidualClass>,
  dir: string = PSU_PTY_DIR,
): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(residualRetiredClassesPath(dir), `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export type RetireResidualClassResult =
  | { ok: true; record: RetiredResidualClass }
  | { ok: false; error: string };

/**
 * Retire the residual pass for ONE session class. The CALLER (session:carry-drill
 * op:'retire') is responsible for confirming the class's live miss-rate report says
 * retire:true before calling this — this function itself does not re-derive the
 * gate so it stays a pure write once the decision is made, but it DOES require a
 * non-trivial evidence snapshot so a retirement can never be recorded with no basis.
 */
export async function retireResidualClass(
  sessionClass: string,
  meta: { retiredBy: string; evidence: { n: number; missRate: number; errorCount: number }; note?: string },
  dir: string = PSU_PTY_DIR,
): Promise<RetireResidualClassResult> {
  const cls = sessionClass.trim();
  if (!cls) return { ok: false, error: 'sessionClass required' };
  if (!meta.retiredBy?.trim()) return { ok: false, error: 'retiredBy required' };
  if (!meta.evidence || meta.evidence.n <= 0) return { ok: false, error: 'evidence with n>0 required — retirement must be evidence-backed' };

  const map = await readRetiredResidualClasses(dir);
  const record: RetiredResidualClass = {
    sessionClass: cls,
    retiredAt: new Date().toISOString(),
    retiredBy: meta.retiredBy,
    evidence: meta.evidence,
    ...(meta.note ? { note: meta.note } : {}),
  };
  map[cls] = record;
  if (!(await writeRetiredResidualClasses(map, dir))) return { ok: false, error: 'write-failed' };
  return { ok: true, record };
}

/** Un-retire a class (reversibility — a bad call or a regression can always resume
 *  sampling). Returns whether the class was actually retired before this call. */
export async function unretireResidualClass(sessionClass: string, dir: string = PSU_PTY_DIR): Promise<boolean> {
  const cls = sessionClass.trim();
  const map = await readRetiredResidualClasses(dir);
  if (!(cls in map)) return false;
  delete map[cls];
  await writeRetiredResidualClasses(map, dir);
  return true;
}

export async function isResidualClassRetired(sessionClass: string, dir: string = PSU_PTY_DIR): Promise<boolean> {
  const map = await readRetiredResidualClasses(dir);
  return sessionClass in map;
}

// ── P-019 live leg 2: the per-class sampling harness over REAL boundaries ─────
// D-010 landed the llmFn seam (leg 1) but left "the per-class sampling harness
// over real compaction boundaries" unwired — so the retirement corpus never
// accumulated (one labeled smoke row was the whole ledger) and P-022's per-class
// strict-zero gate could never be reached. This is that harness: the gateway's
// deterministic maintenance-carry branch calls it fire-and-forget at each REAL
// compaction boundary it serves, where BOTH pass inputs are in hand (the served
// stage-1 carry doc + the raw prompt material the compaction is dropping).

/** Min spacing between samples for one owner — a compaction-storm cost guard. */
export const RESIDUAL_SAMPLE_MIN_INTERVAL_MS = 10 * 60_000;
/** Tail bound on the dropped-context material fed to the pass (the newest,
 *  least-well-carried material; the pass prompt must stay well inside the
 *  maintenance model's window). */
export const RESIDUAL_SAMPLE_DROPPED_CONTEXT_MAX_CHARS = 120_000;
/** The `source` stamp real gateway-boundary samples carry in the ledger. */
export const RESIDUAL_SAMPLE_SOURCE = 'gateway-maintenance-carry live boundary';

export interface MaintenanceResidualSampleInput {
  /** The compacting session's coord ownerId (the gateway's ?carryOwner). */
  carryOwner: string;
  /** The deterministic carry doc the gateway just served (stage-1 output). */
  stage1Doc: string;
  /** The raw material the caller sent to be summarized — what stage-1 drops. */
  droppedContext: string;
  /** Truthful interactivity bit, threaded from the psu-launcher
   *  (?carryInteractive=1) — the D-010 interactive-only gate. The pass SKIPS
   *  (not-a-sample) when false; we never guess it here. */
  interactive: boolean;
  workspaceId?: string;
}

export interface MaintenanceResidualSampleDeps {
  readLedger: () => Promise<ResidualSampleLedgerEvent[]>;
  appendLedger: (event: ResidualSampleLedgerEvent) => Promise<boolean>;
  llmFn: ResidualLlmFn;
  /** ownerId → agent kind ('omp' | 'claude' | ...) for the class label; null on miss. */
  resolveAgent: (ownerId: string) => Promise<string | null>;
  /** EI-13234: ownerId → CANONICAL session class (sessionClassForHost over the live host
   *  meta — the vocabulary the drill ledger + cold-by-default sufficientClasses key on).
   *  null on miss/error ⇒ the row falls back to the legacy `gateway-<agent>` label, so a
   *  corpus row is never lost to a classifier fault. */
  resolveCanonicalClass: (ownerId: string) => Promise<string | null>;
  /** Retirement actuation (D-010 leg 3): true ⇒ the class has been explicitly
   *  retired (session:carry-drill op:'retire') and sampling is skipped — no LLM
   *  call, no ledger row. Fail-soft to `false` on a read fault (never silently
   *  stop sampling a class that was never actually retired). */
  isRetired: (sessionClass: string) => Promise<boolean>;
  now: () => number;
}

function sampleDeps(overrides: Partial<MaintenanceResidualSampleDeps>): MaintenanceResidualSampleDeps {
  return {
    readLedger: readResidualCarryLedger,
    appendLedger: appendResidualCarryLedgerEvent,
    llmFn: buildMaintenanceResidualLlmFn(),
    resolveAgent: async (ownerId) => {
      try {
        const { resolveSessionRef } = await import('./compaction-usage');
        return (await resolveSessionRef(ownerId))?.agent ?? null;
      } catch {
        return null;
      }
    },
    resolveCanonicalClass: async (ownerId) => {
      try {
        const { findLiveHost, sessionClassForHost } = await import('./events/await/psu-pty-discovery');
        const host = findLiveHost(ownerId);
        return host ? sessionClassForHost(host) : null;
      } catch {
        return null;
      }
    },
    isRetired: async (sessionClass) => {
      try {
        return await isResidualClassRetired(sessionClass);
      } catch {
        return false;
      }
    },
    now: Date.now,
    ...overrides,
  };
}

export type MaintenanceResidualSampleResult = {
  sampled: boolean;
  reason: 'ok' | 'rate-limited' | 'non-interactive' | 'append-failed' | 'owner-missing' | 'retired';
  sessionClass?: string;
  material?: boolean;
  parseError?: boolean;
};

/**
 * Run one residual-pass sample at a real gateway maintenance-carry boundary and
 * persist it to the per-class retirement corpus. Fail-soft by construction: the
 * caller fires and forgets; the served compaction response is NEVER affected
 * (the pass core treats an llmFn throw as parseError, and everything else here
 * returns a reason instead of throwing).
 */
export async function runMaintenanceResidualSample(
  input: MaintenanceResidualSampleInput,
  overrides: Partial<MaintenanceResidualSampleDeps> = {},
): Promise<MaintenanceResidualSampleResult> {
  const deps = sampleDeps(overrides);
  const ownerId = input.carryOwner.trim();
  if (!ownerId) return { sampled: false, reason: 'owner-missing' };

  // D-010 interactive-only gate — the pass core records the skip semantics; we
  // simply do not append (a skipped boundary is not a sample, and skip rows
  // from a drone fleet would roll real samples out of the bounded ledger).
  // EI-13234: prefer the CANONICAL class (sessionClassForHost vocabulary — what the
  // drill ledger + cold-by-default consumers join on); the legacy gateway-<agent>
  // label survives only as the no-host fallback so no boundary is ever unsampled.
  const agent = await deps.resolveAgent(ownerId);
  const canonical = await deps.resolveCanonicalClass(ownerId);
  const sessionClass = canonical ?? `gateway-${agent ?? 'unknown'}`;

  // Retirement actuation (D-010 leg 3): checked FIRST — a retired class must never
  // pay for an LLM call again, regardless of interactivity or rate-limit state.
  if (await deps.isRetired(sessionClass)) return { sampled: false, reason: 'retired', sessionClass };
  if (!input.interactive) return { sampled: false, reason: 'non-interactive', sessionClass };

  // Per-owner cost guard: one sample per RESIDUAL_SAMPLE_MIN_INTERVAL_MS.
  const nowMs = deps.now();
  const ledger = await deps.readLedger();
  const recent = ledger.some((row) => {
    if (row.ownerId !== ownerId) return false;
    const t = Date.parse(row.ts);
    return Number.isFinite(t) && nowMs - t < RESIDUAL_SAMPLE_MIN_INTERVAL_MS;
  });
  if (recent) return { sampled: false, reason: 'rate-limited', sessionClass };

  const { runResidualCarryPass } = await import('./residual-carry-pass');
  const result = await runResidualCarryPass({
    sessionClass,
    interactive: true,
    stage1Doc: input.stage1Doc,
    droppedContext: input.droppedContext.slice(-RESIDUAL_SAMPLE_DROPPED_CONTEXT_MAX_CHARS),
    llmFn: deps.llmFn,
  });
  const appended = await deps.appendLedger({
    ts: new Date(nowMs).toISOString(),
    ownerId,
    sessionClass,
    material: result.material,
    ran: true,
    parseError: result.parseError,
    source: RESIDUAL_SAMPLE_SOURCE,
    findingsCount: result.findings.length,
    ...(result.findings.length > 0 ? { findings: boundLedgerFindings(result.findings) } : {}),
  });
  if (!appended) return { sampled: false, reason: 'append-failed', sessionClass };
  return {
    sampled: true,
    reason: 'ok',
    sessionClass,
    material: result.material,
    parseError: result.parseError,
  };
}
