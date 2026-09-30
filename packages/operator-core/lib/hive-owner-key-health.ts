/**
 * hive-owner-key-health — LOUD, deduped "owner can't sign/serve its hive" signal.
 *
 * Plan: shared-hive-member-content-federation-2026-06-20 — D-024 (split-brain) +
 * D-023 BUG A (orphaned owner keys).
 *
 * When THIS box is the OWNER of a hive (the hive is in its own
 * `listOwnedHiveMeta` directory) but `loadHivePubkey` returns null, the owner can
 * neither stand up the cross-Hive transport nor sign/serve epoch keys — the hive
 * "stays dark" and its members silently never receive content. That detection was
 * previously a single `console.warn` that scrolled away in the boot log, so an
 * orphaned/missing owner key was effectively invisible.
 *
 * This turns it into a deduped owner-facing ESCALATION (a coord broadcast + a
 * toast row, the same rail `notifications:recent` reads), mirroring
 * learning-infra-health's "infra escalates, it doesn't queue" posture: the
 * improvement queue can't fix a missing on-box key, so it pings the owner.
 *
 * Deduped per (workspace, hive): the cross-hive reconcile / outbox-drain re-runs
 * every tick and re-detects the SAME dark hive, so a raw emit would spam. The
 * first detection alerts; subsequent ones are suppressed until
 * `clearOwnedHiveKeyHealth` marks the hive recovered (the key loaded on a later
 * tick) — so a key that disappears AGAIN re-alerts. Cross-tick state is a module
 * singleton (resets on operator restart), deliberately matching
 * learning-infra-health's transition singleton.
 *
 * Every emission is best-effort: a logger or notify failure must NEVER throw into
 * the boot / reconcile path that called it.
 */

import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { machineFingerprint } from './identity/device-keychain-id';
import { broadcastSevereEventResolved } from './severe-event-broadcast';

/** The system identity the owner-key-missing escalation is attributed to. */
const OWNER_KEY_HEALTH_IDENTITY: AgentIdentity = {
  ownerId: 'hive-owner-key-health',
  ownerLabel: 'hive-owner-key-health',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export interface OwnedHiveKeyMissingRef {
  workspaceId: string;
  potSlug: string;
  /** Where the null key was detected ("cross-hive-boot", "epoch-key-reconcile"). */
  context: string;
}

export interface OwnerKeyHealthDeps {
  /** WARN-level log line. Default: console.warn. */
  warn: (msg: string) => void;
  /** Owner-facing escalation (coord broadcast + toast). Best-effort. */
  escalate: (ref: OwnedHiveKeyMissingRef, summary: string) => Promise<void>;
  /**
   * Cross-restart dedup floor: was this hive already alerted within the cooldown
   * window, in THIS or a PRIOR operator process? Default: a persistent toast_log
   * read. The in-memory `signaled` set below dedups within one process, but it
   * RESETS on every operator restart — so on a box that restarts often a
   * persistently-dark hive would re-alert on every boot. This persistent check
   * makes the alert fire once per window, not once per restart. Best-effort +
   * fail-open (see defaultRecentlyAlerted).
   */
  recentlyAlerted?: (ref: OwnedHiveKeyMissingRef) => Promise<boolean>;
}

function dedupKey(workspaceId: string, potSlug: string): string {
  return `${workspaceId}::${potSlug}`;
}

/**
 * WI investigation (2026-07-17, tower-side owner-key-missing alarm): the
 * escalation summary previously carried NO indication of which physical
 * box / process emitted it. `sendMessage`'s broadcast has no host field, so a
 * responder reading "🔴 owner key MISSING for owned hive X" cannot tell
 * whether this is the canonical release/staging host, a peer joiner box
 * (the WI-5108 non-owner-box class), or a stray ad-hoc dev/test operator
 * instance running background workers on the SAME machine as the real
 * owner (proven live: neither the :3070 nor :3170 canonical host actually
 * runs cross-hive-boot — both are request-only clusters per EI-126 — so a
 * firing alert is, in practice, always coming from a THIRD process).
 * Tagging every escalation with a stable per-machine fingerprint + the
 * emitting PID/port turns "which box is this?" from an hour of `ssh` +
 * `journalctl` forensics into reading the alert.
 */
function emittingBoxTag(): string {
  const port = process.env.PAPERCUSP_HONO_PORT ?? process.env.PORT;
  return `${machineFingerprint()}#pid${process.pid}${port ? `:${port}` : ''}`;
}

/** Hives we've already escalated; cleared by clearOwnedHiveKeyHealth on recovery. */
const signaled = new Set<string>();

/**
 * The toast_log row IS the persistent cross-restart dedup floor
 * (`defaultRecentlyAlerted` below reads it back) — if this write never lands,
 * `recentlyAlerted` fails open FOREVER for this hive and every subsequent
 * boot/process on ANY box re-alerts freely, no matter how loud the 6h
 * cooldown comment claims it should be. WI investigation (2026-07-17):
 * confirmed LIVE that `cross-hive-boot` fires this escalation at the
 * earliest phase of boot-all — before `getOrgPg()`'s admin client can
 * reliably resolve (the exact "background workers that booted before the
 * desktop wrote a new embedded-pg.json" race `getOrgPg`'s own doc comment
 * already names) — while the write itself is structurally fine (a manual
 * insert with the identical shape lands cleanly once PG is up). A single
 * short retry survives that boot-time window without blocking boot: the
 * caller (`signalOwnedHiveKeyMissing`) already fires this fully
 * fire-and-forget (`void … .catch(() => {})` at the cross-hive-boot call
 * site), so a multi-second delay here costs nothing.
 */
async function insertOwnerKeyToast(ref: OwnedHiveKeyMissingRef, summary: string): Promise<void> {
  const { getOrgPg, generated } = await import('@papercusp/db-org');
  const { db } = getOrgPg();
  await db.insert(generated.toastLogInHarnessShared).values({
    level: 'error',
    message: 'Hive owner key missing',
    description: `${summary} Restore this box's hive identity key (or re-own the hive) — until then the hive stays dark for its members.`,
    harnessSlug: ref.potSlug,
    createdAt: Date.now(),
    actionLabel: 'Open Insights',
    actionHref: '/adv?tab=insights',
  });
}

const TOAST_RETRY_DELAY_MS = 5000;

async function insertOwnerKeyToastWithRetry(
  ref: OwnedHiveKeyMissingRef,
  summary: string,
  attemptsLeft = 1,
): Promise<void> {
  try {
    await insertOwnerKeyToast(ref, summary);
  } catch {
    if (attemptsLeft <= 0) return; // PG still not ready / write failed — the coord broadcast is the floor
    await new Promise((resolve) => setTimeout(resolve, TOAST_RETRY_DELAY_MS));
    await insertOwnerKeyToastWithRetry(ref, summary, attemptsLeft - 1);
  }
}

/** The default escalation: coord broadcast (the floor) + a toast row (best-effort, retried).
 *  Stamps `condition_key` (the SAME dedupKey clearOwnedHiveKeyHealth resolves) so a later
 *  recovery's broadcastSevereEventResolved can annotate this alarm `resolved:true` instead of
 *  leaving it looking permanently unresolved once the transient boot-time race that caused it
 *  clears on a later reconcile tick (WI investigation 2026-07-21: exactly this — one firing
 *  2026-07-17, self-recovered by the next `system:cross-hive-outbox-drain` tick, silently, with
 *  no way for a reader to tell "still broken" from "recovered minutes later"). */
async function defaultEscalate(ref: OwnedHiveKeyMissingRef, summary: string): Promise<void> {
  await sendMessage(OWNER_KEY_HEALTH_IDENTITY, {
    to: ['*'],
    summary,
    category: 'hive-owner-health',
    // P-033 (d): `hive-owner-key-health` does not match the conservative
    // MACHINE_SENDER_PATTERN — mark it explicitly so the sendMessage seam
    // stamps `expects:'none'` (D-072).
    extra: { condition_key: dedupKey(ref.workspaceId, ref.potSlug), auto: true },
  }).catch(() => {});
  // Toast row — the notification panel / notifications:recent rail, AND the
  // persistent cross-restart dedup floor `defaultRecentlyAlerted` reads back.
  await insertOwnerKeyToastWithRetry(ref, summary).catch(() => {});
}

/**
 * How long a prior owner-key-missing toast suppresses a re-alert for the SAME
 * hive. Bridges operator-restart churn: the in-memory `signaled` set resets on
 * every restart, so without this a persistently-dark hive re-alerts on every
 * boot (the noise this module was created to prevent, defeated by frequent
 * dev-box restarts). A still-dark hive re-surfaces once per window.
 */
const RE_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * The default cross-restart dedup floor: has an owner-key-missing toast for this
 * hive been written within RE_ALERT_COOLDOWN_MS, in THIS or a PRIOR process?
 * Reads the persistent `toast_log` — the SAME rail defaultEscalate writes — so
 * the suppression survives the in-memory singleton's restart reset.
 *
 * Fail-OPEN: any error (PG not ready this early in boot, query failure) returns
 * false → the alert proceeds. A missed suppression costs one extra toast; the
 * in-memory dedup still guards within a process. We never fail CLOSED (that
 * would risk silently swallowing a real owner-key-missing alert).
 */
async function defaultRecentlyAlerted(ref: OwnedHiveKeyMissingRef): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const cutoff = Date.now() - RE_ALERT_COOLDOWN_MS;
    const rows = await sql/* sql */ `
      select 1
        from harness_shared.toast_log
       where message = 'Hive owner key missing'
         and harness_slug = ${ref.potSlug}
         and created_at > ${cutoff}
       limit 1`;
    return rows.length > 0;
  } catch {
    return false; // fail-open — never swallow a real alert on a transient read error
  }
}

const defaultDeps: OwnerKeyHealthDeps = {
   
  warn: (msg: string) => console.warn(msg),
  escalate: defaultEscalate,
  recentlyAlerted: defaultRecentlyAlerted,
};

/**
 * Emit a LOUD, deduped owner-key-missing health signal for a hive THIS box owns
 * but cannot load the identity key for. Returns true when a NEW signal fired,
 * false when it was suppressed (already escalated for this hive — call
 * clearOwnedHiveKeyHealth first if the key recovered). Best-effort + never
 * throws; safe to `void` from a boot/reconcile path.
 */
export async function signalOwnedHiveKeyMissing(
  ref: OwnedHiveKeyMissingRef,
  deps: Partial<OwnerKeyHealthDeps> = {},
): Promise<boolean> {
  const d = { ...defaultDeps, ...deps };
  const k = dedupKey(ref.workspaceId, ref.potSlug);
  if (signaled.has(k)) return false; // already escalated THIS process; suppress until recovery

  // Cross-restart dedup: the in-memory `signaled` set above resets on every
  // operator restart, so a persistently-dark hive would re-alert on each boot.
  // Gate on a PERSISTENT check (the toast_log) so the owner is alerted once per
  // cooldown window, not once per restart. Recovery still re-arms the in-process
  // set immediately (clearOwnedHiveKeyHealth) — this floor only rate-limits how
  // often a still-dark hive re-surfaces. Fail-open, so it never swallows a real
  // alert. Cache the outcome in-process so we don't re-query on every reconcile.
  const recentlyAlerted = d.recentlyAlerted ?? defaultRecentlyAlerted;
  if (await recentlyAlerted(ref).catch(() => false)) {
    signaled.add(k);
    return false;
  }
  signaled.add(k);

  const summary =
    `🔴 owner key MISSING for owned hive ${ref.workspaceId}/${ref.potSlug} (${ref.context}) — ` +
    `this box (${emittingBoxTag()}) owns the hive but loadHivePubkey returned null, so it cannot sign or serve it.`;
  try {
    d.warn(`[hive-owner-key-health] ${summary}`);
  } catch {
    /* a logger that throws must not break the caller */
  }
  try {
    await d.escalate(ref, summary);
  } catch {
    /* best-effort: an escalation failure never throws into boot */
  }
  return true;
}

export interface HiveKeyDivergentRef extends OwnedHiveKeyMissingRef {
  /** The pubkey of the key this box actually holds (the divergent one). */
  heldPubkey: string;
  /** The hive's canonical identity (hives row / verified registry view). */
  canonicalPubkey: string;
}

/**
 * WI-1981 / wake-#5515 recurrence guard: this box holds a hive identity key
 * whose pubkey does NOT match the hive's canonical identity. A divergent key is
 * the epoch-poison class — every `loadHivePubkey != null` authority gate
 * (epoch-key resolver, owner admission, …) would treat this box as the owner
 * and mint/admit under the WRONG identity (permanent mutual epoch_decrypt_fail,
 * proven live tower↔VM 2026-07-03). Deduped per (workspace, hive) within a
 * process, same singleton as the missing-key signal. Best-effort; never throws.
 */
export async function signalHiveKeyDivergent(
  ref: HiveKeyDivergentRef,
  deps: Partial<OwnerKeyHealthDeps> = {},
): Promise<boolean> {
  const d = { ...defaultDeps, ...deps };
  const k = 'divergent::' + dedupKey(ref.workspaceId, ref.potSlug);
  if (signaled.has(k)) return false;
  signaled.add(k);
  const summary =
    `🔴 hive identity key DIVERGENT for ${ref.workspaceId}/${ref.potSlug} (${ref.context}) — ` +
    `this box (${emittingBoxTag()}) holds ${ref.heldPubkey.slice(0, 12)}… but the hive's canonical identity is ` +
    `${ref.canonicalPubkey.slice(0, 12)}…. This is the WI-1981 epoch-poison class: delete the ` +
    `divergent key from EVERY keychain tier (OS keychain AND the encrypted-file dirs — ` +
    `PAPERCUSP_IDENTITY_DIR and legacy ~/.papercusp/identity), remove any ` +
    `papercusp-hive-epoch-key entries it minted, then restart the operator.`;
  try {
    d.warn(`[hive-owner-key-health] ${summary}`);
  } catch {
    /* a logger that throws must not break the caller */
  }
  try {
    await d.escalate(ref, summary);
  } catch {
    /* best-effort: an escalation failure never throws into the caller */
  }
  return true;
}

/**
 * Recovery edge: the owner key loaded for this hive again. Clears the dedup entry
 * so a FUTURE loss re-alerts. Call on the success path (a non-null pubkey).
 *
 * WI investigation (2026-07-21, tower-side owner-key-missing alarm): this used to be a
 * SILENT clear — the in-memory dedup reset, but no one was ever told the hive recovered.
 * `wireOneHive` reconciles on every boot AND every `system:cross-hive-outbox-drain` tick, so a
 * transient keychain-read hiccup (the SAME early-boot/PG-readiness race class already fixed for
 * the toast-write path, see insertOwnerKeyToastWithRetry) self-heals within one tick — but a
 * reader of the original 🔴 alert had no way to tell "still broken" from "recovered minutes
 * later" (proven live: an alert last fired 2026-07-17 01:29Z, never recurred, and
 * loadHivePubkey resolves fine now — yet nothing ever said so). Only broadcast when this WAS a
 * real signaled→recovered transition (Set.delete's return value) — a normal boot where the key
 * was never missing must stay silent, not spam a "recovered" notice for nothing to recover from.
 * Best-effort + never throws, same posture as every other emission in this module.
 */
export function clearOwnedHiveKeyHealth(ref: { workspaceId: string; potSlug: string }): void {
  const k = dedupKey(ref.workspaceId, ref.potSlug);
  const wasSignaled = signaled.delete(k);
  if (!wasSignaled) return;
  void broadcastSevereEventResolved({
    conditionKey: k,
    summary: `✅ owner key RECOVERED for hive ${ref.workspaceId}/${ref.potSlug} — loadHivePubkey resolves again; it can sign/serve the hive.`,
  }).catch(() => {});
}

/**
 * Recovery edge for the DIVERGENT-key alarm (signalHiveKeyDivergent) — the
 * WI-5714 sibling gap to clearOwnedHiveKeyHealth above. That function only ever
 * clears the PLAIN (non-prefixed) dedupKey, so a 'divergent::'-prefixed alert
 * could never emit a RECOVERED broadcast even once the divergence resolved
 * (the held key came to match the hive's canonical identity again, e.g. after
 * a keychain cleanup + re-derive, or an ownership handoff). Call this on that
 * success path — mirrors clearOwnedHiveKeyHealth's shape/posture exactly:
 * only broadcasts on a real signaled→recovered transition (Set.delete's
 * return value), reuses the same severe-event-broadcast.ts resolved-condition
 * rail, and is best-effort + never throws.
 */
export function clearHiveKeyDivergence(ref: { workspaceId: string; potSlug: string }): void {
  const k = 'divergent::' + dedupKey(ref.workspaceId, ref.potSlug);
  const wasSignaled = signaled.delete(k);
  if (!wasSignaled) return;
  void broadcastSevereEventResolved({
    conditionKey: k,
    summary:
      `✅ hive identity key DIVERGENCE RESOLVED for ${ref.workspaceId}/${ref.potSlug} — ` +
      `the held key now matches the hive's canonical identity again.`,
  }).catch(() => {});
}

/** Whether this hive currently has an outstanding (un-recovered) owner-key alert. */
export function isOwnedHiveKeyMissingSignaled(ref: { workspaceId: string; potSlug: string }): boolean {
  return signaled.has(dedupKey(ref.workspaceId, ref.potSlug));
}

/** Whether this hive currently has an outstanding (un-recovered) DIVERGENT-key alert. */
export function isHiveKeyDivergentSignaled(ref: { workspaceId: string; potSlug: string }): boolean {
  return signaled.has('divergent::' + dedupKey(ref.workspaceId, ref.potSlug));
}

/** Test-only — reset the cross-tick dedup singleton. */
export function _resetOwnerKeyHealthForTests(): void {
  signaled.clear();
}
