'use client';

/**
 * GoalProposalCard — renders a `goals:propose` tool call as the PRE-FILLED,
 * FULLY-EDITABLE confirm card that replaces a blank "New Goal" form
 * (goal-mode-2026-08-07 P-022, design ruling D-024).
 *
 * ── The whole point, in one line ────────────────────────────────────────────
 * The form does not disappear — it arrives already filled in from a read of the
 * portfolio, with one button that creates the goal. Both paths write the same
 * four values; what differs is what PRODUCED them. A blank form asks for the
 * kill criterion and the ceiling cold, before anything has been read, and those
 * two are the only things that can ever stop a goal.
 *
 * ── Field ORDER is the same rule GoalTab uses, and it is not cosmetic ───────
 * Ordered by WHAT CAN STOP THE GOAL: the criterion first, the ceiling second,
 * then the relationship, then context. The rail renders goals in that order too,
 * so the thing the owner edits here is the thing they will later be watching.
 *
 * ── Why the button writes DIRECTLY instead of answering the agent ───────────
 * A registry card inside a session transcript is READ-ONLY on the answer
 * channel: OperatorChat's `onAnswer` needs `onAnswerChoice` + a persisted
 * `msg.seq`, and a session transcript has neither, so a click there only
 * toasts "This card isn't interactive here" (WI-5175). So this card cannot hand
 * values back to a blocked tool call — it performs the create itself, which is
 * also exactly what P-022 specifies ("one button calling goals:create").
 * `POST /api/agent-tools/goals/create` was verified live against :3170; it
 * refuses an unknown workspace rather than defaulting to one, so the
 * silently-wrong-tenant failure GoalTab warns about cannot happen here.
 *
 * ── plan-in-existing-pot DELIBERATELY HAS NO CREATE BUTTON ──────────────────
 * The contract's own answer to "is this a step inside the goal already running?"
 * is that such a thing is a PLAN, not a goal — "release it to the App Store" is
 * a step in shipping the app. So when the agent has (correctly) reached that
 * conclusion, offering a Create-goal button would invite the owner to do the one
 * thing the contract forbids: a second goal silently owning a pot that already
 * has an owner. The card states the conclusion and offers nothing to click.
 * This is the card ENFORCING the contract, not merely displaying it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Target } from 'lucide-react';
import { Select } from '@/app/harness/Select';
import { LazyDetails } from '@/app/_components/LazyDetails';

/** Mirrors `GOAL_RELATIONSHIP_KINDS` in agent-mcp's goals/propose tool. */
export type GoalRelationshipKind =
  | 'plan-in-existing-pot'
  | 'sub-goal'
  | 'sibling-goal'
  | 'new-top-level';

export interface GoalProposalTripwire {
  metric: string;
  label: string;
  threshold: number;
  current?: number;
  unit?: string;
}

/** The `goals:propose` tool-call args, as they arrive off the transcript. */
export interface GoalProposalArgs {
  title: string;
  body?: string;
  killCriterion: string;
  budgetCents: number;
  tripwires?: GoalProposalTripwire[];
  relationship: {
    kind: GoalRelationshipKind;
    ref?: string;
    why: string;
  };
}

/** What the button sends to `goals:create`. */
export interface GoalCreatePayload {
  title: string;
  body?: string;
  killCriterion: string;
  budgetCents: number;
  tripwires?: GoalProposalTripwire[];
  /** Set ONLY for a sub-goal — this is the mechanical difference the kind makes. */
  parentId?: string;
}

export interface GoalCreateResult {
  ok: boolean;
  id?: string;
  error?: string;
}

const RELATIONSHIP_LABELS: Record<GoalRelationshipKind, string> = {
  'plan-in-existing-pot': 'A plan inside an existing goal’s pot — not a new goal',
  'sub-goal': 'A sub-goal of an existing goal',
  'sibling-goal': 'A sibling goal, sharing projects',
  'new-top-level': 'A new top-level goal — nothing already targets this',
};

/**
 * The four kinds in the order the contract argues them: the usual right answer
 * first, the "new goal" answer LAST. A select whose first entry is "new
 * top-level" quietly re-creates the blank form's default-by-omission.
 */
const RELATIONSHIP_ORDER: GoalRelationshipKind[] = [
  'plan-in-existing-pot',
  'sub-goal',
  'sibling-goal',
  'new-top-level',
];

/** `$5.00` — cents in, a figure the owner can check at a glance out. */
export function centsToUsdInput(cents: number): string {
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2);
}

/**
 * Parse the ceiling field back to cents, returning `null` for anything that is
 * not a usable non-negative figure.
 *
 * `null` rather than 0: a ceiling that silently becomes $0 is worse than one
 * that refuses to submit, because $0 reads as "unbudgeted" downstream and the
 * ceiling is one of the two values that can stop the goal.
 */
export function usdInputToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Build the `goals:create` payload from the owner's EDITED values.
 *
 * Pure and exported so the args mapping is unit-testable without a fetch — the
 * `parentId` mapping in particular is the one silent-wrong-result risk here: a
 * sub-goal created without it becomes a top-level goal that merely looks right.
 */
export function buildCreatePayload(fields: {
  title: string;
  body?: string;
  killCriterion: string;
  budgetCents: number;
  tripwires?: GoalProposalTripwire[];
  kind: GoalRelationshipKind;
  ref?: string;
}): GoalCreatePayload {
  const payload: GoalCreatePayload = {
    title: fields.title.trim(),
    killCriterion: fields.killCriterion.trim(),
    budgetCents: fields.budgetCents,
  };
  const body = fields.body?.trim();
  if (body) payload.body = body;
  if (fields.tripwires?.length) payload.tripwires = fields.tripwires;
  // ONLY sub-goal carries lineage. A sibling shares projects, not a parent, and
  // passing ref there would file it under a goal it is explicitly independent of.
  if (fields.kind === 'sub-goal' && fields.ref?.trim()) {
    payload.parentId = fields.ref.trim();
  }
  return payload;
}

/** The real write. Both scopings verified to BIND (an unknown ws is refused). */
async function postGoalCreate(
  payload: GoalCreatePayload,
  workspaceId: string,
  harnessSlug: string,
): Promise<GoalCreateResult> {
  const qs = new URLSearchParams({ ws: workspaceId, harness: harnessSlug });
  const r = await fetch(`/api/agent-tools/goals/create?${qs.toString()}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-papercusp-workspace': workspaceId },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) return { ok: false, error: `goals:create → ${r.status}: ${text.slice(0, 200)}` };
  // The projected-tool transport wraps the tool's own `data` in an MCP
  // content envelope, so the id sits one JSON parse deeper.
  try {
    const outer = JSON.parse(text) as {
      content?: Array<{ text?: string }>;
      error?: string | { message?: string };
    };
    if (outer.error) {
      const msg = typeof outer.error === 'string' ? outer.error : (outer.error.message ?? 'create failed');
      return { ok: false, error: msg };
    }
    const inner = outer.content?.[0]?.text;
    if (!inner) return { ok: false, error: 'goals:create returned no content' };
    const data = JSON.parse(inner) as { id?: string; degradedReasons?: string[] };
    if (!data.id) {
      return { ok: false, error: data.degradedReasons?.join('; ') ?? 'goals:create returned no id' };
    }
    return { ok: true, id: data.id };
  } catch {
    return { ok: false, error: `goals:create → unparseable response: ${text.slice(0, 200)}` };
  }
}

export interface GoalProposalCardProps {
  args: GoalProposalArgs;
  workspaceId: string;
  harnessSlug?: string;
  /**
   * Injected in tests to assert the exact payload. Defaults to the real POST —
   * the default IS the shipped path, so overriding it never hides a broken one
   * (the endpoint itself is verified live, per D-024).
   */
  createGoal?: (payload: GoalCreatePayload) => Promise<GoalCreateResult>;
  onCreated?: (id: string) => void;
}

export function GoalProposalCard({
  args,
  workspaceId,
  harnessSlug = 'papercusp',
  createGoal,
  onCreated,
}: GoalProposalCardProps): ReactNode {
  const [title, setTitle] = useState(args.title ?? '');
  const [body, setBody] = useState(args.body ?? '');
  const [killCriterion, setKillCriterion] = useState(args.killCriterion ?? '');
  const [ceiling, setCeiling] = useState(() => centsToUsdInput(args.budgetCents));
  const [kind, setKind] = useState<GoalRelationshipKind>(
    args.relationship?.kind ?? 'new-top-level',
  );
  const [ref, setRef] = useState(args.relationship?.ref ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const cents = usdInputToCents(ceiling);
  // A step-inside-an-existing-goal has nothing to create — see the header.
  const isNotAGoal = kind === 'plan-in-existing-pot';
  const needsRef = kind !== 'new-top-level';
  const blocked = useMemo(() => {
    if (!title.trim()) return 'Give the goal a title.';
    if (!killCriterion.trim()) return 'A goal needs a kill criterion — it is the only thing that can stop it.';
    if (cents === null) return 'Set a spend ceiling (a number, in dollars).';
    if (needsRef && !ref.trim()) return `A ${RELATIONSHIP_LABELS[kind].toLowerCase()} needs the goal or pot it relates to.`;
    return null;
  }, [title, killCriterion, cents, needsRef, ref, kind]);

  const submit = async (): Promise<void> => {
    if (blocked !== null || cents === null) return;
    setBusy(true);
    setError(null);
    const payload = buildCreatePayload({
      title,
      body,
      killCriterion,
      budgetCents: cents,
      tripwires: args.tripwires,
      kind,
      ref,
    });
    try {
      const result = createGoal
        ? await createGoal(payload)
        : await postGoalCreate(payload, workspaceId, harnessSlug);
      if (result.ok && result.id) {
        setCreatedId(result.id);
        onCreated?.(result.id);
      } else {
        setError(result.error ?? 'goals:create failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (createdId !== null) {
    return (
      <div className="goal-proposal-card" data-testid="goal-proposal-card" data-created="true">
        <p className="goal-proposal-created">
          <Target size={12} aria-hidden /> Goal created —{' '}
          <span className="goal-proposal-created-id">{createdId}</span>. It is now on the Goals rail.
        </p>
      </div>
    );
  }

  return (
    <div
      className="goal-proposal-card"
      data-testid="goal-proposal-card"
      data-kind={kind}
      data-busy={busy ? 'true' : 'false'}
      role="group"
      aria-label="Proposed goal — review and edit before creating"
    >
      <div className="goal-proposal-head">
        <Target size={13} aria-hidden />
        <span className="goal-proposal-heading">Proposed goal</span>
        <span className="goal-proposal-sub">
          filled in from a read of your portfolio — edit anything
        </span>
      </div>

      <label className="goal-proposal-field">
        <span className="goal-proposal-label">Goal</span>
        <input
          className="goal-proposal-input"
          data-testid="goal-proposal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
        />
      </label>

      {/* 1. WHAT ENDS THIS GOAL — first, same rule as the rail. */}
      <label className="goal-proposal-field goal-proposal-field--ends">
        <span className="goal-proposal-label">Ends when</span>
        <textarea
          className="goal-proposal-input goal-proposal-textarea"
          data-testid="goal-proposal-criterion"
          value={killCriterion}
          onChange={(e) => setKillCriterion(e.target.value)}
          rows={2}
          disabled={busy}
        />
      </label>

      {/* 2. The ceiling — the second thing that can end a goal. */}
      <label className="goal-proposal-field">
        <span className="goal-proposal-label">Ceiling</span>
        <span className="goal-proposal-money">
          <span aria-hidden>$</span>
          <input
            className="goal-proposal-input goal-proposal-input--money"
            data-testid="goal-proposal-ceiling"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
            inputMode="decimal"
            aria-label="Spend ceiling in dollars"
            disabled={busy}
          />
        </span>
      </label>

      {/* 3. The question a blank form cannot ask. */}
      <label className="goal-proposal-field">
        <span className="goal-proposal-label">Relationship</span>
        {/* The shared primitive, not a native <select>: design-primitives
            allowlists ZERO native ones, and WebKitGTK draws the native popup
            with its own (unthemeable) chrome inside the Tauri shell. */}
        <Select
          className="goal-proposal-select"
          triggerClassName="goal-proposal-input"
          testId="goal-proposal-kind"
          ariaLabel="Relationship"
          value={kind}
          onChange={(v) => setKind(v as GoalRelationshipKind)}
          disabled={busy}
          options={RELATIONSHIP_ORDER.map((k) => ({ value: k, label: RELATIONSHIP_LABELS[k] }))}
        />
      </label>

      {needsRef && (
        <label className="goal-proposal-field">
          <span className="goal-proposal-label">
            {kind === 'sub-goal' ? 'Parent goal' : 'Related to'}
          </span>
          <input
            className="goal-proposal-input"
            data-testid="goal-proposal-ref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="goal id or pot slug"
            disabled={busy}
          />
        </label>
      )}

      {/* The agent's reasoning, verbatim and read-only: it is evidence for the
          choice above, not another field to edit. */}
      {args.relationship?.why && (
        <p className="goal-proposal-why" data-testid="goal-proposal-why">
          <span className="goal-proposal-why-label">Why:</span> {args.relationship.why}
        </p>
      )}

      {body.trim() !== '' && (
        <LazyDetails
          className="goal-proposal-body"
          summaryClassName="goal-proposal-body-summary"
          summary="What winning looks like"
        >
          <textarea
            className="goal-proposal-input goal-proposal-textarea"
            data-testid="goal-proposal-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            disabled={busy}
          />
        </LazyDetails>
      )}

      {isNotAGoal ? (
        <p className="goal-proposal-notagoal" data-testid="goal-proposal-notagoal" role="status">
          <AlertTriangle size={11} aria-hidden /> This is a step inside an existing goal, so there is
          no goal to create — it belongs as a plan in that goal’s pot. Ask the agent to file the plan,
          or change the relationship above if that reading is wrong.
        </p>
      ) : (
        <div className="goal-proposal-actions">
          <button
            type="button"
            className="goal-proposal-create"
            data-testid="goal-proposal-create"
            onClick={() => void submit()}
            disabled={busy || blocked !== null}
            // No `title={blocked}`: design-primitives forbids title-only
            // tooltips (they never appear on touch/keyboard), and it was pure
            // duplication — the same `blocked` string already renders visibly
            // in the sibling `.goal-proposal-blocked` span below.
          >
            {busy ? 'Creating…' : 'Create goal'}
          </button>
          {blocked !== null && (
            <span className="goal-proposal-blocked" data-testid="goal-proposal-blocked">
              {blocked}
            </span>
          )}
        </div>
      )}

      {error !== null && (
        <p className="goal-proposal-error" data-testid="goal-proposal-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
