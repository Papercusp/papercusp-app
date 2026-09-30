/**
 * getSpawnHandoffContext — the PREDECESSOR-HANDOFF half of the spawn/wake
 * hydration seam (directed-wake-honesty-and-spawn-handoff-2026-06-14 P-010 +
 * P-022). Gathers, for a spawning/waking agent working `featureId`:
 *   - predecessorSummaries: its direct blocked_by upstreams' completion/state
 *     (the work it depends on, with their handoff content),
 *   - messages: feature-scoped handoffs addressed to it (`to_feature_id`),
 *   - planSlice: the source plan's Now + recent decisions (the existing
 *     interactive hydration, brought to the autonomous path — plan D-003).
 *
 * PROVENANCE (P-022 — the security half, my trust-author wheelhouse): each
 * source's content is classified by its ORIGIN via the G2 trust gate
 * (work-items-admission). Local / auditor-admitted / trusted-author content is
 * returned RAW (trusted brief context); REMOTE + un-admitted content is wrapped
 * in the G3 untrusted-peer-content frame (`wrapUntrusted`) so a spawned agent
 * treats it as DATA, never as instructions — it must NEVER be injected raw as
 * trusted brief. Ties to shared-hive-trust-admission-2026-06-14 (G2/G3).
 *
 * CONTRACT (locked with su-7b271, the P-021 seam integrator): returns STRUCTURED
 * parts; the seam (assembleSpawnHydration) bounds across all halves + renders
 * the `## Handoff` section. Each `entry.body` is ALREADY provenance-framed and
 * pre-capped to a per-entry budget, so the seam bounds by DROPPING WHOLE ENTRIES
 * — never by truncating a body mid-string (a mid-frame cut would sever an
 * untrusted frame's closing tag = an injection hole). The gather is fail-soft
 * per source: a throwing source degrades to [] / null, never the whole seam.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { wrapUntrusted } from '@papercusp/orchestrator/prompt-build';
import { defaultBlockingStore } from './work-item-blocking';
import { getWorkItem } from './work-items';
import { isAutoPickable, loadTrustedGithubUserIds } from './work-items-admission';
import { getPlanContextBySlug } from './plan-context-for-feature';
import { drainSlotMessages } from './agent-tools/coordination/slot-parked-store';
import type { SlotSelector } from './agent-tools/coordination/slot-selector';
import { resolveWorkspaceForHarness } from './harness/workspace-for-harness';
// Contract types are owned by the P-021 seam (su-7b271, D-004) — import them as
// the single source of truth so producer + consumer never drift. Re-exported
// here for convenience (callers may import from either module).
import type { HandoffEntry, SpawnHandoffContext } from './fleet/spawn-hydration';
export type { HandoffEntry, SpawnHandoffContext };

/** A direct-upstream count cap (P-013: "direct upstreams only"). */
const MAX_PREDECESSORS = 8;
/** Per-entry body budget (chars) — capped BEFORE framing so an untrusted frame
 *  is never split when the seam drops/bounds entries. */
const PER_ENTRY_BODY_CAP = 1200;

/** The pre-classification shape the pure framer consumes (decoupled from PG). */
export interface RawHandoffEntry {
  kind: 'message' | 'completion';
  fromFeatureId?: string;
  author?: string;
  origin: string | null;
  auditVerdict: string | null;
  verifiedAuthorGithubUserId: number | null;
  rawBody: string;
  ts: number;
}

/**
 * PURE map of a drained slot-parked envelope (B2, P-023) to the pre-classification
 * RawHandoffEntry the framer consumes. PROVENANCE (P-022): a FEDERATED envelope
 * (harness_slug set) may carry remote-authored content → classified `remote` so
 * frameHandoffEntries wraps it in the untrusted frame; a non-federated local-scope
 * envelope is `local` → raw. Conservative: a local sender on a shared harness is
 * over-wrapped (the SAFE direction — a false-positive wrap is harmless, a
 * raw-injected remote body is the injection hole). Unit-testable without PG.
 */
export function slotEnvelopeToRawEntry(env: CoordEnvelope, slot: SlotSelector): RawHandoffEntry {
  const subject = (env.summary ?? '').trim();
  const ebody = (env.body ?? '').trim();
  const text = `[@${slot.kind}:${slot.ref}] ${subject}${ebody ? `\n${ebody}` : ''}`;
  return {
    kind: 'message',
    ...(env.from ? { author: env.from } : {}),
    origin: env.harness_slug ? 'remote' : 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    rawBody: text,
    ts: toMs(env.ts),
  };
}

function capBody(body: string, cap: number): { text: string; truncated: boolean } {
  const b = body ?? '';
  if (b.length <= cap) return { text: b, truncated: false };
  return { text: `${b.slice(0, cap)}\n…[truncated]`, truncated: true };
}

/**
 * PURE provenance-classify + frame (P-022 core, unit-testable without PG): for
 * each raw entry, decide trusted via the G2 gate; cap the body; then frame —
 * untrusted bodies are wrapped in `wrapUntrusted` (cap-then-wrap so the frame is
 * intact). `wrap` is injectable for tests; defaults to the canonical G3 frame.
 */
export function frameHandoffEntries(
  raw: RawHandoffEntry[],
  trustedGithubUserIds: ReadonlySet<number>,
  opts?: { perEntryCap?: number; wrap?: (s: string) => string },
): { entries: HandoffEntry[]; truncated: boolean } {
  const cap = opts?.perEntryCap ?? PER_ENTRY_BODY_CAP;
  const wrap = opts?.wrap ?? wrapUntrusted;
  let truncated = false;
  const entries: HandoffEntry[] = [];
  for (const r of raw) {
    const trusted = isAutoPickable(r.origin, r.auditVerdict, r.verifiedAuthorGithubUserId, trustedGithubUserIds);
    const capped = capBody(r.rawBody, cap);
    if (capped.truncated) truncated = true;
    // cap BEFORE wrap — wrapping a truncated body keeps the frame's closing tag.
    const body = trusted ? capped.text : wrap(capped.text);
    entries.push({
      kind: r.kind,
      ...(r.fromFeatureId ? { fromFeatureId: r.fromFeatureId } : {}),
      ...(r.author ? { author: r.author } : {}),
      origin: r.origin === 'remote' ? 'remote' : 'local',
      trusted,
      body,
      ts: r.ts,
    });
  }
  return { entries, truncated };
}

function toMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Gather the predecessor handoff context for a spawning/waking agent. Best-effort
 * + provenance-framed per the contract above. Never throws.
 */
export async function getSpawnHandoffContext(opts: {
  harness: string;
  featureId: string;
  planSlug?: string;
  workspaceId?: string;
  /** B2 deliver-on-spawn (P-023): the spawnee's role, to drain @role:<role> slot
   *  messages alongside @feature:<featureId>. */
  role?: string;
  /** B2 (P-023): the spawnee ownerId recorded as the parked rows' delivered_to.
   *  Slot draining only happens when present (the autonomous spawn path). */
  deliverTo?: string;
  /** Injected clock for the slot-drain expiry cutoff (tests pass fixed). */
  nowMs?: number;
}): Promise<SpawnHandoffContext> {
  const { harness, featureId } = opts;
  // Derive the workspace from the harness when the spawn path didn't thread one — never a
  // silent 'default' (which loads the wrong workspace's trusted-author set → mis-framed
  // provenance). Best-effort: this gather never throws, so a derive failure degrades to an
  // empty trusted set = everything over-wrapped as untrusted, the SAFE direction (P-002 / D-003).
  const workspaceId = await resolveWorkspaceForHarness(harness, opts.workspaceId).catch(
    () => opts.workspaceId ?? '',
  );
  const trustedSet = await loadTrustedGithubUserIds(workspaceId).catch(() => new Set<number>());

  let truncated = false;

  // ── predecessorSummaries: direct blocked_by upstreams ─────────────────────
  let predecessorSummaries: HandoffEntry[] = [];
  try {
    const blockers = (await defaultBlockingStore.blockersFor(harness)).get(featureId) ?? [];
    const raw: RawHandoffEntry[] = [];
    for (const { id: predId } of blockers.slice(0, MAX_PREDECESSORS)) {
      const wi = await getWorkItem(predId, harness).catch(() => null);
      if (!wi) continue;
      const summary = (wi.summary ?? '').trim();
      const body = `${predId} [${wi.state}] ${(wi.title ?? '').trim()}${summary ? `\n${summary}` : ''}`;
      raw.push({
        kind: 'completion',
        fromFeatureId: predId,
        ...(wi.assignee ? { author: wi.assignee } : {}),
        origin: wi.origin,
        auditVerdict: wi.auditVerdict,
        verifiedAuthorGithubUserId: wi.verifiedAuthorGithubUserId,
        rawBody: body,
        ts: 0,
      });
    }
    const framed = frameHandoffEntries(raw, trustedSet);
    predecessorSummaries = framed.entries;
    truncated = truncated || framed.truncated;
  } catch {
    predecessorSummaries = [];
  }

  // ── messages: feature-scoped handoffs addressed to this feature ───────────
  // NOTE (retire-work-item-mail-surface-2026-07-26 P-006): this used to also
  // SELECT harness_shared.messages_consolidated (the retired work-item mail
  // table — its only writer, `messages:send`, was retired in Lane 0). That
  // read is removed here; nothing writes new rows there any more, so it could
  // only ever return stale pre-retirement data. `messages` is now populated
  // SOLELY by the slot-parked drain below (a separate, still-live mechanism —
  // agent-tools/coordination/slot-parked-store, not the mail surface).
  // Existing messages_consolidated rows/table are left untouched (no data
  // deleted); see `_retired/work-item-mail/RESTORE.md` for the write-path.
  let messages: HandoffEntry[] = [];

  // ── slot-parked messages: B2 deliver-on-spawn (P-023) ─────────────────────
  //    A coord:send addressed to a SLOT this spawnee fills (@feature / @role)
  //    that had no agent yet was PARKED (slot-parked-store, P-025); drain the
  //    matching rows EXACTLY ONCE so they land in the SAME `## Handoff` block
  //    (built into the seam, not a separate path). PROVENANCE (P-022): a
  //    FEDERATED envelope (harness_slug set) may carry remote-authored content →
  //    framed UNTRUSTED. This is a conservative over-approximation — a local
  //    sender on a shared harness is also wrapped — but that is the SAFE
  //    direction (a false-positive wrap is harmless; a false-negative raw-inject
  //    of remote content is the injection hole). A non-federated local envelope
  //    is trusted/raw. Drains only with a deliverTo (the recorded delivered_to)
  //    — the autonomous spawn path; fail-soft so a drain failure never breaks the
  //    gather. Unfilled slots are dropped VISIBLY by expireStaleSlotMessages (P-025).
  if (opts.deliverTo) {
    try {
      const slots: SlotSelector[] = [];
      if (featureId) slots.push({ kind: 'feature', ref: featureId });
      if (opts.role) slots.push({ kind: 'role', ref: opts.role });
      if (slots.length > 0) {
        const { sql } = getOrgPg();
        const nowMs = opts.nowMs ?? Date.now();
        const raw: RawHandoffEntry[] = [];
        for (const slot of slots) {
          const drained: CoordEnvelope[] = await drainSlotMessages(sql, {
            slot,
            harnessSlug: harness,
            toOwner: opts.deliverTo,
            nowMs,
          }).catch(() => []);
          for (const env of drained) raw.push(slotEnvelopeToRawEntry(env, slot));
        }
        if (raw.length > 0) {
          const framed = frameHandoffEntries(raw, trustedSet);
          messages = [...messages, ...framed.entries];
          truncated = truncated || framed.truncated;
        }
      }
    } catch {
      /* fail-soft: slot drain never breaks the gather */
    }
  }

  // ── planSlice: the source plan's Now + recent decisions (local/trusted) ───
  let planSlice: string | null = null;
  if (opts.planSlug) {
    planSlice = await getPlanContextBySlug(opts.planSlug).catch(() => null);
  }

  return { messages, predecessorSummaries, planSlice, truncated };
}
