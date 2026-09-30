/**
 * Linear-inspired design tokens for the harness dashboard.
 * Dense, low-chrome, keyboard-first.
 */

import type { ListingKind } from '@papercusp/operator-core/lib/cupboard/types';

export const COLORS = {
  bg: 'var(--pot-harness-bg, #0b0e14)',
  surface: 'var(--pot-harness-surface, #0f1420)',
  surfaceRaised: 'var(--pot-harness-surface-raised, #111827)',
  surfaceHover: 'var(--pot-harness-surface-hover, #1a2332)',
  border: 'var(--pot-harness-border, #1f2937)',
  borderStrong: 'var(--pot-harness-border-strong, #374151)',
  borderSubtle: 'var(--pot-harness-border-subtle, #161b26)',

  text: 'var(--pot-harness-text, #e5e7eb)',
  textMuted: 'var(--pot-harness-text-muted, #9ca3af)',
  textDim: 'var(--pot-harness-text-dim, #6b7280)',
  textFaint: 'var(--pot-harness-text-faint, #4b5563)',

  accent: 'var(--pot-harness-accent, #5e6ad2)',
  accentHover: 'var(--pot-harness-accent-hover, #7178d8)',

  // Solid filled-button tones: the semantic status hue pulled toward the page's
  // deepest bg so white button text keeps contrast in every theme (P-006c —
  // frost renders ≈ the old red-900/emerald-900 literals these replace).
  danger: 'color-mix(in srgb, var(--bad, #fb7185), var(--bg-deepest, #02060C) 55%)',
  dangerBg: 'var(--bad-bg, rgba(251, 113, 133, 0.1))',
  dangerText: 'var(--bad, #fca5a5)',
  success: 'color-mix(in srgb, var(--good, #34d399), var(--bg-deepest, #02060C) 55%)',
  successBg: 'var(--good-bg, rgba(52, 211, 153, 0.1))',
  successText: 'var(--good, #a7f3d0)',
} as const;

// Status palette — dot uses COLOR_SOLID, pill bg uses COLOR_BG for subtler look.
// Wrapped in a Proxy that returns a neutral fallback for any status not in the
// coding-harness state machine (e.g. parent-harness `proposed`, `approved`).
// Without this, `STATUS[unknownStatus].label` crashes the entire FeatureList
// subtree at hydration when a parent harness's features are loaded — see
// `getStatusMeta()` below for the canonical config-aware lookup.
// work-item-status-full-unify (2026-07-19): the feature + issue families now share ONE
// lifecycle — open → wip → blocked | needs-human → done | dropped. This is the single
// source for work-item status coloring; the UNIFIED tokens lead. The legacy per-family
// spellings (todo/in_progress/validating/failing/passed/deprecated) are KEPT as tolerant
// aliases so a residual pre-backfill row or a federated peer still on the old vocab renders
// correctly instead of falling through to the grey "Unknown" fallback (234 features still at
// 'passed', 2 at 'deprecated' at cutover; more may arrive over the wire). Narrow to the
// unified set only once the federation cutover + cleanup pass lands.
const _STATUS_TABLE = {
  // ── Unified lifecycle (leads) ──
  open:        { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)',  text: '#d1d5db', label: 'Open' },
  wip:         { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)',   text: '#93c5fd', label: 'WIP' },
  blocked:     { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',   text: '#fcd34d', label: 'Blocked' },
  'needs-human': { solid: '#f97316', bg: 'rgba(249,115,22,0.15)', text: '#fdba74', label: 'Needs human' },
  done:        { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',   text: '#6ee7b7', label: 'Done' },
  dropped:     { solid: '#52525b', bg: 'rgba(82,82,91,0.18)',     text: '#a1a1aa', label: 'Dropped' },
  // ── Legacy per-family spellings (tolerant aliases; see note above) ──
  todo:        { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)',  text: '#d1d5db', label: 'Open' },
  in_progress: { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)',   text: '#93c5fd', label: 'WIP' },
  validating:  { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',   text: '#d8b4fe', label: 'Validating' },
  failing:     { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',    text: '#fca5a5', label: 'Failing' },
  passed:      { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',   text: '#6ee7b7', label: 'Passed' },
  deprecated:  { solid: '#52525b', bg: 'rgba(82,82,91,0.18)',     text: '#a1a1aa', label: 'Deprecated' },
  resolved:    { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',   text: '#6ee7b7', label: 'Resolved' },
  closed:      { solid: '#52525b', bg: 'rgba(82,82,91,0.18)',     text: '#a1a1aa', label: 'Closed' },
} as const;

const _STATUS_FALLBACK = { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown' } as const;

export const STATUS = new Proxy(_STATUS_TABLE as Record<string, { solid: string; bg: string; text: string; label: string }>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_FALLBACK;
  },
}) as typeof _STATUS_TABLE;

export type HarnessStatus = keyof typeof _STATUS_TABLE;

// Fixed categorical swatches — the single source for hues whose meaning is
// identity/category rather than semantic state. Unlike TONE below, these do
// not follow the active theme: a Conversations handoff, an /adv tab, and a
// Learning rail keep the same distinguishing hue across themes. Keep the hex
// and RGB representations paired so the two forms cannot drift independently.
export const CATEGORICAL = {
  indigo400:  { hex: '#818cf8', rgb: '129, 140, 248' },
  amber500:   { hex: '#f59e0b', rgb: '245, 158, 11' },
  teal400:    { hex: '#2dd4bf', rgb: '45, 212, 191' },
  violet400:  { hex: '#a78bfa', rgb: '167, 139, 250' },
  rose500:    { hex: '#f43f5e', rgb: '244, 63, 94' },
  green500:   { hex: '#22c55e', rgb: '34, 197, 94' },
  lime500:    { hex: '#84cc16', rgb: '132, 204, 22' },
  blue400:    { hex: '#60a5fa', rgb: '96, 165, 250' },
  teal500:    { hex: '#14b8a6', rgb: '20, 184, 166' },
  pink500:    { hex: '#ec4899', rgb: '236, 72, 153' },
  emerald400: { hex: '#34d399', rgb: '52, 211, 153' },
  yellow500:  { hex: '#eab308', rgb: '234, 179, 8' },
  orange500:  { hex: '#f97316', rgb: '249, 115, 22' },
  violet300:  { hex: '#c4b5fd', rgb: '196, 181, 253' },
  pink400:    { hex: '#f472b6', rgb: '244, 114, 182' },
  red400:     { hex: '#f87171', rgb: '248, 113, 113' },
  slate500:   { hex: '#64748b', rgb: '100, 116, 139' },
  slate400:   { hex: '#94a3b8', rgb: '148, 163, 184' },
  teal300:    { hex: '#5eead4', rgb: '94, 234, 212' },
} as const;

export type CategoricalKey = keyof typeof CATEGORICAL;

// Ordering used for list sort.
// Active work first, terminal states last. `deprecated` is a soft-retired
// state — sorts to the very end so it doesn't crowd active work.
export const STATUS_ORDER: HarnessStatus[] = [
  'in_progress', 'validating', 'failing', 'todo', 'blocked', 'passed', 'deprecated',
];

// Ordering used for board column layout (left → right).
// Read like a workflow: queue → in motion → blocked → done.
export const BOARD_COLUMN_ORDER: HarnessStatus[] = [
  'todo', 'in_progress', 'validating', 'failing', 'blocked', 'passed', 'deprecated',
];

// ─── Issue severity + status palettes ──────────────────────────────
//
// Issues carry their own `severity` (critical|major|minor|nit) and
// `status` (open|acknowledged|fixing|closed|wontfix) axes — distinct from
// the feature STATUS machine above. These are the SINGLE source for issue
// coloring; the /adv Issues panel + Detail pane read them via the
// <SeverityPill> / issue-status helpers in primitives.tsx instead of
// re-declaring local tone maps. Hues align to the bluefrost semantic
// family (red → amber → accent → grey) so issues stay on-theme; `minor` uses
// the accent token rather than the legacy yellow.
//
// Same Proxy fallback as STATUS — an unknown severity/status returns a
// neutral grey rather than crashing the row subtree at render.

const _SEVERITY_TABLE = {
  critical: { solid: '#ef4444', bg: 'rgba(239,68,68,0.16)',   text: '#fca5a5', label: 'Critical' },
  major:    { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Major' },
  minor:    { solid: 'var(--accent)', bg: 'color-mix(in oklab, var(--accent), transparent 86%)',  text: 'var(--accent-strong, var(--accent))', label: 'Minor' },
  nit:      { solid: '#94a3b8', bg: 'rgba(148,163,184,0.14)', text: '#cbd5e1', label: 'Nit' },
} as const;

const _STATUS_META_FALLBACK = { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown' } as const;

export const SEVERITY = new Proxy(_SEVERITY_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _SEVERITY_TABLE;

export type IssueSeverityKey = keyof typeof _SEVERITY_TABLE;

// Severity ordering, most-urgent first — used to sort the Issues list.
export const SEVERITY_ORDER: IssueSeverityKey[] = ['critical', 'major', 'minor', 'nit'];

const _ISSUE_STATUS_TABLE = {
  open:         { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',  text: '#fca5a5', label: 'Open' },
  acknowledged: { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)', text: '#fcd34d', label: 'Acknowledged' },
  fixing:       { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)', text: '#d8b4fe', label: 'Fixing' },
  // `resolved` = fixed (the work_items issue-family state between fixing and
  // closed) — emerald family like closed, lighter so the two read as
  // related-but-distinct.
  resolved:     { solid: '#34d399', bg: 'rgba(52,211,153,0.15)', text: '#a7f3d0', label: 'Resolved' },
  closed:       { solid: '#10b981', bg: 'rgba(16,185,129,0.15)', text: '#6ee7b7', label: 'Closed' },
  wontfix:      { solid: '#52525b', bg: 'rgba(82,82,91,0.18)',   text: '#a1a1aa', label: 'Won’t fix' },
} as const;

export const ISSUE_STATUS = new Proxy(_ISSUE_STATUS_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _ISSUE_STATUS_TABLE;

export type IssueStatusKey = keyof typeof _ISSUE_STATUS_TABLE;

// Unified work_items `kind` coloring — feature-family {feature, chunk} +
// issue-family {bug, change, task} (unify-work-items D-001). The
// SINGLE source for kind chips (<KindPill> in primitives.tsx), same hue
// discipline + Proxy fallback as SEVERITY / ISSUE_STATUS above so the
// Work-items table's pill columns speak one visual language.
const _WORK_ITEM_KIND_TABLE = {
  feature:         { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)',  text: '#93c5fd', label: 'Feature' },
  chunk:           { solid: '#14b8a6', bg: 'rgba(20,184,166,0.15)',  text: '#5eead4', label: 'Chunk' },
  bug:             { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',   text: '#fca5a5', label: 'Bug' },
  change:          { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Change' },
  task:            { solid: '#94a3b8', bg: 'rgba(148,163,184,0.14)', text: '#cbd5e1', label: 'Task' },
  // Owner ask 2026-07-19: bet + research-task are real wire kinds (work-items.ts)
  // that previously fell through to the neutral fallback — own hue + label so
  // every KindPill surface (Overview stats, Work items table, Detail) shows them.
  bet:             { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',  text: '#d8b4fe', label: 'Bet' },
  'research-task': { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',  text: '#6ee7b7', label: 'Research' },
} as const;

export const WORK_ITEM_KIND = new Proxy(_WORK_ITEM_KIND_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _WORK_ITEM_KIND_TABLE;

export type WorkItemKindKey = keyof typeof _WORK_ITEM_KIND_TABLE;

// Agent pane-kind coloring — the colony vocabulary {queen, bee, sentinel,
// planner, su} (apps/tui agent_pane_kind.rs). The SINGLE source for agent-kind
// chips (<AgentKindPill> in primitives.tsx), same hue discipline + Proxy
// fallback as WORK_ITEM_KIND so the Agents table's pill columns speak the same
// visual language as Work items.
const _AGENT_KIND_TABLE = {
  // Historical keys remain valid wire values; fallback labels use the public
  // vocabulary so a missed caller cannot leak the retired cast.
  queen:    { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Mug' },
  bee:      { solid: 'var(--accent)', bg: 'color-mix(in oklab, var(--accent), transparent 86%)',  text: 'var(--accent-strong, var(--accent))', label: 'Cup' },
  sentinel: { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',  text: '#6ee7b7', label: 'Papercup' },
  planner:  { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',  text: '#d8b4fe', label: 'Planner' },
  su:       { solid: '#ec4899', bg: 'rgba(236,72,153,0.15)',  text: '#f9a8d4', label: 'SU' },
  // overwatch-role-2026-06-15 B-01: the autonomous system-health supervisor (a sibling to
  // the Queen). Indigo — distinct from the queen's amber so the roster separates them.
  overwatch: { solid: '#6366f1', bg: 'rgba(99,102,241,0.15)',  text: '#a5b4fc', label: 'Kettle' },
  // Renamed agent kinds (WI-2932 pot-rename) — same hues as their pre-rename
  // twins so mixed-generation rows read as one roster during the expand phase.
  // (AgentKindPill pack-routes the LABEL via AGENT_KIND_TERM; these labels are
  // the no-lexicon fallback.)
  mug:      { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  text: '#fcd34d', label: 'Mug' },
  cup:      { solid: 'var(--accent)', bg: 'color-mix(in oklab, var(--accent), transparent 86%)',  text: 'var(--accent-strong, var(--accent))', label: 'Cup' },
  papercup: { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',  text: '#6ee7b7', label: 'Papercup' },
  kettle:   { solid: '#6366f1', bg: 'rgba(99,102,241,0.15)',  text: '#a5b4fc', label: 'Kettle' },
} as const;

export const AGENT_KIND = new Proxy(_AGENT_KIND_TABLE as Record<string, StatusMeta>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_META_FALLBACK;
  },
}) as typeof _AGENT_KIND_TABLE;

export type AgentKindKey = keyof typeof _AGENT_KIND_TABLE;

// ─── One-color status tones (design-simplification P-005) ──────────
//
// SINGLE source for panels that color a status STRING with one color (text /
// swatch / chip border) rather than the full StatusMeta pill set above. Keys
// span the app's one-color status vocabularies — VAL assertions (Tests tab
// AcceptancePanel), DBOS workflow states (/admin/dbos), gym proposal states
// (/adv Learning tab). Extend THIS table for a new vocabulary; a
// component-local STATUS_*/…_COLOR map is what the status-map lint
// (design-primitives.test.ts) warns on.

export const TONE = {
  good: 'var(--good)',
  warn: 'var(--warn)',
  bad: 'var(--bad)',
  accent: 'var(--accent)',
  neutral: 'var(--fg-mute)',
  fg: 'var(--fg)',
} as const;
export type ToneKey = keyof typeof TONE;

const _STATUS_TONE_TABLE: Record<string, ToneKey> = {
  // VAL assertions (harness Tests tab AcceptancePanel)
  passed: 'good', failed: 'bad', validating: 'accent', todo: 'neutral',
  // DBOS workflow states (/admin/dbos) — MAX_RECOVERY* variants match in statusToneColor()
  SUCCESS: 'good', ERROR: 'bad', PENDING: 'warn', ENQUEUED: 'warn', CANCELLED: 'neutral',
  // Gym proposal states (/adv Learning tab)
  accepted: 'good', pending: 'warn', rejected: 'bad', superseded: 'neutral',
  // Structured-stream step states (StructuredStreamView) — `failed` shared above
  ok: 'good', running: 'accent', info: 'neutral',
};

/** One-color status → CSS color. `fallback` names the tone for unknown statuses. */
export function statusToneColor(status: string, fallback: ToneKey = 'neutral'): string {
  const tone = _STATUS_TONE_TABLE[status];
  if (tone) return TONE[tone];
  if (status.includes('MAX_RECOVERY')) return TONE.bad; // DBOS retry-exhausted variants
  return TONE[fallback];
}

// Issue severity → chip ToneKey (design-simplification P-005). Distinct from
// the SEVERITY StatusMeta table above (which drives the full-style
// <SeverityPill>): this feeds semantic <HudBadge> chips, which key a CSS
// class off the tone NAME rather than a raw color value. Extend HERE for a
// new severity-driven chip surface instead of a component-local map — that
// is exactly what the status-map lint (design-primitives.test.ts) blocks.
export const SEVERITY_TONE: Record<IssueSeverityKey, ToneKey> = {
  critical: 'bad',
  major: 'warn',
  minor: 'neutral',
  nit: 'neutral',
};

// Coordination-feed kinds are categorical identities, even when a semantic
// token is the right source for a particular kind.
export const FEED_KIND_COLOR: Record<string, string> = {
  message: 'var(--accent-strong, #7dd3fc)',
  ack: 'var(--fg-mute, #7f9bb4)',
  notify: 'var(--warn, #fbbf24)',
  broadcast: CATEGORICAL.pink400.hex,
  handoff: CATEGORICAL.violet400.hex,
  handoff_accepted: CATEGORICAL.violet300.hex,
  escalation: 'var(--bad, #f87171)',
  escalation_resolved: 'var(--good, #86efac)',
  plan_event: CATEGORICAL.teal300.hex,
  subscribe: 'var(--accent, #38bdf8)',
  unsubscribe: `var(--fg-mute, ${CATEGORICAL.slate500.hex})`,
  contract: 'var(--warn, #fcd34d)',
};
export const FEED_KIND_FALLBACK = CATEGORICAL.slate500.hex;

export interface CategoryTone {
  fg: string;
  bg: string;
  border: string;
}

// Cupboard listing kinds use a three-part categorical treatment. This belongs
// beside the other central kind tables rather than inside the storefront.
export const CUPBOARD_LISTING_KIND_TONE: Record<ListingKind, CategoryTone> = {
  harness: { fg: 'var(--accent-soft)', bg: 'color-mix(in srgb, var(--accent), transparent 86%)', border: 'color-mix(in srgb, var(--accent-strong), transparent 74%)' },
  blueprint: { fg: 'var(--good)', bg: 'color-mix(in srgb, var(--good), transparent 86%)', border: 'color-mix(in srgb, var(--good), transparent 74%)' },
  plugin: { fg: 'var(--accent-soft)', bg: 'color-mix(in srgb, var(--accent), transparent 86%)', border: 'color-mix(in srgb, var(--accent-strong), transparent 74%)' },
  // pack: the runtime-less code-tool pack (canonical 'pack' — migration 010
  // renamed the interim 'tool-pack', cupboard-public-release-2026-07-12 P-003).
  pack: { fg: 'var(--accent-cool)', bg: 'color-mix(in srgb, var(--accent-deep), transparent 87%)', border: 'color-mix(in srgb, var(--accent-cool), transparent 76%)' },
  'knowledge-pack': { fg: 'var(--warn)', bg: 'color-mix(in srgb, var(--warn), transparent 88%)', border: 'color-mix(in srgb, var(--warn), transparent 76%)' },
  // app/aspect templates (app-templates-2026-07-04) — a distinct rose hue so a
  // Templates card reads apart from blueprint (good/green) + pack (accent-cool).
  // (pack tone above; template rose below.)
  // Without this entry KindBadge/ListingCard crash on `tone.fg` for a template
  // row (cupboard-public-release-2026-07-12 P-002).
  template: { fg: 'var(--rose-400)', bg: 'color-mix(in srgb, var(--rose-400), transparent 86%)', border: 'color-mix(in srgb, var(--rose-400), transparent 74%)' },
  // app: a whole distributable application (cupboard-app-distribution-2026-07-14).
  // A gold hue reads as a premium "whole product" — distinct from blueprint
  // (good/green), pack (accent-cool), knowledge-pack (warn), template (rose).
  // Without this entry KindBadge/ListingCard crash on `tone.fg` for an app row.
  app: { fg: 'var(--gold-400)', bg: 'color-mix(in srgb, var(--gold-400), transparent 86%)', border: 'color-mix(in srgb, var(--gold-400), transparent 74%)' },
  // Judgment/procedure kinds (cupboard-plan-rubric-recipe-sharing-2026-08-21).
  // These use the fixed categorical palette because kind is identity, not state.
  rubric: {
    fg: CATEGORICAL.violet400.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.violet400.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.violet400.hex}, transparent 74%)`,
  },
  plan: {
    fg: CATEGORICAL.teal400.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.teal400.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.teal400.hex}, transparent 74%)`,
  },
  recipe: {
    fg: CATEGORICAL.orange500.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.orange500.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.orange500.hex}, transparent 74%)`,
  },
  theme: {
    fg: CATEGORICAL.pink400.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.pink400.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.pink400.hex}, transparent 74%)`,
  },
  goal: {
    fg: CATEGORICAL.blue400.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.blue400.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.blue400.hex}, transparent 74%)`,
  },
  // datatype: a shared row/column shape (cupboard-datatype-sharing, P-027).
  // Indigo reads as structural/schema and is the nearest free hue — violet is
  // rubric, blue is goal.
  datatype: {
    fg: CATEGORICAL.indigo400.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.indigo400.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.indigo400.hex}, transparent 74%)`,
  },
  // rule: an installable "when X, fire Y" behaviour (identities-v1 D-011, P-028).
  // Lime is the last clearly-saturated free hue — emerald is blueprint, amber is
  // knowledge-pack, gold is app. NOTE for kind #15: this map is now hue-saturated;
  // the next kind needs a second visual channel (shape/icon), not another near-duplicate.
  rule: {
    fg: CATEGORICAL.lime500.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.lime500.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.lime500.hex}, transparent 74%)`,
  },
  // event: an installable event declaration (kind #15). ⚠ This IS the collision
  // the `rule` note above predicted: orange500 is the last unclaimed CATEGORICAL
  // hue, but it is a warm near-duplicate of knowledge-pack (warn/amber) and app
  // (gold), so an Events card will NOT read distinctly from those two on hue
  // alone. Added at this value only to keep Record<ListingKind> exhaustive and
  // unblock the release gate — it is NOT a design verdict. The real fix is the
  // second visual channel (per-kind icon/shape) the `rule` note names; tracked
  // as a follow-up off WI-10001702. Do not add kind #16 to this map without it.
  event: {
    fg: CATEGORICAL.orange500.hex,
    bg: `color-mix(in srgb, ${CATEGORICAL.orange500.hex}, transparent 86%)`,
    border: `color-mix(in srgb, ${CATEGORICAL.orange500.hex}, transparent 74%)`,
  },
};

// Memory-kind chip hues (settings/user/memory). Categorical, not status —
// kinds are backend-defined and style-only (never a filter source; the
// taxonomy changed once already, memory-settings-page-refresh D-001).
// Unknown kinds get MEMORY_KIND_FALLBACK grey.
export const MEMORY_KIND_COLOR: Record<string, string> = {
  // Claude-file / hybrid taxonomy (the live store)
  user: '#a78bfa', feedback: '#34d399', reference: '#60a5fa', project: '#fbbf24',
  // Legacy mem0 taxonomy (older rows)
  identity: '#a78bfa', preference: '#34d399', correction: '#f87171', ephemeral: '#9ca3af',
};
export const MEMORY_KIND_FALLBACK = '#6b7280';

// Turn-end-reflection observation kinds (create:observations browse pane,
// turn-end-reflection-observations-2026-06-14 P-043). Categorical, not
// status — kinds are a fixed sensor-reading vocabulary, style-only.
export const OBSERVATION_KIND_COLOR: Record<string, string> = {
  friction: '#fb7185',
  workaround: '#fbbf24',
  gap: CATEGORICAL.blue400.hex,
  surprise: '#a78bfa',
  reinforce: '#34d399',
};

// Hyperbee boot-history event-kind hues (admin/dogfood-substrate →
// insights/BootHistoryTable). Categorical over the BootHistoryKind union
// (operator-core lib/sync/hyperbee/boot-history) — keyed as strings here so
// theme.ts stays free of domain-type imports; unknown/new kinds fall back to
// BOOT_HISTORY_KIND_FALLBACK.
export const BOOT_HISTORY_KIND_COLOR: Record<string, string> = {
  boot_start: 'var(--fg-dim)',
  boot_ok: 'var(--good)',
  boot_fail: 'var(--bad)',
  close: 'var(--fg-dim)',
  peer_connected: 'var(--accent)',
  join_started: 'var(--fg-dim)',
  join_succeeded: 'var(--good)',
  swarm_join_failed: 'var(--warn)',
  peer_rejected: 'var(--warn)',
  peer_rate_limited: 'var(--bad)',
  peer_cap_near: 'var(--warn)',
  // WI-6063: a deliberate, self-releasing bound rather than a fault — warn, not bad.
  peer_dial_throttled: 'var(--warn)',
  peer_capped: 'var(--warn)',
  // P-005: routine own-log compaction; a failure names itself in the message.
  own_log_compaction: 'var(--accent)',
  peer_revoked: 'var(--bad)',
  peer_unrevoked: 'var(--good)',
  replication_stalled: 'var(--bad)',
  replication_frozen: 'var(--bad)',
  announce_admitted: 'var(--good)',
  announce_pending: 'var(--warn)',
  announce_rejected: 'var(--warn)',
  // WI-2039866: a REMOTE op the owner-policy seam dropped — a drop is a warning
  // (the op was refused by policy), not a fault of this host.
  policy_drop: 'var(--warn)',
  announce_clock_skew: 'var(--warn)',
  announce_error: 'var(--bad)',
  merge_error: 'var(--bad)',
  merge_stalled: 'var(--bad)',
  merge_stall_cleared: 'var(--good)',
  announce_admission_stalled: 'var(--bad)',
  rekey_grant_failed: 'var(--bad)',
  rekey_grant_skipped: 'var(--warn)',
  rekey_boundary_skipped: 'var(--warn)',
  rekey_boundary_applied: 'var(--good)',
  epoch_gate_built: 'var(--accent)',
  epoch_boot_device: 'var(--accent)',
  epoch_gate_skipped: 'var(--warn)',
  epoch_gate_seen: 'var(--accent)',
  epoch_defer: 'var(--warn)',
  epoch_decrypt_fail: 'var(--bad)',
  epoch_applied: 'var(--good)',
  // WI-3604: split-DHT-universe recurrence guard.
  dht_universe_ok: 'var(--good)',
  dht_universe_mismatch: 'var(--bad)',
  // WI-3684: repair-on-detect re-attach outcome.
  replication_repair: 'var(--good)',
  replication_repair_failed: 'var(--bad)',
  replication_repair_exhausted: 'var(--bad)',
  replication_repair_rejoin_failed: 'var(--bad)',
  replication_repair_confirmation_failed: 'var(--warn)',
  // EI-18723690188615364: the recovery + bounded-deferral outcomes of the same
  // window. `confirmed` is the only good one — a deferral means STILL BROKEN.
  replication_repair_confirmed: 'var(--good)',
  replication_repair_confirmation_deferred: 'var(--warn)',
  replication_repair_confirmation_abandoned: 'var(--bad)',
};
export const BOOT_HISTORY_KIND_FALLBACK = 'var(--fg-dim)';

/**
 * Canonical role color/label overrides. Roles not listed here get a
 * stable color derived from their name (see getRoleStyle below) — adding
 * a new role file under libs/papercusp/packages/harness/prompts/ gives
 * it a distinct UI color without a code edit.
 *
 * Use getRoleStyle(role) instead of ROLE[role] directly. The legacy
 * ROLE export is kept for the small handful of call sites that index
 * statically (e.g. ROLE.unknown for the fallback grey).
 */
export const ROLE = {
  planner:      { solid: '#a855f7', label: 'Planner' },
  orchestrator: { solid: '#ec4899', label: 'Orchestrator' },
  worker:       { solid: '#3b82f6', label: 'Worker' },
  validator:    { solid: '#10b981', label: 'Validator' },
  escalator:    { solid: '#f59e0b', label: 'Escalator' },
  unknown:      { solid: '#6b7280', label: 'Unknown' },
} as const;

export type RoleKey = keyof typeof ROLE;

/**
 * Stable hash for deriving a hue from a role name. djb2 — small, fast,
 * adequate distribution for ~50 distinct strings (which is all we'll
 * ever have here). Returns a value in [0, 2^32).
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0; // unsigned
}

/**
 * Title-case a role name. Splits on dashes/underscores so 'infra-reviewer'
 * → 'Infra Reviewer' and 'project_manager' → 'Project Manager'.
 */
function titleCase(s: string): string {
  return s
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve a role to its color + label. Falls back to a hash-derived HSL
 * color for roles not in the canonical ROLE map. Use this everywhere
 * agent role colors are looked up — including for roles loaded at runtime
 * from the prompts/ directory (getKnownRoles).
 */
export function getRoleStyle(role: string | null | undefined): { solid: string; label: string } {
  const key = (role ?? '').toLowerCase();
  if (!key) return ROLE.unknown;
  if (key in ROLE) return ROLE[key as RoleKey];
  // Stable hash-derived hue. 65% sat / 55% light gives consistent
  // perceived brightness across the wheel and stays distinguishable
  // from the 5 canonical role colors.
  const hue = djb2(key) % 360;
  return { solid: `hsl(${hue} 65% 55%)`, label: titleCase(key) };
}

export const FONTS = {
  ui: 'system-ui, -apple-system, "Inter", sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "Menlo", monospace',
} as const;

export const SIZES = {
  xs: '0.7rem',
  sm: '0.75rem',
  base: '0.8rem',
  md: '0.85rem',
  lg: '0.95rem',
  xl: '1.1rem',
} as const;

export const RADIUS = {
  sm: 3,
  md: 4,
  lg: 6,
} as const;

// ─── Config-aware helpers (harness-of-harnesses Layer 1-A) ──────────
//
// The legacy STATUS / STATUS_ORDER / BOARD_COLUMN_ORDER consts above hard-code
// the coding-harness state machine. Parent harnesses (e.g. restart-org) and
// future harness types declare their own itemStates in .papercusp/config.json.
//
// These helpers read from a HarnessConfig if provided, falling back to the
// coding-harness defaults so legacy callers behave identically.
//
// Migration policy: existing components keep using the literal consts; new
// components for non-coding harnesses (parent, department, etc.) use these
// helpers.

export interface StatusMeta {
  solid: string;
  bg: string;
  text: string;
  label: string;
}

export interface HarnessConfig {
  itemStates?: string[];
  terminalStates?: string[];
  successState?: string;
  boardColumnOrder?: string[];
  statusOrder?: string[];
  statusColors?: Record<string, Partial<StatusMeta>>;
  savedViews?: Array<{ id: string; name: string; filter: { statuses: string[] } }>;
}

const DEFAULT_STATUS_COLORS: Record<string, StatusMeta> = {
  proposed:    { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#d1d5db', label: 'Proposed' },
  approved:    { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)', text: '#d8b4fe', label: 'Approved' },
  in_progress: { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)', text: '#93c5fd', label: 'In progress' },
  launched:    { solid: '#10b981', bg: 'rgba(16,185,129,0.15)', text: '#6ee7b7', label: 'Launched' },
  paused:      { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)', text: '#fcd34d', label: 'Paused' },
  cancelled:   { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Cancelled' },
};

const DEFAULT_FALLBACK: StatusMeta = {
  solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown',
};

/** Resolve display metadata for a status string against config (or coding defaults). */
export function getStatusMeta(status: string, config?: HarnessConfig): StatusMeta {
  // Coding-harness statuses: use the legacy STATUS const.
  if (status in STATUS) {
    return STATUS[status as HarnessStatus];
  }
  // Org-level statuses: use defaults from this module.
  const defaultMeta = DEFAULT_STATUS_COLORS[status];
  // Per-config overrides.
  const override = config?.statusColors?.[status];
  if (override) {
    return { ...DEFAULT_FALLBACK, ...defaultMeta, ...override, label: override.label ?? defaultMeta?.label ?? humanize(status) };
  }
  if (defaultMeta) return defaultMeta;
  return { ...DEFAULT_FALLBACK, label: humanize(status) };
}

/** Board column layout (left → right). Falls back to coding-harness BOARD_COLUMN_ORDER. */
export function getBoardColumnOrder(config?: HarnessConfig): string[] {
  if (config?.boardColumnOrder?.length) return config.boardColumnOrder;
  if (config?.itemStates?.length) return config.itemStates;
  return BOARD_COLUMN_ORDER as unknown as string[];
}

/** Sort ordering for list views (active first, terminal last). */
export function getStatusOrder(config?: HarnessConfig): string[] {
  if (config?.statusOrder?.length) return config.statusOrder;
  if (config?.itemStates?.length) {
    const term = new Set(config.terminalStates ?? []);
    const nonTerm = config.itemStates.filter((s) => !term.has(s));
    return [...nonTerm, ...config.itemStates.filter((s) => term.has(s))];
  }
  return STATUS_ORDER as unknown as string[];
}

/** The "completed" / success status — used by InsightsPanel KPIs. */
export function getSuccessState(config?: HarnessConfig): string {
  return config?.successState ?? 'passed';
}

/** Saved-view filter list. Falls back to coding-harness defaults. */
export function getSavedViews(config?: HarnessConfig): Array<{ id: string; name: string; filter: { statuses: string[] } }> {
  if (config?.savedViews?.length) return config.savedViews;
  return [
    { id: 'running', name: 'Running', filter: { statuses: ['in_progress', 'validating'] } },
    { id: 'blocked', name: 'Blocked', filter: { statuses: ['blocked', 'failing'] } },
    { id: 'todo', name: 'Todo', filter: { statuses: ['todo'] } },
    { id: 'done', name: 'Passed', filter: { statuses: ['passed'] } },
  ];
}

function humanize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
