'use client';

/**
 * Disclosures — ONE component for the whole disclosure family
 * (popup-agent-state-coverage-2026-08-18 P-005).
 *
 * ## What it renders and why it is one component
 *
 * Six fields on the agent's own `coord:orient` payload say what its reads left
 * OUT: `factsWithheld`, `factsNarrowed`, `factEvictionDisclosures`,
 * `claimableTruncated`, `announcedGatesTruncated`, `recipesTruncated`. Each
 * exists because this codebase refuses to let a bounded read masquerade as a
 * total one — `claimableTruncated`'s own docblock states the shared rule:
 * *"absence is a positive statement that nothing was cut, which is what makes
 * the marker readable."*
 *
 * The popup dropped all six, which re-created on screen exactly the lie each was
 * built to prevent. One component rather than six call-sites because the failure
 * is a CLASS: six bespoke renders would drift, and the seventh marker somebody
 * adds later would get no render at all.
 *
 * ## The empty-section case is the load-bearing one
 *
 * A disclosure matters MOST where its section rendered empty. "Standing facts —
 * none in scope" is a lie when the fold ran narrowed: the agent was never shown
 * its facts, so their absence is not evidence none stand. `RailQuiet`'s own
 * contract makes the same distinction for `unavailable` ("I don't know must
 * never be quieter than nothing"); a narrowed fold is that third thing again —
 * *we did not fully look*. So this component is designed to sit beside the QUIET
 * render too, not only under a populated card, and the tests pin that.
 *
 * ## Absent ≠ clean
 *
 * `recorded === null` means NO RECORDING (the agent has not oriented since the
 * recording existed, or the read failed). It renders as NOTHING. It must never
 * render as "nothing was withheld" — that is the false clean this whole family
 * exists to prevent, and it would be the most dangerous state to get wrong
 * because it looks reassuring. `recorded.disclosures === {}` is the different,
 * positive statement that the last orient genuinely cut nothing; it also renders
 * as nothing, but for a reason the reader can be told on request.
 */

import type { ReactNode } from 'react';
import './Disclosures.css';

// ── Server DTO mirror (packages/operator-core/lib/agent-orient-disclosures.ts).
//    Inlined, not imported, so this client module never pulls the PG-backed
//    server module into the SPA bundle — same rationale as use-agent-orders.ts.
//    Every field OPTIONAL: the SPA rebuilds on the vite hot path while the
//    sidecar only reloads on restart, so a bundle that knows a field is
//    routinely served payloads that predate it.

export interface OrientDisclosures {
  factsWithheld?: { count?: number; reason?: string };
  factsNarrowed?: { fold?: string; prefixes?: string[]; reason?: string };
  factEvictionDisclosures?: Array<{
    scope?: string;
    scopeRef?: string | null;
    recentEvictedCount?: number;
    latestEvictedAt?: string;
    meaning?: string;
  }>;
  claimableTruncated?: {
    shown?: number;
    total?: number;
    totalScope?: string;
    limit?: number;
    truncatedByLimit?: boolean;
    more?: string;
  };
  announcedGatesTruncated?: { shown?: number; total?: number; more?: string };
  recipesTruncated?: {
    shown?: number;
    truncatedByLimit?: boolean;
    limit?: number;
    titlesClipped?: number;
    titleCap?: number;
    more?: string;
  };
}

export interface RecordedOrientDisclosures {
  disclosures?: OrientDisclosures;
  /** When the recording was made. Rendered, never hidden: markers from an orient
   *  six hours ago describe THAT call, not the session now. */
  at?: string;
}

export type OrientDisclosureKey = keyof OrientDisclosures;

/** The three markers that qualify the FACTS section. */
export const FACTS_DISCLOSURE_KEYS: readonly OrientDisclosureKey[] = [
  'factsWithheld',
  'factsNarrowed',
  'factEvictionDisclosures',
];

/** The three that qualify the agent's other bounded orient reads. */
export const READ_DISCLOSURE_KEYS: readonly OrientDisclosureKey[] = [
  'claimableTruncated',
  'announcedGatesTruncated',
  'recipesTruncated',
];

/** One rendered marker: what was cut, and how to get the rest. */
interface Line {
  key: OrientDisclosureKey;
  /** The short claim. Always states that something was left out. */
  text: string;
  /** The verb that returns the rest, when the producer named one. A marker
   *  without this is half a disclosure, so it is rendered whenever present. */
  more?: string;
}

/** Render one marker to a line. PURE → unit-tested.
 *
 *  Returns null for a marker that is absent, which is how absence stays a
 *  positive statement rather than becoming an empty row. */
export function disclosureLine(
  key: OrientDisclosureKey,
  d: OrientDisclosures | undefined,
): Line | null {
  if (!d) return null;
  switch (key) {
    case 'factsWithheld': {
      const v = d.factsWithheld;
      if (!v) return null;
      const n = v.count;
      return {
        key,
        text:
          typeof n === 'number'
            ? `${n} steering fact${n === 1 ? '' : 's'} withheld from this agent${v.reason ? ` — ${v.reason}` : ''}`
            : `steering facts withheld from this agent${v.reason ? ` — ${v.reason}` : ''}`,
      };
    }
    case 'factsNarrowed': {
      const v = d.factsNarrowed;
      if (!v) return null;
      const slots = (v.prefixes ?? []).join(' + ');
      return {
        key,
        // Deliberately says what the agent CANNOT conclude, not just what ran.
        // The reader's mistake to prevent is treating an empty facts list as
        // evidence that no facts stand.
        text: `facts fold ran NARROWED${slots ? ` to ${slots}` : ''} — the list below is not a census, and its gaps are not evidence`,
      };
    }
    case 'factEvictionDisclosures': {
      const rows = d.factEvictionDisclosures ?? [];
      if (rows.length === 0) return null;
      const total = rows.reduce((sum, r) => sum + (r.recentEvictedCount ?? 0), 0);
      const scopes = rows.map((r) => r.scope).filter(Boolean).join(', ');
      return {
        key,
        text: `${total} fact${total === 1 ? '' : 's'} cap-evicted recently${scopes ? ` (${scopes})` : ''} — a fact you expect may have been evicted, not never-asserted`,
      };
    }
    case 'claimableTruncated': {
      const v = d.claimableTruncated;
      if (!v) return null;
      return {
        key,
        text:
          typeof v.total === 'number'
            ? `claimable list cut: showed ${v.shown ?? '?'} of ${v.total}${v.totalScope ? ` ${v.totalScope}` : ''}`
            : `claimable list cut at the row cap${typeof v.limit === 'number' ? ` (${v.limit})` : ''} — the population is unknown`,
        more: v.more,
      };
    }
    case 'announcedGatesTruncated': {
      const v = d.announcedGatesTruncated;
      if (!v) return null;
      return {
        key,
        // Load-bearing rather than cosmetic: an undisclosed drop here means the
        // agent never learned a gate key exists, so it parks on the wrong event.
        text: `gates cut: showed ${v.shown ?? '?'} of ${v.total ?? '?'} — this agent was never told the rest exist`,
        more: v.more,
      };
    }
    case 'recipesTruncated': {
      const v = d.recipesTruncated;
      if (!v) return null;
      const clipped = v.titlesClipped;
      return {
        key,
        text: `recipes cut at the search limit${typeof v.limit === 'number' ? ` (${v.limit})` : ''}${clipped ? `, ${clipped} title${clipped === 1 ? '' : 's'} clipped` : ''}`,
        more: v.more,
      };
    }
    default:
      return null;
  }
}

/** Every line this recording has to show for the given keys. PURE → unit-tested. */
export function disclosureLines(
  recorded: RecordedOrientDisclosures | null | undefined,
  keys: readonly OrientDisclosureKey[],
): Line[] {
  // `null` is NO RECORDING and yields nothing — never a reassuring clean line.
  if (!recorded) return [];
  const out: Line[] = [];
  for (const key of keys) {
    const line = disclosureLine(key, recorded.disclosures);
    if (line) out.push(line);
  }
  return out;
}

export interface DisclosuresProps {
  /** The agent's recorded markers. `null`/absent ⇒ renders NOTHING. */
  recorded: RecordedOrientDisclosures | null | undefined;
  /** Which markers belong to the section this instance sits under. */
  keys: readonly OrientDisclosureKey[];
  /** Test hook; defaults off the first key so two instances never collide. */
  testId?: string;
}

/**
 * The quiet disclosures line(s) for one section.
 *
 * Renders `null` when there is nothing to disclose — which is the same visual
 * result for "no recording" and "recorded nothing", and deliberately so: neither
 * one may print a line that a reader could take as a guarantee.
 */
export function Disclosures({ recorded, keys, testId }: DisclosuresProps): ReactNode {
  const lines = disclosureLines(recorded, keys);
  if (lines.length === 0) return null;
  return (
    <div
      className="pc-disclosures"
      data-testid={testId ?? `disclosures-${String(keys[0] ?? 'none')}`}
      /* Not an alert: these qualify a reading, they do not demand action. But
         they must survive a collapsed section, so they sit OUTSIDE the section
         body — see the call sites. */
    >
      {lines.map((line) => (
        <p className="pc-disclosures__line" key={line.key} data-marker={line.key}>
          <span className="pc-disclosures__glyph" aria-hidden="true">
            ⊘
          </span>
          <span className="pc-disclosures__txt">
            {line.text}
            {line.more ? <span className="pc-disclosures__more">{line.more}</span> : null}
          </span>
        </p>
      ))}
    </div>
  );
}
