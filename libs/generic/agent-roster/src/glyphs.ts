/**
 * The agent-kind glyph vocabulary and the legend rows the roster prints above
 * its groups.
 *
 * The legend's DISPLAY WORDS are deliberately NOT stored here: a row carries a
 * `term` key that the host resolves through its own vocabulary (the operator
 * binds its lexicon; a host without one falls back to the literal). The legend
 * used to render the raw internal ids directly, which leaked the stale internal
 * vocabulary into the UI — resolving through the host is what stops that.
 */
import type { RosterAgent } from './types';

/** mug=☕ · kettle=🫖 · cup(worker)=🍵 · papercup=🥤.
 *
 *  Both generations of pane-kind id are listed: `agentPaneKind` may still arrive
 *  as the pre-rename wire word, so a mixed-generation roster renders identically. */
export const KIND_GLYPH: Record<string, string> = {
  queen: '☕',
  overwatch: '🫖',
  bee: '🍵',
  sentinel: '🥤',
  planner: '📋',
  su: '🛠',
  mug: '☕',
  kettle: '🫖',
  cup: '🍵',
  papercup: '🥤',
};

/** The vocabulary keys the legend asks its host to resolve. */
export type RosterTermKey = 'brain' | 'overwatch' | 'contributor' | 'operator';

export interface KindLegendRow {
  /** The internal id — glyph lookup + React key. Never displayed. */
  kind: string;
  /** The vocabulary key to resolve for the display word; null ⇒ use `literal`. */
  term: RosterTermKey | null;
  /** The display word for rows with no vocabulary key (they stay literal). */
  literal?: string;
}

/** The legend rows, in cast order. */
export const KIND_LEGEND: readonly KindLegendRow[] = [
  { kind: 'mug', term: 'brain' },
  { kind: 'kettle', term: 'overwatch' },
  { kind: 'cup', term: 'contributor' },
  { kind: 'papercup', term: 'operator' },
  { kind: 'planner', term: null, literal: 'planner' },
  { kind: 'su', term: null, literal: 'su' },
];

/** The kind glyph for an agent — from agentPaneKind when present, else role. Pure. */
export function agentGlyph(a: Pick<RosterAgent, 'agentPaneKind' | 'role'>): string {
  const kind = (a.agentPaneKind ?? a.role ?? '').toLowerCase();
  return KIND_GLYPH[kind] ?? '·';
}
