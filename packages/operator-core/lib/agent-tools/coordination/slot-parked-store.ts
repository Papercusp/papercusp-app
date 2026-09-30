/**
 * slot-parked-store.ts — durable park/drain for slot-addressed coord messages
 * (park-for-slot addressing / B2 — directed-wake-honesty-and-spawn-handoff-2026-06-14,
 * P-025; D-005).
 *
 * A coord:send addressed to a SLOT that has no agent yet (`@role:`/`@wave:`/
 * `@feature:`, parsed by ./slot-selector) is PARKED here instead of delivered.
 * When an agent later spawns into that slot, deliver-on-spawn (P-023) DRAINS the
 * pending rows into its handoff brief. A row is claimed EXACTLY ONCE — the drain
 * UPDATE … RETURNING flips delivered_ts atomically, so a concurrent drainer can't
 * double-deliver — or dropped VISIBLY on TTL expiry (a diagnostic row remains),
 * never silently lost, mirroring the await-event delivery ladder.
 *
 * The `sql` handle is injected (the capabilities-store pattern: pg-stores.ts) so
 * the store unit/integration-tests against a throwaway DB without mocking; the
 * host/callers pass `getOrgPg().sql` (the coord 'default' workspace,
 * DEFAULT_COORD_WORKSPACE). Schema = migration 280; this file does NO DDL
 * (storage policy: migrations only).
 */
import type postgres from 'postgres';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { SlotSelector } from './slot-selector';

/**
 * Normalize a `jsonb` envelope column to the object. postgres-js returns a jsonb
 * column inserted as `${JSON.stringify(x)}::text::jsonb` as the raw TEXT it was
 * cast from (not an auto-parsed object) under the prod handle's options
 * (`prepare:false`) AND under a fresh testcontainer pool — so parse a string
 * defensively. Identical posture to PgCoordLog.parseBody (pg-log.ts); without it
 * a drained envelope is the raw JSON string and `env.msg_id`/`env.to` are
 * undefined. (P-025's reads relied on an auto-parse that does not happen here.)
 */
function parseEnvelope(v: unknown): CoordEnvelope {
  if (typeof v === 'string') return JSON.parse(v) as CoordEnvelope;
  return v as CoordEnvelope;
}

export interface ParkSlotMessageInput {
  /** The slot the message is addressed to. */
  slot: SlotSelector;
  /** Harness scope; null/undefined = workspace-level. */
  harnessSlug?: string | null;
  /** The full coord envelope (its `to` carries the slot selector verbatim). */
  envelope: CoordEnvelope;
  /** Optional expiry window in ms; omit/null = never expires. */
  ttlMs?: number | null;
  /** epoch ms "now" — injected so the call site owns the clock (tests pass fixed). */
  nowMs: number;
  workspaceId?: string;
}

/** Park a slot-addressed message. Idempotent on the envelope's msg_id. */
export async function parkSlotMessage(
  sql: postgres.Sql,
  input: ParkSlotMessageInput,
): Promise<{ id: string }> {
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  await sql`
    INSERT INTO harness_shared.slot_parked_messages
      (id, workspace_id, slot_kind, slot_ref, harness_slug, from_owner, envelope, created_ts, ttl_ms)
    VALUES (
      ${input.envelope.msg_id}, ${ws}, ${input.slot.kind}, ${input.slot.ref},
      ${input.harnessSlug ?? null}, ${input.envelope.from},
      ${JSON.stringify(input.envelope)}::text::jsonb,
      ${input.nowMs}, ${input.ttlMs ?? null}
    )
    ON CONFLICT (workspace_id, id) DO NOTHING
  `;
  return { id: input.envelope.msg_id };
}

export interface DrainSlotInput {
  slot: SlotSelector;
  harnessSlug?: string | null;
  /**
   * Drain the slot across EVERY harness_slug in the workspace (ignore the
   * harnessSlug key entirely). The workspace-Queen drain (WI-682) needs this:
   * there is ONE Queen per workspace covering all started hives, but senders
   * park `@role:queen` rows under whatever harness context they had — including
   * NULL — so a slug-keyed drain strands every row parked under a different
   * (or absent) slug. Slug-scoped slots (per-hive roles) leave this unset.
   */
  anyHarnessSlug?: boolean;
  /** The spawnee ownerId the parked messages are being delivered to. */
  toOwner: string;
  /** epoch ms "now" — also the expiry cutoff. */
  nowMs: number;
  workspaceId?: string;
}

/**
 * Claim-and-return every pending (un-delivered, un-dropped, un-expired) message
 * parked for `slot`. Atomic claim: the UPDATE … RETURNING flips delivered_ts so a
 * concurrent drainer can't double-deliver. Expired rows are LEFT for
 * expireStaleSlotMessages so they drop visibly rather than being silently skipped.
 * Returned in park order (ts then msg_id).
 */
export async function drainSlotMessages(
  sql: postgres.Sql,
  input: DrainSlotInput,
): Promise<CoordEnvelope[]> {
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const rows = await sql<{ envelope: CoordEnvelope }[]>`
    UPDATE harness_shared.slot_parked_messages
       SET delivered_ts = ${input.nowMs}, delivered_to = ${input.toOwner}
     WHERE workspace_id = ${ws}
       AND slot_kind = ${input.slot.kind}
       AND slot_ref = ${input.slot.ref}
       AND ${input.anyHarnessSlug ? sql`TRUE` : sql`harness_slug IS NOT DISTINCT FROM ${input.harnessSlug ?? null}`}
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND (ttl_ms IS NULL OR created_ts + ttl_ms > ${input.nowMs})
     RETURNING envelope
  `;
  return rows
    .map((r) => parseEnvelope(r.envelope))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

export interface DrainUserMailboxInput {
  /**
   * The returning member's candidate stable keys — their actorUserKey forms
   * (actor-identity.ts): typically `['gh:<githubUserId>', '<userId>', '<ownerId>']`.
   * A parked `@user:<ref>` row is claimed when its `ref` equals ANY of these, so
   * an assignment addressed by the assigner's preferred key (e.g. `gh:<id>` from
   * the membership roster) is delivered even if the returning session resolves a
   * DIFFERENT rung of the fallback ladder today (the dev-box gh-unauth case).
   */
  keys: readonly string[];
  /** The live ownerId the parked messages are re-delivered to. */
  toOwner: string;
  /** epoch ms "now" — also the expiry cutoff. */
  nowMs: number;
  workspaceId?: string;
}

/**
 * Claim-and-return every pending (un-delivered, un-dropped, un-expired) `@user:`
 * message parked for ANY of the returning member's `keys` (the offline-member
 * mailbox — shared-hive-collaboration P-016). Atomic claim: the UPDATE … RETURNING
 * flips delivered_ts so a concurrent drainer — or the member's *next* session —
 * can't double-deliver. Expired rows are LEFT for expireStaleSlotMessages so they
 * drop visibly. Returned in park order (ts then msg_id).
 *
 * The sibling of {@link drainSlotMessages}, but the drain TRIGGER differs: a
 * role/wave/feature slot drains when an agent SPAWNS into it (deliver-on-spawn,
 * P-023); a `user` slot drains when that MEMBER's own session returns and resolves
 * one of these keys (an inbox-read / presence-arrival hook — see messages.ts
 * drainAndDeliverUserMailbox). A user mailbox is identity-scoped, not per-harness,
 * so harness_slug is not part of the match (an assignment follows the person).
 */
export async function drainUserMailbox(
  sql: postgres.Sql,
  input: DrainUserMailboxInput,
): Promise<CoordEnvelope[]> {
  if (input.keys.length === 0) return [];
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const rows = await sql<{ envelope: CoordEnvelope }[]>`
    UPDATE harness_shared.slot_parked_messages
       SET delivered_ts = ${input.nowMs}, delivered_to = ${input.toOwner}
     WHERE workspace_id = ${ws}
       AND slot_kind = 'user'
       AND slot_ref = ANY(${input.keys as string[]})
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND (ttl_ms IS NULL OR created_ts + ttl_ms > ${input.nowMs})
     RETURNING envelope
  `;
  return rows
    .map((r) => parseEnvelope(r.envelope))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
}

/**
 * Mark every pending message whose TTL has elapsed as dropped (visibly — the row
 * stays with dropped_reason='ttl-expired' for diagnostics), returning how many.
 * A periodic sweep / the deliver-on-spawn path calls this so an unfilled slot's
 * mail is never silently stranded.
 */
export async function expireStaleSlotMessages(
  sql: postgres.Sql,
  nowMs: number,
  workspaceId: string = DEFAULT_COORD_WORKSPACE,
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.slot_parked_messages
       SET dropped_ts = ${nowMs}, dropped_reason = 'ttl-expired'
     WHERE workspace_id = ${workspaceId}
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND ttl_ms IS NOT NULL
       AND created_ts + ttl_ms <= ${nowMs}
     RETURNING id
  `;
  return rows.length;
}

/**
 * Read (without claiming) the pending, un-expired messages parked for `slot`.
 * Diagnostics + tests; the delivery path uses drainSlotMessages.
 */
export async function listPendingForSlot(
  sql: postgres.Sql,
  input: {
    slot: SlotSelector;
    harnessSlug?: string | null;
    nowMs: number;
    workspaceId?: string;
  },
): Promise<CoordEnvelope[]> {
  const ws = input.workspaceId ?? DEFAULT_COORD_WORKSPACE;
  const rows = await sql<{ envelope: CoordEnvelope }[]>`
    SELECT envelope
      FROM harness_shared.slot_parked_messages
     WHERE workspace_id = ${ws}
       AND slot_kind = ${input.slot.kind}
       AND slot_ref = ${input.slot.ref}
       AND harness_slug IS NOT DISTINCT FROM ${input.harnessSlug ?? null}
       AND delivered_ts IS NULL
       AND dropped_ts IS NULL
       AND (ttl_ms IS NULL OR created_ts + ttl_ms > ${input.nowMs})
     ORDER BY created_ts ASC, id ASC
  `;
  return rows.map((r) => parseEnvelope(r.envelope));
}
