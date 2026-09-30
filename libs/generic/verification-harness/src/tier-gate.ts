/**
 * The tier gate: the expensive tier waits for the cheap tier.
 *
 * A contract that declares `tiers` can run each phase on a cheap rig (same-box, local, mocked)
 * and on an expensive one (physical rig, full cut). Every phase that runs in both tiers
 * declares its `code`; the hash of that code is the phase's identity. A cheap-tier pass writes
 * a RECEIPT (phase → code hash). An expensive-tier run is refused, before preflight or any
 * phase is paid for, when a phase it would run has no cheap receipt for its CURRENT hash —
 * i.e. its code changed since it last passed the cheap tier, or it never passed it.
 * Expensive-only phases (physical-only properties) cannot pass the cheap tier and are exempt.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type HarnessContract, HarnessContractError, type PhaseSpec, phaseTiers, type Tier, TIERS } from './contract.js';

/** How many passing hashes are kept per phase, so reverting to a passed version stays admitted. */
export const TIER_RECEIPT_HISTORY = 20;
export const TIER_RECEIPTS_FILE = 'tier-receipts.json';

export interface TierReceipt {
  codeHash: string;
  runId: string;
  passedAt: string;
}

export interface TierReceiptStore {
  schemaVersion: 1;
  harness: string;
  /** Newest first, at most TIER_RECEIPT_HISTORY per phase. */
  receipts: Record<string, TierReceipt[]>;
}

export interface PhaseCodeIdentity {
  /** sha256 of the declared code; null when nothing is declared or an entry did not resolve. */
  hash: string | null;
  /** `code` entries that named a missing file or shell function. */
  unresolved: string[];
}

export type TierGateStatus = 'admitted' | 'refused' | 'exempt';

export interface TierGatePhase {
  phase: string;
  status: TierGateStatus;
  codeHash: string | null;
  /** The cheap-tier pass whose hash matches (admitted), or the newest one (refused on a change). */
  cheapPass: TierReceipt | null;
  /** `tier-gate:<why>` when refused or exempt; null when admitted. */
  reasonCode: string | null;
  unresolved?: string[];
}

export interface TierGateReport {
  tier: 'expensive';
  receiptsPath: string;
  phases: TierGatePhase[];
  refused: number;
  /** Set when the run went ahead despite refusals; the reason is kept with the result. */
  override: { reason: string } | null;
}

export interface TierReceiptsReport {
  tier: 'cheap';
  receiptsPath: string;
  /** Phases whose pass this run recorded, with the code hash it recorded. */
  recorded: { phase: string; codeHash: string }[];
  /** Phases that passed but could not be recorded (no resolvable code identity). */
  unrecorded: { phase: string; reasonCode: string }[];
}

export function defaultTierReceiptsPath(evidenceRoot: string): string {
  return path.join(evidenceRoot, TIER_RECEIPTS_FILE);
}

/** The tier a run uses: required when the contract declares tiers, refused when it does not. */
export function resolveTier(contract: HarnessContract, tier: Tier | null | undefined): Tier | null {
  if (!contract.tiers) {
    if (tier) throw new HarnessContractError(`${contract.name}: --tier ${tier} given but the contract declares no tiers`);
    return null;
  }
  if (!tier) throw new HarnessContractError(`${contract.name}: the contract declares tiers (${TIERS.join(', ')}); pass the tier to run`);
  if (!(TIERS as readonly string[]).includes(tier)) throw new HarnessContractError(`${contract.name}: unknown tier ${tier}`);
  return tier;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/**
 * The text of one shell function: from its `name() {` / `function name {` line through the
 * first line that is exactly `}`. Null when the script does not define it.
 */
export function extractShellFunction(source: string, name: string): string | null {
  const lines = source.split('\n');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^\\s*(?:function\\s+${escaped}(?:\\s*\\(\\s*\\))?|${escaped}\\s*\\(\\s*\\))\\s*\\{?\\s*(?:#.*)?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^\}\s*$/.test(l));
  if (end < 0) return null;
  return lines.slice(start, end + 1).join('\n');
}

/** Hash a phase's declared code. Entries are hashed in sorted order, each under its own name. */
export async function phaseCodeIdentity(spec: Pick<PhaseSpec, 'code'>, codeRoot: string): Promise<PhaseCodeIdentity> {
  const entries = [...(spec.code ?? [])].sort();
  if (entries.length === 0) return { hash: null, unresolved: [] };
  const h = createHash('sha256');
  const unresolved: string[] = [];
  for (const entry of entries) {
    const [rel, fn] = entry.split('#', 2) as [string, string | undefined];
    const abs = path.resolve(codeRoot, rel);
    let st;
    try {
      st = await stat(abs);
    } catch {
      unresolved.push(entry);
      continue;
    }
    if (st.isDirectory()) {
      if (fn) {
        unresolved.push(entry);
        continue;
      }
      for (const file of await listFiles(abs)) {
        h.update(`${entry}/${path.relative(abs, file)}\0`);
        h.update(await readFile(file));
        h.update('\0');
      }
      continue;
    }
    const text = await readFile(abs, 'utf8');
    const body = fn ? extractShellFunction(text, fn) : text;
    if (body === null) {
      unresolved.push(entry);
      continue;
    }
    h.update(`${entry}\0${body}\0`);
  }
  return { hash: unresolved.length > 0 ? null : h.digest('hex'), unresolved };
}

export async function loadTierReceipts(file: string, harness: string): Promise<TierReceiptStore> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, harness, receipts: {} };
    throw err;
  }
  const parsed = JSON.parse(raw) as TierReceiptStore;
  if (parsed?.schemaVersion !== 1 || typeof parsed.receipts !== 'object' || parsed.receipts === null) {
    throw new Error(`${file} is not a tier receipt store (schemaVersion 1)`);
  }
  if (parsed.harness !== harness) throw new Error(`${file} holds receipts for ${parsed.harness}, not ${harness}`);
  return parsed;
}

/** Record cheap-tier passes (re-reads the store first, so concurrent runs lose at most a race). */
export async function recordTierReceipts(
  file: string,
  harness: string,
  passes: readonly ({ phase: string } & TierReceipt)[],
): Promise<void> {
  if (passes.length === 0) return;
  const store = await loadTierReceipts(file, harness);
  for (const p of passes) {
    const prior = (store.receipts[p.phase] ?? []).filter((r) => r.codeHash !== p.codeHash);
    store.receipts[p.phase] = [{ codeHash: p.codeHash, runId: p.runId, passedAt: p.passedAt }, ...prior].slice(0, TIER_RECEIPT_HISTORY);
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`);
  await rename(tmp, file);
}

/**
 * Judge the phases an expensive-tier run is about to execute. A phase is admitted only when a
 * cheap-tier pass is recorded for its current code hash.
 */
export function evaluateTierGate(args: {
  contract: HarnessContract;
  phases: readonly string[];
  identities: ReadonlyMap<string, PhaseCodeIdentity>;
  store: TierReceiptStore;
  receiptsPath: string;
  override?: { reason: string } | null;
}): TierGateReport {
  const byId = new Map(args.contract.phases.map((p) => [p.id, p]));
  const phases = args.phases.map((id): TierGatePhase => {
    const spec = byId.get(id)!;
    if (!phaseTiers(args.contract, spec).includes('cheap')) {
      return { phase: id, status: 'exempt', codeHash: null, cheapPass: null, reasonCode: 'tier-gate:expensive-only' };
    }
    const ident = args.identities.get(id) ?? { hash: null, unresolved: [] };
    const receipts = args.store.receipts[id] ?? [];
    if (ident.hash === null) {
      return {
        phase: id,
        status: 'refused',
        codeHash: null,
        cheapPass: receipts[0] ?? null,
        reasonCode: ident.unresolved.length > 0 ? 'tier-gate:code-unresolved' : 'tier-gate:no-code-identity',
        ...(ident.unresolved.length > 0 ? { unresolved: ident.unresolved } : {}),
      };
    }
    const match = receipts.find((r) => r.codeHash === ident.hash);
    if (match) return { phase: id, status: 'admitted', codeHash: ident.hash, cheapPass: match, reasonCode: null };
    return {
      phase: id,
      status: 'refused',
      codeHash: ident.hash,
      cheapPass: receipts[0] ?? null,
      reasonCode: receipts.length > 0 ? 'tier-gate:code-changed' : 'tier-gate:never-passed-cheap',
    };
  });
  const override = args.override?.reason ? { reason: args.override.reason } : null;
  return {
    tier: 'expensive',
    receiptsPath: args.receiptsPath,
    phases,
    refused: phases.filter((p) => p.status === 'refused').length,
    override,
  };
}

/** True when the gate stops the run: a phase was refused and nobody overrode it. */
export function tierGateBlocks(report: TierGateReport | null | undefined): boolean {
  return !!report && report.refused > 0 && report.override === null;
}

/** One line per refused phase, for the operator reading why the expensive run did not start. */
export function describeTierRefusal(p: TierGatePhase): string {
  const short = (h: string | null | undefined) => (h ? h.slice(0, 12) : '-');
  switch (p.reasonCode) {
    case 'tier-gate:code-changed':
      return `${p.phase}: code changed since its last cheap-tier pass (now ${short(p.codeHash)}, passed ${short(p.cheapPass?.codeHash)} in run ${p.cheapPass?.runId}) — re-run the cheap tier first`;
    case 'tier-gate:never-passed-cheap':
      return `${p.phase}: has never passed the cheap tier at code ${short(p.codeHash)} — run the cheap tier first`;
    case 'tier-gate:code-unresolved':
      return `${p.phase}: declared code did not resolve (${(p.unresolved ?? []).join(', ')})`;
    default:
      return `${p.phase}: ${p.reasonCode ?? 'refused'}`;
  }
}
