/**
 * github-divergence — the GitHub-bridge divergence POLICY
 * (github-bridge-hive-egress-2026-07-02 P-006 / S-4, decisions D-001/D-002).
 *
 * One invariant, enforced structurally: **GitHub is never authority for a
 * bridged hive, and the bridge never force-pushes origin.** Divergence is
 * therefore always REPORTED-NOT-APPLIED: the mechanism layers (github-egress /
 * github-ingress / github-ingress-admission) refuse the unsafe move and hand
 * the residue here; this module folds those residues into ONE durable,
 * human-visible escalation row — the same `harness_escalations` idiom as
 * git-sync's conflict/content escalations, on its OWN phase
 * (`github-bridge`) so it coexists with git-sync rows and never clobbers them.
 *
 * The four signal classes and their (non-)resolution levers:
 *   - `egress-non-ff`    — origin diverged from the hive canonical ref (human
 *     push / legacy merge commit landed on GitHub). NEVER forced. Lever: the
 *     next ingress brings the origin head into the synthetic github-origin
 *     namespace and the INTEGRATOR merges it like any member head; once
 *     canonical descends from origin, egress fast-forwards cleanly.
 *   - `ingress-non-ff`   — origin REWROTE history (the synthetic namespace
 *     would rewind). FF-only by default. Lever: owner-authorized
 *     `allowNonFF` ingress (S-4) — an explicit, audited choice, never auto.
 *   - `admission-blocked`— a revoked contributor's commits (or a fail-closed
 *     admission error) sit in the origin range. The head stays visible in the
 *     namespace but the integrator must not consume it. Lever: revocation
 *     review / admission re-run.
 *   - `egress-secret-block` — the secrets gate refused to publish a ref
 *     (nothing left the machine). Lever: scrub + re-egress. Folded here for
 *     visibility because the bridge tick already composes the same results.
 *   - `bridge-egress-unreachable` — the egress transport could not contact or
 *     publish to GitHub. Without this signal, a push 403 is only an error
 *     string and the otherwise-empty residue reads as `clear`.
 *
 * Pure classification over the mechanism results; a thin injected-sql writer
 * pair for the escalation row (house seam — unit-hermetic, integration-real).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import type { EgressResult } from './github-egress';
import type { IngressResult } from './github-ingress';
import type { AdmissionResult } from './github-ingress-admission';

/** The bridge's own escalation phase — never shared with git-sync's rows. */
export const GITHUB_BRIDGE_ESCALATION_PHASE = 'github-bridge';
export const GITHUB_BRIDGE_ESCALATION_KIND = 'github-bridge-divergence';
export const GITHUB_BRIDGE_WORKFLOW_SCOPE_PATH = '.github/workflows/ci.yml';

export interface AgentActionableRemedy {
  kind: 'github-workflow-scope';
  paths: string[];
  command: string;
}

export type DivergenceSignal =
  | { kind: 'egress-non-ff'; remoteRef: string; remoteSha: string | null; localSha: string; reason: string }
  | { kind: 'ingress-non-ff'; branch: string; local: string; remote: string }
  | {
      kind: 'admission-blocked';
      head: string;
      basis: 'blocked' | 'error';
      blockedAuthors: { githubUserId: number; commits: string[] }[];
      errors: string[];
    }
  | { kind: 'egress-secret-block'; remoteRef: string; findings: number; overflow: boolean }
  | { kind: 'bridge-egress-unreachable'; errors: string[]; transient: boolean }
  | {
      kind: 'bridge-egress-agent-actionable';
      errors: string[];
      transient: false;
      remedy: AgentActionableRemedy;
    }
  /**
   * Ingress failed for EVERY requested branch — the remote itself is
   * unreachable (repo not found / auth refused / network), not a per-branch
   * divergence. Without this signal a bridge whose remote it cannot even
   * contact reports `clear` + `needs_owner:false` on every tick while origin
   * silently freezes: the structured residues (nonFF/absent/admissions) are
   * all empty precisely BECAUSE nothing was fetched, so "no residue" reads as
   * "healthy". Observed live on the oddsmith hive (2026-07-19): the bare
   * store's git transport resolved a different credential than the clone's
   * per-URL helper → `Repository not found` every tick, verdict `clear`.
   * Lever is a HUMAN one (fix the remote URL or wire the credential), so this
   * sets needsOwner — UNLESS `transient` is true: every failing branch traced
   * to a process-level spawn/timeout fault (the git transport never even
   * ran, e.g. `spawn git ENOENT` right after a host restart) rather than git
   * actually running and reporting a transport error. That case self-heals
   * on the next tick and does NOT need an owner (EI-18152354175913564).
   */
  | {
      kind: 'bridge-remote-unreachable';
      remoteUrl: string | null;
      branches: string[];
      errors: string[];
      transient: boolean;
    }
  /**
   * The egress target is live but the bare store has no canonical ref to push.
   * Without this signal an unestablished canonical is INDISTINGUISHABLE from a
   * healthy no-op — the tick reports `egress: null` + `clear` on every pass
   * while origin silently freezes (observed on the hello-world-3-pot canary:
   * the worktree-bridge watermark named a sha whose object was absent, so the
   * catch-up pin's `update-ref` refused and egress no-opped for ~22h reading
   * green). Not an owner lever: the integrator's next publish — or the
   * catch-up pin — establishes it.
   */
  | { kind: 'egress-canonical-missing'; canonicalRef: string; watermarkSha: string | null }
  /**
   * The egress target is live and the canonical ref EXISTS, but it is a
   * strict ancestor of the last ACCEPTED worktree-bridge watermark — i.e. it
   * exists but is STALE. This is the sibling gap to `egress-canonical-missing`
   * (EI-18751829787526583): the ref that reports `egress: { upToDate: 1 }` +
   * `divergence: clear` for hours while origin sat 21 commits behind, because
   * worktree-bridge's step-3.5 `update-ref` (best-effort, unchecked) can fail
   * WITHOUT leaving the ref absent — leaving it pinned at an old sha instead —
   * and the absent-only catch-up pin never re-derives a ref that already
   * exists. Not an owner lever: same self-heal path as canonicalMissing (the
   * catch-up pin re-pins on the next tick; the integrator's next publish also
   * clears it).
   */
  | { kind: 'egress-canonical-stale'; canonicalSha: string; expectedSha: string; behindCount: number };

export interface DivergenceVerdict {
  /** No signals → clear (a clean pass clears the escalation, git-sync idiom). */
  action: 'clear' | 'escalate';
  signals: DivergenceSignal[];
  /**
   * True when resolution needs an OWNER-authorized lever (non-FF ingress, a
   * revoked-contributor decision) rather than just the integrator's next merge.
   */
  needsOwner: boolean;
  /** True when a known local agent remedy exists; this does not page the owner. */
  agentActionable?: boolean;
  /** The concrete local remedies attached to an agent-actionable residue. */
  agentRemedies?: AgentActionableRemedy[];
  /** One-line human summary (the escalation `detail`). */
  detail: string;
}

const WORKFLOW_SCOPE_REFUSAL = /\bworkflow(?:s)?\b[\s\S]{0,180}\bscope\b|\bscope\b[\s\S]{0,180}\bworkflow(?:s)?\b/i;

/** GitHub's workflow-scope refusal is a known local repair, not an owner gate. */
export function isWorkflowScopeRefusal(message: string): boolean {
  return WORKFLOW_SCOPE_REFUSAL.test(message);
}

function workflowPathsFromErrors(errors: string[]): string[] {
  const paths = new Set<string>();
  const pathPattern = /((?:\.github\/)?workflows\/[A-Za-z0-9._/-]+\.ya?ml)/gi;
  for (const error of errors) {
    for (const match of error.matchAll(pathPattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      paths.add(candidate.startsWith('.github/') ? candidate : `.github/${candidate.replace(/^\.?\/?/, '')}`);
    }
  }
  return paths.size > 0 ? [...paths] : [GITHUB_BRIDGE_WORKFLOW_SCOPE_PATH];
}

export function workflowScopeRemedy(errors: string[]): AgentActionableRemedy {
  const paths = workflowPathsFromErrors(errors);
  return {
    kind: 'github-workflow-scope',
    paths,
    command: `git checkout origin/staging -- ${paths.join(' ')}`,
  };
}

function agentActionableSignals(signals: DivergenceSignal[]): Extract<DivergenceSignal, { kind: 'bridge-egress-agent-actionable' }>[] {
  return signals.filter(
    (s): s is Extract<DivergenceSignal, { kind: 'bridge-egress-agent-actionable' }> => s.kind === 'bridge-egress-agent-actionable',
  );
}

function hasAgentActionableResidue(verdict: DivergenceVerdict): boolean {
  return verdict.agentActionable === true || agentActionableSignals(verdict.signals).length > 0;
}

function remediesFor(verdict: DivergenceVerdict): AgentActionableRemedy[] {
  return verdict.agentRemedies?.length ? verdict.agentRemedies : agentActionableSignals(verdict.signals).map((s) => s.remedy);
}

/** Fold the mechanism results into divergence signals. Pure; all inputs optional
 *  (the bridge tick may run egress-only or ingress-only phases). */
export function collectDivergenceSignals(results: {
  egress?: Pick<EgressResult, 'rejectedNonFF' | 'blockedSecrets'> & Partial<Pick<EgressResult, 'remoteErrors'>> | null;
  ingress?: Pick<IngressResult, 'nonFF'> | null;
  /** Admission verdicts for newly-ingressed heads, keyed by the judged head. */
  admissions?: Array<{ head: string; result: Pick<AdmissionResult, 'admit' | 'basis' | 'blockedAuthors' | 'errors'> }>;
  /** Set by the tick when a live egress target found no canonical ref to push. */
  canonicalMissing?: { canonicalRef: string; watermarkSha: string | null } | null;
  /** Set by the tick when the canonical ref exists but is a strict ancestor of
   *  the accepted worktree-bridge watermark (behind, not diverged). */
  canonicalStale?: { canonicalSha: string; expectedSha: string; behindCount: number } | null;
  /** Set by the tick when ingress failed for EVERY requested branch (remote unreachable). */
  remoteUnreachable?: { remoteUrl: string | null; branches: string[]; errors: string[]; transient?: boolean } | null;
}): DivergenceSignal[] {
  const signals: DivergenceSignal[] = [];
  if (results.remoteUnreachable) {
    signals.push({
      kind: 'bridge-remote-unreachable',
      remoteUrl: results.remoteUnreachable.remoteUrl,
      branches: results.remoteUnreachable.branches,
      errors: results.remoteUnreachable.errors,
      transient: results.remoteUnreachable.transient === true,
    });
  }
  if (results.canonicalMissing) {
    signals.push({
      kind: 'egress-canonical-missing',
      canonicalRef: results.canonicalMissing.canonicalRef,
      watermarkSha: results.canonicalMissing.watermarkSha,
    });
  }
  if (results.canonicalStale) {
    signals.push({
      kind: 'egress-canonical-stale',
      canonicalSha: results.canonicalStale.canonicalSha,
      expectedSha: results.canonicalStale.expectedSha,
      behindCount: results.canonicalStale.behindCount,
    });
  }
  for (const r of results.egress?.rejectedNonFF ?? []) {
    signals.push({ kind: 'egress-non-ff', remoteRef: r.remoteRef, remoteSha: r.remoteSha, localSha: r.localSha, reason: r.reason });
  }
  for (const b of results.egress?.blockedSecrets ?? []) {
    signals.push({ kind: 'egress-secret-block', remoteRef: b.remoteRef, findings: b.findings.length, overflow: b.overflow });
  }
  const egressRemoteErrors = results.egress?.remoteErrors ?? [];
  const agentActionableErrors = egressRemoteErrors.filter((e) => !e.transient && isWorkflowScopeRefusal(e.message));
  if (agentActionableErrors.length > 0) {
    const errors = agentActionableErrors.map((e) => e.message);
    signals.push({ kind: 'bridge-egress-agent-actionable', errors, transient: false, remedy: workflowScopeRemedy(errors) });
  }
  const ownerActionableErrors = egressRemoteErrors.filter((e) => !agentActionableErrors.includes(e));
  if (ownerActionableErrors.length > 0) {
    signals.push({
      kind: 'bridge-egress-unreachable',
      errors: ownerActionableErrors.map((e) => e.message),
      transient: ownerActionableErrors.every((e) => e.transient),
    });
  }
  for (const n of results.ingress?.nonFF ?? []) {
    signals.push({ kind: 'ingress-non-ff', branch: n.branch, local: n.local, remote: n.remote });
  }
  for (const a of results.admissions ?? []) {
    if (a.result.admit) continue; // 'baseline'/'clean' are non-events
    signals.push({
      kind: 'admission-blocked',
      head: a.head,
      basis: a.result.basis === 'error' ? 'error' : 'blocked',
      blockedAuthors: a.result.blockedAuthors,
      errors: a.result.errors,
    });
  }
  return signals;
}

/** Classify folded signals into the verdict the escalation writer consumes. Pure. */
export function classifyDivergence(signals: DivergenceSignal[]): DivergenceVerdict {
  if (signals.length === 0) {
    return { action: 'clear', signals, needsOwner: false, agentActionable: false, agentRemedies: [], detail: 'bridge clean — no divergence' };
  }
  // Owner levers: a history rewrite can only be accepted via owner-authorized
  // allowNonFF; a blocked admission needs a revocation decision. An egress
  // non-FF usually self-heals via the integrator's next merge of the ingressed
  // origin head; a secret block needs a scrub, not an owner.
  const needsOwner = signals.some(
    (s) =>
      s.kind === 'ingress-non-ff' ||
      s.kind === 'admission-blocked' ||
      (s.kind === 'bridge-remote-unreachable' && !s.transient) ||
      (s.kind === 'bridge-egress-unreachable' && !s.transient),
  );
  const counts = new Map<DivergenceSignal['kind'], number>();
  for (const s of signals) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const parts: string[] = [];
  const c = (k: DivergenceSignal['kind']): number => counts.get(k) ?? 0;
  const agentSignals = agentActionableSignals(signals);
  const agentRemedies = agentSignals.map((s) => s.remedy);
  if (c('egress-non-ff') > 0)
    parts.push(
      `${c('egress-non-ff')} canonical ref(s) diverged on origin (NOT forced — the integrator merges the ingressed origin head; egress fast-forwards once canonical descends from it)`,
    );
  if (c('ingress-non-ff') > 0)
    parts.push(
      `${c('ingress-non-ff')} origin branch(es) rewrote history (namespace NOT rewound — accepting a rewrite is the owner-authorized allowNonFF lever)`,
    );
  if (c('admission-blocked') > 0)
    parts.push(
      `${c('admission-blocked')} github-origin head(s) blocked by contribution admission (revoked author / fail-closed error — the integrator must not consume them)`,
    );
  if (c('egress-secret-block') > 0)
    parts.push(`${c('egress-secret-block')} ref(s) blocked by the secrets gate (nothing left the machine — scrub + re-egress)`);
  if (agentSignals.length > 0)
    parts.push(
      `${agentSignals.length} egress refusal(s) have a known agent remedy (workflow-scope block) — restore the offending path(s) with ${agentRemedies[0]?.command ?? 'the attached remedy'} and retry egress`,
    );
  const unreachable = signals.filter(
    (s): s is Extract<DivergenceSignal, { kind: 'bridge-remote-unreachable' }> => s.kind === 'bridge-remote-unreachable',
  );
  if (unreachable.some((s) => !s.transient))
    parts.push(
      'the GitHub remote could not be contacted for ANY branch (repo not found / auth refused / network) — the bridge is INERT: nothing ingresses, nothing egresses, and origin is frozen. Fix the remote URL or wire the credential the git transport needs for it',
    );
  if (unreachable.some((s) => s.transient))
    parts.push(
      'the git transport could not even be SPAWNED for ANY branch this tick (e.g. right after a process restart — an env/PATH hiccup, not a remote URL or credential problem) — likely transient; no owner action needed unless it persists across ticks',
    );
  const egressUnreachable = signals.filter(
    (s): s is Extract<DivergenceSignal, { kind: 'bridge-egress-unreachable' }> => s.kind === 'bridge-egress-unreachable',
  );
  if (egressUnreachable.some((s) => !s.transient))
    parts.push(
      'the GitHub egress transport could not contact or publish to the remote (for example, a rejected push) — origin is frozen at the last confirmed egress; fix the remote account/credential or destination before expecting off-box progress',
    );
  if (egressUnreachable.some((s) => s.transient))
    parts.push(
      'the egress git transport could not be SPAWNED this tick — likely transient; no owner action needed unless it persists across ticks',
    );
  if (c('egress-canonical-missing') > 0)
    parts.push(
      `canonical ref absent in the bare store — NOTHING is being egressed and origin is frozen (the integrator has not published it, and the catch-up pin could not: its watermark sha's object is missing). Re-establish canonical, then egress fast-forwards`,
    );
  const stale = signals.find(
    (s): s is Extract<DivergenceSignal, { kind: 'egress-canonical-stale' }> => s.kind === 'egress-canonical-stale',
  );
  if (stale)
    parts.push(
      `canonical ref exists but is STALE — ${stale.behindCount} commit(s) behind the accepted watermark (${stale.canonicalSha.slice(0, 12)} vs ${stale.expectedSha.slice(0, 12)}); egress is publishing the stale content and origin is frozen at it until the catch-up pin re-anchors canonical`,
    );
  return {
    action: 'escalate',
    signals,
    needsOwner,
    agentActionable: agentSignals.length > 0,
    agentRemedies,
    detail: `github-bridge divergence: ${parts.join('; ')}. Origin was never force-pushed and hive canonical refs are unchanged (S-4).`,
  };
}

/**
 * WI-38327: how many CONSECUTIVE owner-actionable ticks before we page a human.
 *
 * A debounce only — `classifyDivergence` already excludes `transient` faults
 * from `needsOwner`, so this is not the transient guard; it is insurance
 * against a single non-transient blip (one bad credential read, one 500 from
 * GitHub) becoming an urgent push.
 */
export const GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS = 2;

/** Stable condition key so repeat sweeps COALESCE onto one owner-facing card
 *  instead of storming one per tick (the git-sync severe-event idiom). */
export function githubBridgeNeedsOwnerConditionKey(potHomeSlug: string): string {
  return `github-bridge-needs-owner:${potHomeSlug}`;
}

/** The alarm latch persisted INSIDE the escalation row body — no new table, no
 *  new column, and it travels with the escalation it describes. */
export interface NeedsOwnerLatch {
  alerted: boolean;
  cause: string | null;
  sweeps: number;
}

export const EMPTY_NEEDS_OWNER_LATCH: NeedsOwnerLatch = { alerted: false, cause: null, sweeps: 0 };

export interface NeedsOwnerAlarmDecision {
  next: NeedsOwnerLatch;
  /** Page the human on THIS tick. */
  alarm: boolean;
  /** We had alarmed and the owner-actionable condition is now gone → all-clear. */
  recovered: boolean;
  /** The cause string this decision is about (null when not owner-actionable). */
  cause: string | null;
}

/**
 * The owner-actionable signal kinds, folded into ONE stable cause string.
 *
 * Sorted + joined so the value is order-independent: the same set of signals
 * always produces the same cause, and a DIFFERENT set produces a different one.
 * That difference is load-bearing — see `decideNeedsOwnerAlarm`.
 */
export function needsOwnerCause(signals: DivergenceSignal[]): string | null {
  const kinds = new Set<string>();
  for (const s of signals) {
    if (s.kind === 'ingress-non-ff' || s.kind === 'admission-blocked') kinds.add(s.kind);
    else if ((s.kind === 'bridge-remote-unreachable' || s.kind === 'bridge-egress-unreachable') && !s.transient) kinds.add(s.kind);
  }
  return kinds.size === 0 ? null : [...kinds].sort().join('+');
}

/**
 * Decide whether this tick pages a human. PURE — the whole latch policy is
 * testable without a database.
 *
 * ⚠ The latch is keyed by CAUSE, never by a bare boolean, and that is
 * deliberate. WI-6643: three distinguishable origin-freshness signals shared
 * one `of_alerted` flag, so whichever latched FIRST silenced the others for as
 * long as it stayed stale — a later, different failure could then be masked
 * forever behind an alarm whose summary described the wrong subsystem. Here a
 * CHANGE of cause re-alarms exactly once, then falls back to one-shot.
 */
export function decideNeedsOwnerAlarm(prev: NeedsOwnerLatch, verdict: DivergenceVerdict): NeedsOwnerAlarmDecision {
  const cause = verdict.action === 'escalate' && verdict.needsOwner ? needsOwnerCause(verdict.signals) : null;

  // Not owner-actionable this tick: reset the latch, and announce an all-clear
  // if we had previously alarmed. A `clear` verdict and an `escalate` verdict
  // whose residues are all self-healing are the SAME thing to an owner.
  if (!cause) {
    return { next: { ...EMPTY_NEEDS_OWNER_LATCH }, alarm: false, recovered: prev.alerted, cause: null };
  }

  // WI-10003620: saturate at the debounce threshold. Past it the count decides
  // nothing, and an ever-growing counter would rewrite (and git-commit) the
  // escalation on every sweep of a standing owner-actionable verdict.
  const sweeps = Math.min(prev.sweeps + 1, GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS);
  const alarm = sweeps >= GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS && (!prev.alerted || prev.cause !== cause);
  return {
    next: { alerted: alarm || prev.alerted, cause: alarm ? cause : (prev.alerted ? prev.cause : null), sweeps },
    alarm,
    recovered: false,
    cause,
  };
}

/** The stored bridge escalation: its alarm latch plus the parsed body (null when
 *  absent, unparseable, or another kind's row). */
interface StoredBridgeEscalation {
  latch: NeedsOwnerLatch;
  body: Record<string, unknown> | null;
}

/** Read the stored row. A missing/!JSON/other-kind row reads as "never alarmed"
 *  with no body — the safe direction: we may alarm (and write) once more than
 *  needed, never one fewer. */
async function readStoredBridgeEscalation(s: Sql, potHomeSlug: string): Promise<StoredBridgeEscalation> {
  const none = (): StoredBridgeEscalation => ({ latch: { ...EMPTY_NEEDS_OWNER_LATCH }, body: null });
  try {
    const rows = (await s.unsafe(
      `SELECT escalation FROM harness_shared.harness_escalations
        WHERE harness_slug = $1 AND phase = $2 AND escalation IS NOT NULL`,
      [potHomeSlug, GITHUB_BRIDGE_ESCALATION_PHASE],
    )) as unknown as Array<{ escalation: string | null }>;
    const raw = rows?.[0]?.escalation;
    if (!raw) return none();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== GITHUB_BRIDGE_ESCALATION_KIND) return none();
    return {
      latch: {
        alerted: parsed.needs_owner_alerted === true,
        cause: typeof parsed.needs_owner_cause === 'string' ? parsed.needs_owner_cause : null,
        sweeps: typeof parsed.needs_owner_sweeps === 'number' ? parsed.needs_owner_sweeps : 0,
      },
      body: parsed,
    };
  } catch {
    return none();
  }
}

/**
 * WI-10003620: fields that change on every re-emit without changing what the
 * escalation SAYS. Only these may differ for a sweep to count as a no-op.
 */
const VOLATILE_BRIDGE_ESCALATION_FIELDS: readonly string[] = ['emitted_at'];

/** Key-order-independent JSON, so a stored body round-tripped through PG text
 *  compares equal to a freshly built one with the same content. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * WI-10003620: true when `next` restates the stored escalation — identical in
 * everything but its emit timestamp. The writer then leaves the row alone.
 *
 * Why it matters beyond one wasted UPDATE: git-export projects every
 * `harness_escalations` row to `.papercusp/state/escalations/<phase>.md`, and
 * git-sync commits that file and publishes it into the member's own pot-git
 * namespace. Re-stamping an unchanged verdict every sweep therefore made every
 * bridged hive with an open divergence commit + announce a meaningless change
 * each tick, forever, and its namespace never stood still long enough for a
 * peer to hold the same OIDs (measured: P-505 Phase A run 9, 2026-09-28).
 */
export function isSameBridgeEscalation(
  stored: Record<string, unknown> | null,
  next: Record<string, unknown>,
): boolean {
  if (!stored) return false;
  const strip = (o: Record<string, unknown>) => {
    const copy: Record<string, unknown> = { ...o };
    for (const k of VOLATILE_BRIDGE_ESCALATION_FIELDS) delete copy[k];
    return copy;
  };
  return canonicalJson(strip(stored)) === canonicalJson(strip(next));
}

/**
 * EI-20562689651892687: retry a transient dynamic-import failure a few times
 * before giving up. `deliverNeedsOwnerAlarm` runs from `papercup-bg-host`, a
 * long-lived tsx process resolving a RELATIVE dynamic `import()` against a
 * tree `git-sync` mutates concurrently (checkout/reset/rebase) — the module
 * file can be transiently absent for the moment node's ESM loader stats it,
 * surfacing as `Cannot find module …/attention-notify` even though the file
 * is present a beat later (confirmed in the bg-host journal: papercusp hit
 * this exact error exactly once, at the ONE tick its one-shot latch tried to
 * fire, then never got a chance to try again — see the header note above on
 * why a latch reading `alerted:true` is INTENT, not delivery). Three attempts
 * with a short backoff turns that one unlucky stat into a non-event; it does
 * NOT change one-shot semantics on a genuine (non-transient) failure — after
 * the retries are exhausted this still swallows and logs, exactly as before,
 * and the `bridge-needs-owner-unalerted` watchdog remains the backstop.
 */
export async function importWithRetry<T>(loader: () => Promise<T>, attempts = 3, delayMs = 300): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await loader();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

/**
 * WI-38327: raise the owner-facing alarm for an owner-gated bridge block.
 *
 * The escalation row this module has always written is DURABLE but not
 * HUMAN-VISIBLE: nothing pages off `harness_escalations`. That gap cost ~26h
 * of frozen egress on 2026-08-12 — `needs_owner:true`, `divergence:"escalate"`
 * and a verbatim GitHub rejection string all sat correctly recorded in the row
 * while every health surface read benign, and it was found only because an
 * agent triaging an unrelated failure went spelunking in the metadata by hand.
 *
 * So this mirrors the three-part alarm `origin-freshness-watchdog` already
 * uses: notifyAttention (the owner rail) + broadcastSevereEvent (the coord
 * card, coalesced on a stable conditionKey) beside the row. Both are
 * best-effort and independently swallowed — paging is never allowed to break a
 * bridge tick. Each import is retried (`importWithRetry`) before either leg is
 * counted as failed — see EI-20562689651892687: this alarm only ever gets ONE
 * shot per episode, so a single transient module-resolution hiccup must not
 * be allowed to spend it silently.
 */
async function deliverNeedsOwnerAlarm(
  potHomeSlug: string,
  workspaceId: string,
  verdict: DivergenceVerdict,
  cause: string,
  sweeps: number,
): Promise<void> {
  const title = `GitHub bridge BLOCKED on ${potHomeSlug} — owner action required`;
  const body =
    `${verdict.detail}\n\n` +
    `This has been the verdict for ${sweeps} consecutive bridge tick(s). Nothing egresses to origin ` +
    `until it is resolved, so work is accumulating on this box with no off-box copy. ` +
    `Inspect: harness_shared.harness_escalations (harness_slug='${potHomeSlug}', phase='${GITHUB_BRIDGE_ESCALATION_PHASE}').`;
  try {
    const { notifyAttention } = await importWithRetry(() => import('../../attention-notify'));
    await notifyAttention({
      kind: 'intervention',
      title,
      body,
      harnessSlug: potHomeSlug,
      importance: 'urgent',
      workspaceId,
      data: { cause, sweeps, conditionKey: githubBridgeNeedsOwnerConditionKey(potHomeSlug) },
    });
  } catch (e) {
    console.warn(`[github-bridge] needs-owner notify failed (${potHomeSlug}): ${e instanceof Error ? e.message : e}`);
  }
  try {
    const { broadcastSevereEvent } = await importWithRetry(() => import('../../severe-event-broadcast'));
    await broadcastSevereEvent({
      summary: title,
      body,
      category: 'severe-event',
      conditionKey: githubBridgeNeedsOwnerConditionKey(potHomeSlug),
      // One-shot until recovery (the latch above): our silence afterwards is
      // deliberate and must never be read as evidence the bridge caught up.
      oneShot: true,
    });
  } catch (e) {
    console.warn(`[github-bridge] needs-owner broadcast failed (${potHomeSlug}): ${e instanceof Error ? e.message : e}`);
  }
}

/** The all-clear for a previously-alarmed owner-gated block. */
async function deliverNeedsOwnerRecovery(potHomeSlug: string): Promise<void> {
  try {
    const { broadcastSevereEventResolved } = await importWithRetry(() => import('../../severe-event-broadcast'));
    await broadcastSevereEventResolved({
      conditionKey: githubBridgeNeedsOwnerConditionKey(potHomeSlug),
      summary: `GitHub bridge RECOVERED on ${potHomeSlug} — the owner-gated block is gone.`,
      body: 'The bridge divergence verdict no longer needs an owner lever; egress can progress again.',
    });
  } catch (e) {
    console.warn(`[github-bridge] needs-owner recovery broadcast failed (${potHomeSlug}): ${e instanceof Error ? e.message : e}`);
  }
}

async function reconcileAgentActionableCondition(potHomeSlug: string, workspaceId: string, verdict: DivergenceVerdict): Promise<void> {
  const remedies = remediesFor(verdict);
  const open = hasAgentActionableResidue(verdict);
  // LAZY ON PURPOSE — do not hoist this to a static import.
  //
  // This module is imported for its CONSTANTS by cheap, widely-reached callers
  // (harness/improvements/watchdog.ts imports GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS
  // "so the guard cannot drift from the thing it guards", explicitly on the
  // stated grounds that github-divergence.ts costs the import graph nothing).
  // A static `import … from '../../coord/condition-bridge'` breaks that: it
  // drags coord/condition-bridge → work-items.ts (and its whole subgraph) into
  // every transitive importer. Measured consequence — it put `runHybridSearch(`
  // inside `memory:search`'s import graph, so search-surface-conformance's
  // graph-derived `engine` read 'hybrid' against a truthful declared 'none'
  // and red-pinned the green gate, four hops from anything about search.
  //
  // A dynamic import is NOT followed by that walk (search/import-graph.ts's
  // runtimeSpecifiers matches only static `import`/`export … from` and
  // side-effect imports), and this is a per-sweep reconcile, not a hot path —
  // so the module still loads exactly when it is actually used.
  const { GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX, reconcileConditions } = await import(
    '../../coord/condition-bridge'
  );
  await reconcileConditions(
    [
      {
        conditionKey: `${GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX}${potHomeSlug}`,
        open,
        title: `GitHub bridge agent fix required on ${potHomeSlug}`,
        summary: open
          ? `${verdict.detail}\n\nKnown agent remedy: ${remedies.map((r) => r.command).join(' && ')}`
          : 'The known agent-actionable GitHub bridge residue has cleared.',
        harness: potHomeSlug,
        severity: 'major',
      },
    ],
    { workspaceId },
  );
}

/**
 * Write/refresh the bridge divergence escalation for a hive — or clear it on a
 * clean pass. One row per (potHomeSlug, 'github-bridge'), upserted like
 * git-sync's writers; the clear targets only our own kind (strict non-clobber).
 * Never throws (best-effort, mirrors the git-sync escalation writers).
 *
 * WI-38327: also PAGES the owner when the verdict is owner-actionable and stays
 * that way (see `decideNeedsOwnerAlarm`). Delivery happens only AFTER the row
 * write succeeds — the latch is what makes the alarm one-shot, so paging
 * without persisting it would storm one urgent notification per tick.
 */
export async function recordDivergenceVerdict(
  potHomeSlug: string,
  workspaceId: string,
  verdict: DivergenceVerdict,
  sql?: Sql,
): Promise<void> {
  let decision: NeedsOwnerAlarmDecision | null = null;
  try {
    const s = sql ?? getOrgPg().sql;
    const stored = await readStoredBridgeEscalation(s, potHomeSlug);
    decision = decideNeedsOwnerAlarm(stored.latch, verdict);
    if (verdict.action === 'clear') {
      await s.unsafe(
        `UPDATE harness_shared.harness_escalations
            SET escalation = NULL, mtime_ms = $2
          WHERE harness_slug = $1 AND phase = $3
            AND escalation IS NOT NULL
            AND (escalation::jsonb ->> 'kind') = $4`,
        [potHomeSlug, Date.now(), GITHUB_BRIDGE_ESCALATION_PHASE, GITHUB_BRIDGE_ESCALATION_KIND],
      );
    } else {
      const next: Record<string, unknown> = {
        kind: GITHUB_BRIDGE_ESCALATION_KIND,
        harness_slug: potHomeSlug,
        needs_owner: verdict.needsOwner,
        signals: verdict.signals,
        emitted_at: Date.now(),
        detail: verdict.detail,
        // WI-38327 alarm latch — persisted here so it travels with the
        // escalation it describes (no new table, no new column).
        needs_owner_alerted: decision.next.alerted,
        needs_owner_cause: decision.next.cause,
        needs_owner_sweeps: decision.next.sweeps,
      };
      // WI-10003620: an unchanged verdict keeps its first-seen emitted_at and
      // mtime_ms. Re-stamping it churned a committed file every sweep (see
      // isSameBridgeEscalation).
      if (!isSameBridgeEscalation(stored.body, next)) {
        await s.unsafe(
          `INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (harness_slug, phase)
           DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`,
          [potHomeSlug, GITHUB_BRIDGE_ESCALATION_PHASE, JSON.stringify(next), Date.now(), workspaceId],
        );
      }
    }
  } catch (e) {
    console.warn(
      `[github-bridge] failed to record divergence verdict (${potHomeSlug}): ${e instanceof Error ? e.message : e}`,
    );
    return; // the latch did not persist — paging now would storm one alarm per tick
  }

  // Deliver AFTER a successful write, and outside the store try/catch so a
  // paging failure is never mistaken for a store failure.
  // Unit callers inject `sql`; production callers use the real writer and also
  // reconcile the agent-actionable condition into the singleton work-item lane.
  if (!sql) {
    try {
      await reconcileAgentActionableCondition(potHomeSlug, workspaceId, verdict);
    } catch (e) {
      console.warn(`[github-bridge] agent-actionable condition reconcile failed (${potHomeSlug}): ${e instanceof Error ? e.message : e}`);
    }
  }
  if (decision?.alarm && decision.cause) {
    await deliverNeedsOwnerAlarm(potHomeSlug, workspaceId, verdict, decision.cause, decision.next.sweeps);
  } else if (decision?.recovered) {
    await deliverNeedsOwnerRecovery(potHomeSlug);
  }
}
