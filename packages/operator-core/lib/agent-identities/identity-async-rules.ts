/**
 * Worn ASYNCHRONOUS identity rules (portable-identity-packages-2026-09-26 P-018; D-027).
 *
 * A `delivery:'async'` rule package is `on` one catalogued event key and fires a
 * capability CLASS verb. Unlike a sync rule it never touches the current turn:
 * the emit enqueues a durable reaction, and the reaction dispatches as the
 * WEARER, never as a synthetic system or plugin principal. This module is the
 * part both halves share:
 *
 *   1. WHAT IS WORN. The same applied-artifact rule pins the sync side reads
 *      (`readAppliedIdentityRules`), filtered to `async`, attributed to their
 *      blueprint layer.
 *   2. ADDRESSING. One subscription row per worn rule and one receipt per
 *      (event fire, wearer, revision, rule). The revision tag is a prefix of the
 *      applied SPECIFICATION revision: the rule set is a pure function of the
 *      specification, so a control-only activation (state revision alone) keeps
 *      the subscriptions and in-flight reactions valid.
 *   3. WHO IS WEARING IT. `readIdentityWearer` re-reads the live control anchor,
 *      so every caller authorizes against the attachment as it is NOW.
 *   4. THE ALLOWLIST. class verb capability ∩ identity-declared needs ∩ pot/role
 *      ceiling ∩ the never-auto protected floor (D-008). Wearer grants are the
 *      dispatcher's own kernel check, which judges the wearer principal's live
 *      identity at dispatch time.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { AsyncRuleDeclaration } from '../cupboard/rule-store';
import { parseCapabilityClassRef } from '../capability-class-registry-store';
import type { IdentityReactionCeiling } from '../capability-envelope/identity-grants-port';
import { getEventKey, normalizeEventKey } from '../event-key-registry-store';
import { validateClassFireTarget, type ClassFireTarget } from '../events/class-fire-target';
import { IDENTITY_WEARER_ROLE, identityCeilingRefusal } from './wearer-authority';
import {
  appliedIdentityRulesAt,
  type AppliedIdentityRules,
  type UnreadableWornRule,
  type WornRulePins,
} from './sync-hook-rules';

export interface WornAsyncRule {
  /** The blueprint layer that pins this rule (the pin's own ref when none does). */
  readonly identityId: string;
  readonly pinRef: string;
  readonly rule: AsyncRuleDeclaration;
}

export interface WornAsyncRules {
  readonly rules: readonly WornAsyncRule[];
  /** A pin that no longer parses cannot fire; it is reported, never guessed at. */
  readonly unreadable: readonly UnreadableWornRule[];
}

/** PURE: the async rules among an applied artifact's rule pins. */
export function wornAsyncRules(pins: WornRulePins): WornAsyncRules {
  const rules: WornAsyncRule[] = [];
  for (const entry of pins.rules) {
    if (entry.rule.delivery === 'async') rules.push({ identityId: entry.identityId, pinRef: entry.pinRef, rule: entry.rule });
  }
  return { rules, unreadable: pins.unreadable };
}

/* ------------------------------------------------------------------ */
/* Addressing.                                                          */
/* ------------------------------------------------------------------ */

/** `coord_entity_subscriptions.derived_from_kind` of a worn-rule subscription; `derived_from_ref` is the ownerId. */
export const IDENTITY_RULE_SUBSCRIPTION_KIND = 'identity-rule';
export const IDENTITY_REVISION_TAG_LENGTH = 16;

/** A fixed-width hex tag for an applied specification revision. */
export function identityRevisionTag(specificationRevision: string): string {
  const hex = /^[0-9a-f]+$/.test(specificationRevision) && specificationRevision.length >= IDENTITY_REVISION_TAG_LENGTH
    ? specificationRevision
    : createHash('sha256').update(specificationRevision).digest('hex');
  return hex.slice(0, IDENTITY_REVISION_TAG_LENGTH);
}

/**
 * `identity-rule:<ownerId>@<tag>:<pinRef>`. The ownerId is part of it because the
 * active-subscription unique index is per subscriber: two wearers of one
 * revision need two rows.
 */
export function identityRuleSubscriberId(ownerId: string, revisionTag: string, pinRef: string): string {
  return `${IDENTITY_RULE_SUBSCRIPTION_KIND}:${ownerId}@${revisionTag}:${pinRef}`;
}

/**
 * Inverse of {@link identityRuleSubscriberId} given the row's ownerId
 * (`derived_from_ref`), which makes it unambiguous whatever the ownerId or ref
 * contains: the tag is fixed-width.
 */
export function parseIdentityRuleSubscriberId(
  subscriberId: string, ownerId: string,
): { revisionTag: string; pinRef: string } | null {
  const prefix = `${IDENTITY_RULE_SUBSCRIPTION_KIND}:${ownerId}@`;
  if (!subscriberId.startsWith(prefix)) return null;
  const rest = subscriberId.slice(prefix.length);
  const revisionTag = rest.slice(0, IDENTITY_REVISION_TAG_LENGTH);
  if (!/^[0-9a-f]{16}$/.test(revisionTag) || rest[IDENTITY_REVISION_TAG_LENGTH] !== ':') return null;
  const pinRef = rest.slice(IDENTITY_REVISION_TAG_LENGTH + 1);
  return pinRef ? { revisionTag, pinRef } : null;
}

/**
 * The receipt/dedupe id of one identity reaction: one per (event fire, wearer,
 * revision, rule), so two wearers get two receipts and a replay of the same
 * fire collapses to one (D-008 dedupe).
 */
export function identityReactionReceiptId(input: {
  fireId: string | number; ownerId: string; revisionTag: string; pinRef: string;
}): string {
  return `identity-reaction:${input.fireId}:${input.ownerId}:${input.revisionTag}:${input.pinRef}`;
}

/* ------------------------------------------------------------------ */
/* The wearer, read live.                                               */
/* ------------------------------------------------------------------ */

export interface IdentityWearer {
  readonly ownerId: string;
  readonly workspaceId: string;
  readonly role: string;
  /** The control anchor's scope harness; null for a workspace-level session. */
  readonly harnessSlug: string | null;
  readonly revisionTag: string;
  readonly rules: AppliedIdentityRules;
}

export interface IdentityWearerDeps {
  readonly readAnchor: (ownerId: string, workspaceId: string) => Promise<{
    applied: AppliedIdentityRules['applied'] | null; harnessSlug: string | null;
  } | null>;
  readonly rulesAt: typeof appliedIdentityRulesAt;
}

/**
 * The wearer as it is NOW. Null when the owner wears no applied identity
 * (detached, or never attached). THROWS when the anchor or the applied artifact
 * cannot be read: a lookup failure is operational, retried by the durable step,
 * and never read as "not wearing" or as permission.
 */
export async function readIdentityWearer(
  ownerId: string, workspaceId: string, deps: Partial<IdentityWearerDeps> = {},
): Promise<IdentityWearer | null> {
  const anchor = await (deps.readAnchor ?? readWearerAnchor)(ownerId, workspaceId);
  if (!anchor?.applied) return null;
  const rules = await (deps.rulesAt ?? appliedIdentityRulesAt)(ownerId, workspaceId, anchor.applied);
  return {
    ownerId, workspaceId, role: IDENTITY_WEARER_ROLE, harnessSlug: anchor.harnessSlug,
    revisionTag: identityRevisionTag(anchor.applied.specificationRevision), rules,
  };
}

/** One row: the applied revision and the scope harness, read together. */
async function readWearerAnchor(ownerId: string, workspaceId: string) {
  const rows = await getOrgPg().sql<{ applied: unknown; harness: string | null }[]>`
    SELECT control_state->'activation'->'applied' AS applied,
           control_state->'scope'->>'harness' AS harness
      FROM harness_shared.session_briefs
     WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
     LIMIT 1`;
  const row = rows[0];
  if (!row) return null;
  const applied = row.applied as { specificationRevision?: unknown; stateRevision?: unknown } | null;
  return {
    applied: typeof applied?.specificationRevision === 'string' && typeof applied.stateRevision === 'string'
      ? { specificationRevision: applied.specificationRevision, stateRevision: applied.stateRevision }
      : null,
    harnessSlug: row.harness || null,
  };
}

/* ------------------------------------------------------------------ */
/* The allowlist.                                                       */
/* ------------------------------------------------------------------ */

export type IdentityReactionAllowlist =
  | { readonly ok: true; readonly capabilities: readonly string[] }
  | { readonly ok: false; readonly code: 'capability-empty'; readonly reason: string };

/** Does a declared need (`id@version` or `id@major`) name the fired class version? */
export function declaredNeedCovers(need: string, target: Pick<ClassFireTarget, 'classId' | 'classVersion'>): boolean {
  const parsed = parseCapabilityClassRef(need);
  if (!parsed || parsed.id !== target.classId) return false;
  return parsed.version === target.classVersion || target.classVersion.startsWith(`${parsed.version}.`);
}

/**
 * PURE (D-008): class verb capability ∩ identity-declared needs ∩ pot/role
 * ceiling ∩ the never-auto protected floor. The floor applies whatever the role:
 * the role envelope exempts `su`, but a reaction is automatic by definition.
 * An identity that declares no grants declares no narrowing of its own.
 *
 * `dispatchCapabilities` are what the dispatch PATH itself needs beyond the
 * class verb: for an `operation` provider, the capabilities `blueprint:submit`
 * declares (D-030 §5). Each passes the same floor and ceilings as the class
 * capability; none substitutes for it.
 */
export function identityReactionAllowlist(input: {
  capability: string;
  target: Pick<ClassFireTarget, 'classId' | 'classVersion' | 'classRef'>;
  declaredClassNeeds: readonly string[] | null;
  ceiling: Pick<IdentityReactionCeiling, 'ceilings' | 'protectedAdditions'>;
  dispatchCapabilities?: readonly string[];
}): IdentityReactionAllowlist {
  const empty = (reason: string): IdentityReactionAllowlist => ({ ok: false, code: 'capability-empty', reason });
  const capability = input.capability.trim();
  if (!capability) return empty(`class ${input.target.classRef} declares no capability for this verb`);
  if (input.declaredClassNeeds && !input.declaredClassNeeds.some((need) => declaredNeedCovers(need, input.target))) {
    return empty(`the identity does not declare a need for class ${input.target.classRef}`);
  }
  const capabilities = [...new Set([capability, ...(input.dispatchCapabilities ?? []).map((cap) => cap.trim())])];
  for (const cap of capabilities) {
    if (!cap) return empty(`the dispatch path for class ${input.target.classRef} names an empty capability`);
    const refusal = identityCeilingRefusal(cap, input.ceiling);
    if (refusal) return empty(refusal);
  }
  return { ok: true, capabilities };
}

/* ------------------------------------------------------------------ */
/* Install checks (D-027 §1).                                           */
/* ------------------------------------------------------------------ */

export type AsyncRuleInstallCheck =
  | { readonly ok: true; readonly capability: string; readonly target: ClassFireTarget }
  | { readonly ok: false; readonly error: string };

/**
 * An async rule installs only when its `on` is ONE active catalogued key (the
 * watch primitive is exact-match) and its `fire` is a class verb that declares
 * the capability the reaction will be sandboxed to. Both are checked again at
 * fire time; this is what makes a bad rule fail before a wearer attaches it.
 *
 * `claimingKeys` are keys the SAME install claims before it activates (an
 * identity's bundled event packages, D-042): that install refuses unless the
 * claim lands, so the key is catalogued by the time any wearer attaches.
 */
export async function checkAsyncRuleInstall(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  rule: Pick<AsyncRuleDeclaration, 'on' | 'fire'>,
  options: { claimingKeys?: ReadonlySet<string> } = {},
): Promise<AsyncRuleInstallCheck> {
  if (!options.claimingKeys?.has(normalizeEventKey(rule.on))) {
    const key = await getEventKey(sql, workspaceId, rule.on);
    if (!key) {
      return { ok: false, error: `event key "${rule.on}" is not catalogued in this workspace (event_key_registry); an async rule listens on one exact catalogued key` };
    }
    if (key.status !== 'active') {
      return { ok: false, error: `event key "${rule.on}" is ${key.status}; an async rule cannot listen on it` };
    }
  }
  const fire = await validateClassFireTarget(sql, workspaceId, rule.fire);
  if (!fire.ok) return { ok: false, error: fire.error };
  return { ok: true, capability: fire.capability, target: fire.target };
}
