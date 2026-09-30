/**
 * Premise SEMANTICS — the falsifiable half of `premises` (P-011).
 *
 * `classifyPremiseRef` (message-fields.ts) answers "what SHAPE is this ref, and
 * is its kind the sort that CAN go stale?". It is total, pure, and syntactic.
 * Nothing, anywhere, has ever answered the next question: **does the ref
 * actually resolve, and is the claim it encodes still true?**
 *
 * That gap is not theoretical. Measured over the 8 days to 2026-08-01
 * (plan `agent-protocol-authority-semantics-2026-07-26`, D-085):
 *
 *   - `WI-6502#completion` shipped as a premise while WI-6502 was — and still
 *     is — state `open`. A message declared it rested on a completion that had
 *     never happened. Mechanically detectable; not detected.
 *   - **0 of 57** premise refs carried the `@v<N>` version pin the spec
 *     defines. `invalidatable: true` is stamped on ~86% of refs and has never
 *     once been acted on, because nothing consumes a version. A field whose
 *     staleness mechanism nothing reads is a field that cannot go stale — so
 *     agents correctly learned not to bother writing the pin.
 *
 * The rule this module exists to enforce: **a field's semantics are only
 * falsifiable if some check can FAIL.** Classification cannot fail (D-026
 * makes it total on purpose). Resolution can.
 *
 * Contract, inherited verbatim from `resolveGateRefStamps` (the P-006
 * precedent this deliberately mirrors rather than re-invents):
 *   - the ref always travels VERBATIM — verification decorates, never rewrites;
 *   - every probe is fail-soft to `unknown`; a store hiccup must never block a
 *     send, exactly as an unrecognised ref is never rejected (D-026);
 *   - probes are INJECTED, following the same contract P-006 (gate) and P-004
 *     (owner-turn) already use for consumer-owned stores, so the decision logic
 *     here is pure and unit-testable without a database.
 */

import { classifyPremiseRef, type ClassifiedPremise } from './message-fields';

/**
 * The verdict on one premise.
 *
 * `stale` vs `broken` is a real distinction, not a shade: **`stale` means the
 * ground MOVED** (the pinned fact version was superseded — the sender was right
 * when they sent it), **`broken` means the ground was never there** (a
 * `#completion` on an item that has not completed — the sender was wrong at
 * send time). They call for different responses: re-read vs correct.
 */
export type PremiseStatus =
  /** Resolved, and the claim it encodes is currently true. */
  | 'holds'
  /** Resolved, but the pinned version has since been superseded. */
  | 'stale'
  /** Resolved, and the claim it encodes is FALSE. */
  | 'broken'
  /** An invalidatable kind whose target does not exist (dangling citation). */
  | 'unresolvable'
  /** `doc` / `opaque` — declarable, never invalidatable (D-026). Not a failure. */
  | 'not-checkable'
  /** The probe itself failed. Never a send-blocker. */
  | 'unknown';

export interface PremiseStamp extends ClassifiedPremise {
  status: PremiseStatus;
  /** Short human-readable reason, present only when the status is not `holds`. */
  note?: string;
}

/** Mirrors `premisesArg`'s `.max(20)` — one stamp per cited ref, never more. */
export const PREMISE_STAMPS_MAX = 20;

/**
 * Envelope key the resolved stamps ride under (WI-6731).
 *
 * Distinct from `premisesClassified`, which carries the SYNTACTIC half and is
 * stamped unconditionally: classification says what shape a ref is, this says
 * whether it actually resolved. Both travel, because a reader that sees only
 * failures cannot tell "no premises were checkable" from "all of them held".
 */
export const PREMISE_STAMPS_FIELD = 'premiseStamps';

/**
 * The fact-ref grammar, in ONE place.
 *
 * Three forms are live in the corpus, and only the first is the documented one:
 *   `fact:owner:<id>:<key>@v<N>`   — documented; observed 0 times
 *   `fact:<scope>:<scopeRef>:<key>` — observed 4/5 (scope `harness`)
 *   `fact:<key>`                    — observed 1/5
 *
 * Exported because hand-rolling this parse is a live source of FALSE
 * NEGATIVES: a checker that strips only the `owner:` form reads four perfectly
 * real facts as dangling. A key may itself contain `:` (`dead-end:<slug>`,
 * `wall:<slug>`, `guard-rail:<slug>` — see FACT_*_KEY_PREFIX), so the key is everything after the
 * scope pair, never `split(':')[2]`.
 */
export interface ParsedFactRef {
  scope?: string;
  scopeRef?: string;
  key: string;
  /** The `@v<N>` pin, when present. Absent on every observed ref to date. */
  version?: number;
}

/** Kept in step with `FACT_SCOPES` (agent-facts/store.ts). */
const FACT_SCOPE_NAMES: ReadonlySet<string> = new Set([
  'workspace',
  'role',
  'owner',
  'harness',
  'work_item',
]);

export function parseFactRef(ref: string): ParsedFactRef | null {
  const trimmed = ref.trim();
  if (!trimmed.startsWith('fact:')) return null;
  let rest = trimmed.slice('fact:'.length);
  if (!rest) return null;

  let version: number | undefined;
  const pin = /@v(\d+)$/.exec(rest);
  if (pin) {
    version = Number(pin[1]);
    rest = rest.slice(0, pin.index);
  }

  const segments = rest.split(':');
  // Workspace facts are global to the workspace, so their canonical citation
  // deliberately omits a scopeRef: `fact:workspace:<key>`. Keep the whole
  // remaining tail as the key, matching factCitationRef/parseAssumptionRef;
  // treating this two-segment form as a bare key makes a real workspace fact
  // look dangling to the premise stamp resolver.
  if (segments.length >= 2 && segments[0] === 'workspace') {
    return {
      scope: 'workspace',
      key: segments.slice(1).join(':'),
      version,
    };
  }
  if (segments.length >= 3 && FACT_SCOPE_NAMES.has(segments[0]!)) {
    return {
      scope: segments[0],
      scopeRef: segments[1],
      key: segments.slice(2).join(':'),
      version,
    };
  }
  return { key: rest, version };
}

/** Split `<plan-slug>#D-NNN` into its two halves. */
export function parsePlanDecisionRef(ref: string): { slug: string; decisionId: string } | null {
  const idx = ref.lastIndexOf('#');
  if (idx <= 0) return null;
  const slug = ref.slice(0, idx);
  const decisionId = ref.slice(idx + 1);
  if (!/^D-\d+$/.test(decisionId)) return null;
  return { slug, decisionId };
}

/** Split `<plan-slug>#P-NNN` into its two halves. */
export function parsePlanItemRef(ref: string): { slug: string; itemId: string } | null {
  const idx = ref.lastIndexOf('#');
  if (idx <= 0) return null;
  const slug = ref.slice(0, idx);
  const itemId = ref.slice(idx + 1);
  if (!/^P-\d+$/.test(itemId)) return null;
  return { slug, itemId };
}

/**
 * Parse a work-item ref in any of its live forms:
 *   `WI-6502#completion` → { id: 'WI-6502', anchor: 'completion' }
 *   `WI-6502#checkpoint` → { id: 'WI-6502', anchor: 'checkpoint' }
 *   `WI-6560`            → { id: 'WI-6560' }
 *   `wi:EI-1883…`        → { id: 'EI-1883…' }
 *
 * ⚠ THE ANCHOR IS OPTIONAL, and it did not used to be: the old
 * `if (idx <= 0) return null` made a BARE id unparseable, which was invisible
 * only because the classifier never produced one. Widening the classifier
 * without widening this would have turned every bare id into `unknown` — a
 * silent no-op wearing the costume of a fix.
 *
 * The id shape is VALIDATED here rather than assumed from the caller's arm, so
 * this is sound standalone: `some-plan#Now` is not a work-item ref and must not
 * parse into one just because it happens to contain a `#`.
 */
export function parseWorkItemRef(ref: string): { id: string; anchor?: string } | null {
  const trimmed = ref.trim().replace(/^wi:/i, '');
  const idx = trimmed.indexOf('#');
  const id = idx < 0 ? trimmed : trimmed.slice(0, idx);
  if (!/^(?:WI|EI)-\d+$/i.test(id)) return null;
  const anchor = idx < 0 ? undefined : trimmed.slice(idx + 1);
  return anchor ? { id, anchor } : { id };
}

export interface WorkItemProbeResult {
  exists: boolean;
  /** The live state, for the note. */
  state?: string;
  /** Whether `state` is one of ISSUE_TERMINAL_STATES. */
  terminal?: boolean;
}

export interface FactProbeResult {
  exists: boolean;
  /** Non-null ⇒ the version the sender pinned has been replaced. */
  supersededAt?: string | null;
}

/**
 * Consumer-owned store access. Every probe is optional: an absent probe yields
 * `unknown` for that kind rather than a failure, so a caller can verify only
 * the kinds it cheaply can.
 */
export interface PremiseProbes {
  workItem?(id: string): Promise<WorkItemProbeResult | null>;
  planDecision?(
    slug: string,
    decisionId: string,
  ): Promise<{ planExists: boolean; decisionExists: boolean } | null>;
  planItem?(
    slug: string,
    itemId: string,
  ): Promise<{ planExists: boolean; itemExists: boolean } | null>;
  fact?(parsed: ParsedFactRef): Promise<FactProbeResult | null>;
  message?(msgId: string): Promise<{ exists: boolean } | null>;
}

async function resolveOne(c: ClassifiedPremise, probes: PremiseProbes): Promise<PremiseStamp> {
  // D-026: declarable-but-not-invalidatable kinds are not failures. Saying
  // "I read this doc" is a legitimate premise; it simply cannot go stale.
  if (!c.invalidatable) return { ...c, status: 'not-checkable' };

  try {
    switch (c.kind) {
      case 'work-item-completion': {
        const parsed = parseWorkItemRef(c.ref);
        if (!parsed || !probes.workItem) return { ...c, status: 'unknown' };
        const wi = await probes.workItem(parsed.id);
        if (!wi) return { ...c, status: 'unknown' };
        if (!wi.exists) {
          return { ...c, status: 'unresolvable', note: `${parsed.id} does not exist` };
        }
        // THE WI-6502 CASE. Citing `#completion` asserts the item completed.
        // An open item has no completion to rest on — the premise is false at
        // send time, which is `broken`, not `stale`.
        if (parsed.anchor === 'completion' && wi.terminal === false) {
          return {
            ...c,
            status: 'broken',
            note: `${parsed.id} is ${wi.state ?? 'non-terminal'} — it has not completed`,
          };
        }
        return { ...c, status: 'holds' };
      }

      // A work item cited as ITSELF (`WI-6560`, `wi:EI-1883…`, `WI-6502#checkpoint`).
      //
      // ⚠ EXISTENCE, AND DELIBERATELY NOTHING MORE — this arm may never return
      // `broken`, and the reason is D-026 correction 2, not caution. `broken`
      // means the claim the ref encodes is FALSE; a bare id encodes only "this
      // item exists", so the sole way it can fail is by not resolving. Reaching
      // for the item's STATE here (open ⇒ broken) would silently convert a
      // container citation into the completion assertion the sender pointedly
      // did not make, and would tell a reader the sender was wrong when they
      // were not. The `#completion` arm above is where a state check belongs
      // and the only place it is licensed.
      //
      // The anchor is read but NOT verified: `#checkpoint` (9 of the 23 refs
      // measured live on 2026-08-01) would need a per-anchor probe to say
      // anything more, and inventing verdicts for anchors we cannot check is
      // how a decoration becomes a false accusation.
      case 'work-item': {
        const parsed = parseWorkItemRef(c.ref);
        if (!parsed || !probes.workItem) return { ...c, status: 'unknown' };
        const wi = await probes.workItem(parsed.id);
        if (!wi) return { ...c, status: 'unknown' };
        return wi.exists
          ? { ...c, status: 'holds' }
          : { ...c, status: 'unresolvable', note: `${parsed.id} does not exist` };
      }

      case 'plan-decision': {
        const parsed = parsePlanDecisionRef(c.ref);
        if (!parsed || !probes.planDecision) return { ...c, status: 'unknown' };
        const r = await probes.planDecision(parsed.slug, parsed.decisionId);
        if (!r) return { ...c, status: 'unknown' };
        if (!r.planExists) {
          return { ...c, status: 'unresolvable', note: `no plan '${parsed.slug}'` };
        }
        if (!r.decisionExists) {
          return {
            ...c,
            status: 'unresolvable',
            note: `${parsed.slug} has no ${parsed.decisionId}`,
          };
        }
        return { ...c, status: 'holds' };
      }

      // `<plan-slug>#P-NNN`. Mirrors the plan-decision arm, and stops short in
      // the same place: the item's STATUS is not checked, because the ref does
      // not pin one. Resting on a plan item asserts the item exists, and it is
      // verified to exactly that.
      case 'plan-item': {
        const parsed = parsePlanItemRef(c.ref);
        if (!parsed || !probes.planItem) return { ...c, status: 'unknown' };
        const r = await probes.planItem(parsed.slug, parsed.itemId);
        if (!r) return { ...c, status: 'unknown' };
        if (!r.planExists) {
          return { ...c, status: 'unresolvable', note: `no plan '${parsed.slug}'` };
        }
        if (!r.itemExists) {
          return { ...c, status: 'unresolvable', note: `${parsed.slug} has no ${parsed.itemId}` };
        }
        return { ...c, status: 'holds' };
      }

      case 'fact': {
        const parsed = parseFactRef(c.ref);
        if (!parsed || !probes.fact) return { ...c, status: 'unknown' };
        const f = await probes.fact(parsed);
        if (!f) return { ...c, status: 'unknown' };
        if (!f.exists) {
          return { ...c, status: 'unresolvable', note: `no fact '${parsed.key}'` };
        }
        // The whole point of the `@v<N>` pin, finally load-bearing: an
        // unpinned fact ref can only ever say "this fact exists", which is why
        // an unpinned premise can never go stale no matter what happens to the
        // fact underneath it.
        if (parsed.version != null && f.supersededAt) {
          return {
            ...c,
            status: 'stale',
            note: `v${parsed.version} superseded ${f.supersededAt}`,
          };
        }
        return { ...c, status: 'holds' };
      }

      case 'peer-message': {
        const msgId = c.ref.slice('msg:'.length);
        if (!msgId || !probes.message) return { ...c, status: 'unknown' };
        const m = await probes.message(msgId);
        if (!m) return { ...c, status: 'unknown' };
        return m.exists
          ? { ...c, status: 'holds' }
          : { ...c, status: 'unresolvable', note: `no message ${msgId}` };
      }

      // An owner directive is invalidatable in principle but has no store to
      // probe from here; it stays `unknown` rather than being reported as a
      // dangling citation, which would be a false accusation.
      default:
        return { ...c, status: 'unknown' };
    }
  } catch {
    return { ...c, status: 'unknown' };
  }
}

/**
 * Resolve cited premise refs into send-time-verified stamps.
 *
 * De-duped and capped like `resolveGateRefStamps`; order follows first
 * appearance so a reader can line stamps up against the section that cited
 * them. Every probe runs in parallel and fail-softs independently.
 */
export async function resolvePremiseStamps(
  refs: readonly string[],
  probes: PremiseProbes = {},
): Promise<PremiseStamp[]> {
  const uniq = [...new Set(refs.map((r) => (r ?? '').trim()).filter(Boolean))].slice(
    0,
    PREMISE_STAMPS_MAX,
  );
  return Promise.all(uniq.map((ref) => resolveOne(classifyPremiseRef(ref), probes)));
}

/**
 * The stamps a reader should actually be shown. `holds` and `not-checkable`
 * are the quiet majority and carry no signal worth spending a line on; the
 * failures are the whole point.
 */
export function failingPremises(stamps: readonly PremiseStamp[]): PremiseStamp[] {
  return stamps.filter(
    (s) => s.status === 'broken' || s.status === 'stale' || s.status === 'unresolvable',
  );
}
