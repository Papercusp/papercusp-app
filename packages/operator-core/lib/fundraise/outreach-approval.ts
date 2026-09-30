/**
 * outreach-approval — the send-approval gate for `pipeline-deal`
 * (fundraise-automation-2026-08-23 P-004 / P-015).
 *
 * One question, answered in one place: may this outreach action proceed?
 *
 * The rule the whole fundraise design rests on is that DRAFTING IS FREE AND SENDING IS GATED.
 * Agents research, correlate, classify, and draft autonomously; a human fingerprint stays on every
 * first touch. That split is only real if something enforces it, because "the plan text says to
 * draft" is a request, not a safeguard.
 *
 * Defence in depth, and the layers are deliberately different in kind:
 *
 *   1. The fundraise trigger pack requests no `gmail.send` scope, so no plan in it CAN send.
 *      That is structural and cannot be argued with.
 *   2. This gate governs any future path that does hold a send capability — an owner-run tool, a
 *      different pack, a later automation. Layer 1 protects today; this protects the moment
 *      someone adds a send path and reasonably assumes approval was handled elsewhere.
 *
 * ── FAIL-CLOSED, deliberately ────────────────────────────────────────────────
 * `validateDatatypePayload` fails OPEN on a malformed schema, and that is correct for its domain:
 * a datatype-declaration bug must not block instance creation. The same policy here would be a
 * defect. A missing, malformed, or unparseable approval record means WE DO NOT KNOW whether a human
 * approved this, and "could not check" must never render as "approved" when the irreversible action
 * is mail landing in a partner's inbox. Every unknown path below therefore denies.
 *
 * ── Approval binds to CONTENT, not to a deal ─────────────────────────────────
 * An approval carries the `draftRef` it was granted against. Approving a draft does not approve
 * whatever that draft is later edited or regenerated into — otherwise an agent could obtain
 * approval on innocuous content and then send something else under it. This is the single most
 * important property in the module and `approval drift` is the failure it exists to prevent.
 */

/** Lifecycle of a human approval for outbound contact on one deal. */
export type OutreachApprovalState = 'not-requested' | 'pending' | 'approved' | 'revoked';

/** What an approval covers. Narrower is the default; `all` is never implied. */
export type OutreachApprovalScope = 'first-touch' | 'thread' | 'all';

export interface OutreachApproval {
  state: OutreachApprovalState;
  scope?: OutreachApprovalScope;
  approvedBy?: string;
  approvedAt?: string;
  /** The exact draft this approval was granted against. */
  draftRef?: string;
}

/** The subset of a `pipeline-deal` payload this gate reads. */
export interface OutreachDealView {
  counterparty?: string;
  stage?: string;
  outreachApproval?: OutreachApproval;
  /** Set only when a human actually sent. A drafted message never sets it. */
  lastOutboundAt?: string;
}

export type OutreachAction =
  | { kind: 'draft' }
  | {
      kind: 'send';
      /** The draft being sent, which must match the approved `draftRef` exactly. */
      draftRef: string;
      /** Whether this is the initial contact on the deal. */
      isFirstTouch: boolean;
    };

export type OutreachDecisionCode =
  | 'draft-always-allowed'
  | 'approved'
  | 'no-approval-record'
  | 'malformed-approval'
  | 'not-approved'
  | 'revoked'
  | 'draft-ref-missing'
  | 'draft-ref-mismatch'
  | 'scope-missing'
  | 'scope-insufficient'
  | 'first-touch-already-used'
  | 'approval-expired'
  | 'deal-stage-forbids-contact';

export interface OutreachDecision {
  allowed: boolean;
  code: OutreachDecisionCode;
  /** Operator-facing explanation; safe to surface in Activity and in a refusal. */
  reason: string;
}

/**
 * How long an approval stays good. An approval is a judgement about specific content at a specific
 * moment; carrying it for days invites exactly the drift `draftRef` binding is designed to stop.
 * Re-approving is cheap — it is one click on a draft the owner is already reading.
 */
export const OUTREACH_APPROVAL_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/**
 * Stages where outbound contact is wrong regardless of approval. A deal the counterparty already
 * passed on, or one retired from the ladder, must not receive mail because a stale approval is
 * still sitting on the record.
 */
const NO_CONTACT_STAGES = new Set(['lost', 'dormant']);

const VALID_STATES = new Set<OutreachApprovalState>([
  'not-requested',
  'pending',
  'approved',
  'revoked',
]);

const VALID_SCOPES = new Set<OutreachApprovalScope>(['first-touch', 'thread', 'all']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function deny(code: OutreachDecisionCode, reason: string): OutreachDecision {
  return { allowed: false, code, reason };
}

/**
 * Decide whether one outreach action may proceed against one deal.
 *
 * `now` is injected rather than read from the clock so expiry is testable and so a caller
 * evaluating a batch judges every deal at the same instant.
 */
export function evaluateOutreach(
  deal: OutreachDealView | unknown,
  action: OutreachAction,
  now: Date = new Date(),
): OutreachDecision {
  // Drafting is unconditional and is the whole point: the agent does the work, the human decides
  // whether it leaves the building. Note this is checked before any deal validation — a malformed
  // deal must not block drafting, only sending.
  if (action.kind === 'draft') {
    return {
      allowed: true,
      code: 'draft-always-allowed',
      reason: 'Drafting never requires approval; only sending does.',
    };
  }

  if (!isObj(deal)) {
    return deny(
      'malformed-approval',
      'Deal record is not readable, so approval could not be verified. Refusing to send.',
    );
  }

  const stage = typeof deal.stage === 'string' ? deal.stage : '';
  if (NO_CONTACT_STAGES.has(stage)) {
    return deny(
      'deal-stage-forbids-contact',
      `Deal is at stage "${stage}", where outbound contact is not appropriate regardless of any approval on record.`,
    );
  }

  const rawApproval = deal.outreachApproval;
  if (rawApproval === undefined || rawApproval === null) {
    return deny(
      'no-approval-record',
      'No approval record on this deal. Sending requires an explicit recorded human approval.',
    );
  }
  if (!isObj(rawApproval)) {
    return deny(
      'malformed-approval',
      'Approval record is malformed, so it cannot be verified. Refusing to send.',
    );
  }

  const state = rawApproval.state;
  if (typeof state !== 'string' || !VALID_STATES.has(state as OutreachApprovalState)) {
    return deny(
      'malformed-approval',
      `Approval state ${JSON.stringify(state)} is not a recognised value. Refusing to send.`,
    );
  }

  if (state === 'revoked') {
    return deny('revoked', 'Approval for this deal was revoked.');
  }
  if (state !== 'approved') {
    return deny(
      'not-approved',
      `Approval is "${state}", not "approved". Sending requires a granted approval.`,
    );
  }

  // An approved record still has to be bound to THIS content.
  const approvedDraftRef = rawApproval.draftRef;
  if (typeof approvedDraftRef !== 'string' || !approvedDraftRef.trim()) {
    return deny(
      'draft-ref-missing',
      'Approval carries no draftRef, so it cannot be tied to specific content. Refusing to send.',
    );
  }
  if (typeof action.draftRef !== 'string' || !action.draftRef.trim()) {
    return deny('draft-ref-missing', 'Send action carries no draftRef to check against the approval.');
  }
  if (approvedDraftRef !== action.draftRef) {
    return deny(
      'draft-ref-mismatch',
      'Approval was granted against a different draft. Re-approve the current content rather than sending under a prior approval.',
    );
  }

  const approvedAt = parseTime(rawApproval.approvedAt);
  if (approvedAt === null) {
    return deny(
      'malformed-approval',
      'Approval has no readable approvedAt timestamp, so its age cannot be checked. Refusing to send.',
    );
  }
  const age = now.getTime() - approvedAt;
  if (age > OUTREACH_APPROVAL_MAX_AGE_MS) {
    return deny(
      'approval-expired',
      'Approval is older than the permitted window. Re-approve the draft before sending.',
    );
  }
  if (age < 0) {
    return deny(
      'malformed-approval',
      'Approval is timestamped in the future, so it cannot be trusted. Refusing to send.',
    );
  }

  const scope = rawApproval.scope;
  if (typeof scope !== 'string' || !VALID_SCOPES.has(scope as OutreachApprovalScope)) {
    return deny(
      'scope-missing',
      'Approval declares no valid scope. Scope is never inferred — the widest reading is exactly the one that must not be assumed.',
    );
  }

  if (scope === 'first-touch') {
    if (!action.isFirstTouch) {
      return deny(
        'scope-insufficient',
        'Approval covers the first touch only, and this is a subsequent message. Approve this send explicitly.',
      );
    }
    if (parseTime(deal.lastOutboundAt) !== null) {
      return deny(
        'first-touch-already-used',
        'A first-touch approval has already been consumed on this deal — lastOutboundAt is set. Approve this send explicitly.',
      );
    }
  }

  return {
    allowed: true,
    code: 'approved',
    reason: `Approved by ${typeof rawApproval.approvedBy === 'string' && rawApproval.approvedBy ? rawApproval.approvedBy : 'a human reviewer'} for scope "${scope}" against this exact draft.`,
  };
}

/**
 * Convenience for a call site that only wants to proceed or throw. Prefer `evaluateOutreach` where
 * the refusal should be reported rather than raised — a blocked send is operationally interesting
 * and belongs in Activity, not swallowed as an exception.
 */
export function assertOutreachAllowed(
  deal: OutreachDealView | unknown,
  action: OutreachAction,
  now: Date = new Date(),
): void {
  const decision = evaluateOutreach(deal, action, now);
  if (!decision.allowed) {
    throw new Error(`outreach_blocked:${decision.code}: ${decision.reason}`);
  }
}
