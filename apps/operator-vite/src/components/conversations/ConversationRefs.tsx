/**
 * ConversationRefs — make a conversation's references OPEN the thing they name.
 *
 * WHY (owner ask, 2026-07-27): "the attached to things should actually link to
 * the thing. they should work same way as the linkage -> popup functionality
 * works in our hud tab inside agent conversations."
 *
 * Every conversation surface renders references as dead text today: the
 * deliberation detail's "Attached to · issue · WI-6322", the Q&A detail's
 * "Linked work-item", the unified row's related-work meta, and every `WI-…`
 * an agent typed into a post body. The HUD's chat already solved exactly this
 * (`chat-ref-pills-2026-07-26`), so this module is a THIN BINDING onto that
 * work — it forks nothing (plan D-005):
 *
 *   - `parseWorkRefs`         — pure, markdown-aware ref extraction with offsets
 *   - `HydratedWorkRefPill`   — live state/title, degrades to a neutral pill
 *   - `WorkItemPopupModal`    — the popup destination (Modal + WorkItemDetail)
 *   - `PlanPopupModal`        — the same, for a plan slug
 *
 * Those live in the operator (Next) tree and are reached through the `@/` alias,
 * the same way this folder's siblings already import `@/app/harness/Modal`.
 *
 * The split mirrors `OperatorChat`'s: this module owns the pill rendering and
 * the popup HOST; the CALLER owns the "what is open" URL state, so each surface
 * keeps its own nuqs namespace (the rail's `?lscref`, /adv's `?cref`) and stays
 * deep-linkable and agent-driveable.
 *
 * Refs it will NOT link: anything `asConversationRefKind` doesn't recognize. A
 * popup pointed at the wrong thing is worse than no popup — the stance
 * `WorkItemPopupModal` itself documents for a missing harness.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { parseWorkRefs } from '@/app/_components/chat/parse-work-refs';
import { HydratedWorkRefPill } from '@/app/_components/chat/HydratedWorkRefPill';
import WorkItemPopupModal from '@/app/_components/work-items/WorkItemPopupModal';
import PlanPopupModal from '@/app/_components/plans/PlanPopupModal';
import { Tooltip } from '@/app/harness/Tooltip';
// Relative, not `@/…`: `@` points at the operator (Next) tree, so an
// intra-operator-vite import must be relative or it will not resolve.
import {
  splitFeatureRef,
  type ConversationRef,
  type ConversationRefKind,
} from './unified-conversations';
import './conversation-refs.css';

/** A ref this kit can actually open. `conversation` is handled by the CALLER
 *  (it re-targets the Conversations detail in place rather than opening a
 *  popup over the pane you are already in). */
const POPUP_KINDS = new Set<ConversationRefKind>(['issue', 'feature', 'plan']);

export function isOpenableConversationRef(ref: ConversationRef | null | undefined): boolean {
  return !!ref && (POPUP_KINDS.has(ref.kind) || ref.kind === 'conversation');
}

/** `?<param>=issue:WI-6322` ⇄ ConversationRef. A compound scalar, not JSON —
 *  the repo's rule for encoding a selection in the URL. */
function parseRefParam(raw: string | null): ConversationRef | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  const kind = raw.slice(0, at) as ConversationRefKind;
  const ref = raw.slice(at + 1);
  return ref && POPUP_KINDS.has(kind) ? { kind, ref } : null;
}

export interface ConversationRefPopup {
  /** Open a ref. A `conversation` ref is NOT handled here — callers route that
   *  to their own detail selection; this returns false so they can tell. */
  open: (ref: ConversationRef) => boolean;
  /** Mount once per surface, anywhere in the tree. */
  element: ReactNode;
}

/**
 * The popup host. `paramKey` is the surface's own nuqs param so two surfaces
 * mounted in one document (the rail and /adv are) can never fight over one key.
 *
 * `harnessSlug` scopes a work-item lookup. A `feature` ref carries its own
 * harness in the `<harness>#<F-id>` composite and overrides it; anything else
 * falls back to the conversation's harness, and a null harness renders the
 * popup's own "no harness context" state rather than guessing across harnesses.
 */
export function useConversationRefPopup(
  paramKey: string,
  harnessSlug: string | null,
): ConversationRefPopup {
  const [raw, setRaw] = useQueryState(paramKey, parseAsString);
  const current = useMemo(() => parseRefParam(raw), [raw]);

  const open = useCallback(
    (ref: ConversationRef) => {
      if (!POPUP_KINDS.has(ref.kind)) return false;
      void setRaw(`${ref.kind}:${ref.ref}`);
      return true;
    },
    [setRaw],
  );

  const close = useCallback(() => void setRaw(null), [setRaw]);

  const feature = current?.kind === 'feature' ? splitFeatureRef(current.ref) : null;
  const workItemId =
    current?.kind === 'issue' ? current.ref : current?.kind === 'feature' ? feature!.id : null;
  const workItemHarness = feature?.harnessSlug ?? harnessSlug;

  const element = (
    <>
      <WorkItemPopupModal
        id={workItemId}
        harnessSlug={workItemHarness}
        // A ref INSIDE the open item re-targets this same popup rather than
        // navigating away — WorkItemPopupModal's own documented contract.
        onSelect={(id) => void setRaw(`issue:${id}`)}
        onClose={close}
      />
      <PlanPopupModal
        planSlug={current?.kind === 'plan' ? current.ref : null}
        harnessSlug={harnessSlug}
        onClose={close}
      />
    </>
  );

  return { open, element };
}

// ─── ref rendering ──────────────────────────────────────────────────────────

/**
 * One reference, rendered as a live pill when it is a work item and as a plain
 * chip otherwise. `onOpen` receives the ref; return value is ignored — the
 * caller decides whether that means a popup or an in-pane selection.
 */
export function ConversationRefLink({
  refValue,
  harnessSlug,
  onOpen,
  size = 'xs',
  className,
}: {
  refValue: ConversationRef;
  harnessSlug?: string | null;
  onOpen: (ref: ConversationRef) => void;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  // `issue` and `feature` refs are work items, which is exactly what
  // HydratedWorkRefPill resolves — so they get the live state colour + title.
  if (refValue.kind === 'issue' || refValue.kind === 'feature') {
    const { harnessSlug: refHarness, id } = splitFeatureRef(refValue.ref);
    return (
      <HydratedWorkRefPill
        id={id}
        kind="work-item"
        harnessSlug={refHarness ?? harnessSlug ?? ''}
        size={size}
        className={className}
        onActivate={() => onOpen(refValue)}
      />
    );
  }
  // plan / conversation: no work-item store to hydrate against, so a plain
  // activatable chip carrying the ref verbatim.
  return (
    <Tooltip label={`Open ${refValue.kind} ${refValue.ref}`}>
      <button
        type="button"
        className={`pc-convref__chip pc-convref__chip--${refValue.kind}${className ? ` ${className}` : ''}`}
        onClick={() => onOpen(refValue)}
      >
        {refValue.ref}
      </button>
    </Tooltip>
  );
}

/**
 * Prose with every `WI-`/`EI-`/`F-` reference spliced into a live pill — what
 * makes a conversation body behave like the HUD chat's transcript rather than a
 * wall of dead ids.
 *
 * `parseWorkRefs` is markdown-aware (it will not linkify inside a code span or
 * an existing link) and returns character offsets, so the surrounding text is
 * preserved EXACTLY — this only splices, it never re-renders prose.
 *
 * P-NNN plan-item refs are extracted by `parseWorkRefs` too, but a P-NNN is
 * unique only WITHIN a plan; with no plan context there is nothing safe to
 * resolve against, so those stay plain text (the same stance
 * `HydratedWorkRefPill` takes one layer down).
 */
export function LinkifiedText({
  text,
  harnessSlug,
  onOpen,
  className,
}: {
  text: string | null | undefined;
  harnessSlug?: string | null;
  onOpen: (ref: ConversationRef) => void;
  className?: string;
}) {
  const parts = useMemo<ReactNode[]>(() => {
    const source = text ?? '';
    if (!source) return [];
    const matches = parseWorkRefs(source).filter((m) => m.kind === 'work-item');
    if (matches.length === 0) return [source];
    const out: ReactNode[] = [];
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) out.push(source.slice(cursor, m.start));
      out.push(
        <ConversationRefLink
          key={`${m.id}@${m.start}`}
          refValue={{ kind: 'issue', ref: m.id }}
          harnessSlug={harnessSlug}
          onOpen={onOpen}
        />,
      );
      cursor = m.end;
    }
    if (cursor < source.length) out.push(source.slice(cursor));
    return out;
  }, [text, harnessSlug, onOpen]);

  if (parts.length === 0) return null;
  return <span className={className}>{parts}</span>;
}
