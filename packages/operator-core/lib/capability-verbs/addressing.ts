/**
 * D-020 addressee rails for the provider-neutral capability verbs (D-019 Tier 1).
 *
 * Inbound message content is UNTRUSTED TEXT. An agent that can both read and
 * send is prompt-injectable by anyone able to message the owner, so the
 * mitigation has to be structural rather than prompt wording. Two rails:
 *
 *   RAIL 1 (reply-shaped) — the caller supplies TEXT ONLY. The destination is
 *   resolved server-side from a stored canonical object. Lives in `reply.ts`;
 *   there is deliberately no API here that lets a caller name a reply target.
 *
 *   RAIL 2 (create-shaped) — mail:send to a fresh recipient, calendar:propose
 *   with new attendees. These genuinely take an agent-supplied addressee, so
 *   rail 1 cannot cover them. This module is rail 2.
 *
 * The mechanical insight rail 2 rests on: an INJECTED address is one an
 * attacker wrote into the BODY of a message. It therefore appears only in
 * document text, never in a message's `participants[]` (which the adapter
 * derives from real From/To/Cc headers) and never as a contact. So
 * "appears in body text but never as a participant or contact" is a
 * computable signature of the attack, and it is refused. That is a genuine
 * check, not a heuristic dressed up as one — but see `classifyAddressee` for
 * what it can and cannot prove.
 */
import type postgres from 'postgres';
import { normalizeParticipant } from '../personal-vault/store';

type Db = postgres.Sql | postgres.TransactionSql;

/**
 * How the caller says it came by this address. `contact` and `thread-participant`
 * are VERIFIED server-side; `owner-instruction` cannot be (the server has no
 * view of the chat turn), so it is accepted only for an address that does not
 * carry the injection signature, and is always echoed back to the owner.
 */
export type AddresseeProvenance =
  | { from: 'owner-instruction' }
  | { from: 'contact'; contactExternalId: string }
  | { from: 'thread-participant'; source: string; externalId: string };

export type AddresseeStanding =
  /** Appears as a contact in the owner's vault. */
  | 'known-contact'
  /** Appears in participants[] of at least one stored message/event. */
  | 'prior-correspondent'
  /** Appears ONLY inside document text/metadata — the injection signature. */
  | 'body-only'
  /** Not present in the vault at all. */
  | 'unknown';

export interface AddresseeDecision {
  address: string;
  standing: AddresseeStanding;
  provenance: AddresseeProvenance['from'];
  /** True when the server itself proved the provenance claim. */
  verified: boolean;
}

export class AddresseeRefused extends Error {
  readonly address: string;
  readonly standing: AddresseeStanding;
  readonly code: string;
  constructor(code: string, address: string, standing: AddresseeStanding, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AddresseeRefused';
    this.code = code;
    this.address = address;
    this.standing = standing;
  }
}

/** Reuse the vault's own participant normalization so lookups actually match. */
export function normalizeAddressee(value: string): string {
  const normalized = normalizeParticipant(String(value ?? ''));
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error('addressee_invalid');
  return normalized;
}

/**
 * Where does this address stand in the owner's own vault?
 *
 * Deliberate limits, so a caller does not over-read the verdict:
 *  - `unknown` means ABSENT FROM THE VAULT, not "suspicious". A genuinely new
 *    recipient the owner just typed is `unknown`, which is why `unknown` is
 *    allowed under `owner-instruction` rather than refused outright.
 *  - `body-only` is the load-bearing verdict: present in text, absent from
 *    every participants[] and contact row.
 *  - An empty vault makes EVERY address `unknown`. That is why the caller must
 *    not treat `unknown` as evidence of safety on its own.
 *  - KNOWN LIMIT — an attacker who has actually EMAILED the owner is a
 *    `prior-correspondent`, because their address really does appear in a
 *    participants[] derived from real headers. A later injected instruction
 *    naming that same address therefore passes rail 2. This is a deliberate
 *    boundary, not an oversight: the rail's claim is only that an address
 *    lifted from message CONTENT is refused, and "someone who has corresponded
 *    with the owner" is a materially different standing from "a string an
 *    attacker typed into a body". The residual exposure is also small, because
 *    such an attacker can already be replied to through rail 1. Do not close
 *    this by tightening `prior-correspondent`, which would break ordinary
 *    replies to real people; if it ever needs closing, the lever is requiring
 *    a stronger provenance (`contact`) for create-shaped sends.
 *    Pinned by addressing.integration.test.ts.
 */
export async function classifyAddressee(
  sql: Db,
  params: { workspaceId: string; userId: string; address: string },
): Promise<AddresseeStanding> {
  const address = normalizeAddressee(params.address);
  const rows = await sql<Array<{ asContact: boolean; asParticipant: boolean; inBody: boolean }>>`
    SELECT
      bool_or(d.source = 'contacts' AND ${address} = ANY (d.participants))       AS "asContact",
      bool_or(d.source <> 'contacts' AND ${address} = ANY (d.participants))      AS "asParticipant",
      bool_or(position(${address} in lower(coalesce(d.text, '') || ' '
                                           || coalesce(d.title, ''))) > 0)       AS "inBody"
      FROM harness_shared.personal_documents d
     WHERE d.workspace_id = ${params.workspaceId}
       AND d.user_id = ${params.userId}::uuid`;
  const row = rows[0];
  if (!row) return 'unknown';
  if (row.asContact) return 'known-contact';
  if (row.asParticipant) return 'prior-correspondent';
  if (row.inBody) return 'body-only';
  return 'unknown';
}

async function verifyContact(
  sql: Db,
  params: { workspaceId: string; userId: string; address: string; contactExternalId: string },
): Promise<boolean> {
  const rows = await sql<Array<{ hit: boolean }>>`
    SELECT true AS hit
      FROM harness_shared.personal_documents d
     WHERE d.workspace_id = ${params.workspaceId}
       AND d.user_id = ${params.userId}::uuid
       AND d.source = 'contacts'
       AND d.external_id = ${params.contactExternalId}
       AND ${params.address} = ANY (d.participants)
     LIMIT 1`;
  return rows.length > 0;
}

async function verifyThreadParticipant(
  sql: Db,
  params: { workspaceId: string; userId: string; address: string; source: string; externalId: string },
): Promise<boolean> {
  const rows = await sql<Array<{ hit: boolean }>>`
    SELECT true AS hit
      FROM harness_shared.personal_documents d
     WHERE d.workspace_id = ${params.workspaceId}
       AND d.user_id = ${params.userId}::uuid
       AND d.source = ${params.source}
       AND d.external_id = ${params.externalId}
       AND ${params.address} = ANY (d.participants)
     LIMIT 1`;
  return rows.length > 0;
}

/**
 * Rail 2. Returns a decision for ONE create-shaped addressee, or throws
 * `AddresseeRefused`.
 *
 * The refusal that matters: `body-only` under `owner-instruction`. That is an
 * address the agent could only have read out of message content, which is
 * exactly the injection path — and it is refused even though the caller
 * asserted the owner asked for it, because the server cannot see the chat turn
 * and the address's own standing contradicts the claim.
 */
export async function assertTrustedAddressee(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    address: string;
    provenance: AddresseeProvenance;
  },
): Promise<AddresseeDecision> {
  const address = normalizeAddressee(params.address);
  const standing = await classifyAddressee(sql, { ...params, address });
  const provenance = params.provenance;

  if (provenance.from === 'contact') {
    const ok = await verifyContact(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      address,
      contactExternalId: provenance.contactExternalId,
    });
    if (!ok) {
      throw new AddresseeRefused(
        'addressee_contact_unverified',
        address,
        standing,
        `no vault contact ${provenance.contactExternalId} carries this address`,
      );
    }
    return { address, standing, provenance: 'contact', verified: true };
  }

  if (provenance.from === 'thread-participant') {
    const ok = await verifyThreadParticipant(sql, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      address,
      source: provenance.source,
      externalId: provenance.externalId,
    });
    if (!ok) {
      throw new AddresseeRefused(
        'addressee_not_thread_participant',
        address,
        standing,
        `address is not a participant of ${provenance.source}:${provenance.externalId} — an address quoted in that message's BODY is not a participant`,
      );
    }
    return { address, standing, provenance: 'thread-participant', verified: true };
  }

  // owner-instruction: unverifiable by construction, so the standing decides.
  if (standing === 'body-only') {
    throw new AddresseeRefused(
      'addressee_body_only',
      address,
      standing,
      'this address appears only inside message content and never as a real correspondent or contact — the signature of an addressee injected by an inbound message. Re-send it with from:"contact" or from:"thread-participant" if it is genuinely known, or have the owner state it directly.',
    );
  }
  return { address, standing, provenance: 'owner-instruction', verified: false };
}

/** Rail 2 for a recipient list; refuses the whole send if ANY addressee fails. */
export async function assertTrustedAddressees(
  sql: Db,
  params: {
    workspaceId: string;
    userId: string;
    addresses: readonly string[];
    provenance: AddresseeProvenance;
  },
): Promise<AddresseeDecision[]> {
  if (!params.addresses.length) throw new Error('addressee_required');
  if (params.addresses.length > 50) throw new Error('addressee_too_many');
  const decisions: AddresseeDecision[] = [];
  for (const address of params.addresses) {
    decisions.push(
      await assertTrustedAddressee(sql, {
        workspaceId: params.workspaceId,
        userId: params.userId,
        address,
        provenance: params.provenance,
      }),
    );
  }
  return decisions;
}
