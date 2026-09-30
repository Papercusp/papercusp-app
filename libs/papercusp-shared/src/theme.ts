/**
 * Linear-inspired design tokens for the harness dashboard.
 * Dense, low-chrome, keyboard-first.
 */

export const COLORS = {
  bg: '#0b0e14',
  surface: '#0f1420',
  surfaceRaised: '#111827',
  surfaceHover: '#1a2332',
  border: '#1f2937',
  borderStrong: '#374151',
  borderSubtle: '#161b26',

  text: '#e5e7eb',
  textMuted: '#9ca3af',
  textDim: '#6b7280',
  textFaint: '#4b5563',

  accent: '#5e6ad2',
  accentHover: '#7178d8',

  danger: '#7f1d1d',
  dangerBg: '#2a1315',
  dangerText: '#fca5a5',
  success: '#065f46',
  successBg: '#0f3024',
  successText: '#a7f3d0',
} as const;

// Status palette — dot uses COLOR_SOLID, pill bg uses COLOR_BG for subtler look.
// Wrapped in a Proxy that returns a neutral fallback for any status not in the
// coding-harness state machine (e.g. parent-harness `proposed`, `approved`).
// Without this, `STATUS[unknownStatus].label` crashes the entire FeatureList
// subtree at hydration when a parent harness's features are loaded — see
// `getStatusMeta()` below for the canonical config-aware lookup.
const _STATUS_TABLE = {
  todo:        { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)',  text: '#d1d5db', label: 'Todo' },
  in_progress: { solid: '#3b82f6', bg: 'rgba(59,130,246,0.15)',   text: '#93c5fd', label: 'In progress' },
  validating:  { solid: '#a855f7', bg: 'rgba(168,85,247,0.15)',   text: '#d8b4fe', label: 'Validating' },
  failing:     { solid: '#ef4444', bg: 'rgba(239,68,68,0.15)',    text: '#fca5a5', label: 'Failing' },
  blocked:     { solid: '#f59e0b', bg: 'rgba(245,158,11,0.15)',   text: '#fcd34d', label: 'Blocked' },
  passed:      { solid: '#10b981', bg: 'rgba(16,185,129,0.15)',   text: '#6ee7b7', label: 'Passed' },
} as const;

const _STATUS_FALLBACK = { solid: '#6b7280', bg: 'rgba(107,114,128,0.15)', text: '#9ca3af', label: 'Unknown' } as const;

export const STATUS = new Proxy(_STATUS_TABLE as Record<string, { solid: string; bg: string; text: string; label: string }>, {
  get(target, prop: string) {
    return (target as any)[prop] ?? _STATUS_FALLBACK;
  },
}) as typeof _STATUS_TABLE;

export type HarnessStatus = keyof typeof _STATUS_TABLE;

// Ordering used for list sort.
// Active work first, terminal states last.
export const STATUS_ORDER: HarnessStatus[] = [
  'in_progress', 'validating', 'failing', 'todo', 'blocked', 'passed',
];

// Ordering used for board column layout (left → right).
// Read like a workflow: queue → in motion → blocked → done.
export const BOARD_COLUMN_ORDER: HarnessStatus[] = [
  'todo', 'in_progress', 'validating', 'failing', 'blocked', 'passed',
];

export const ROLE = {
  planner:      { solid: '#a855f7', label: 'Planner' },
  orchestrator: { solid: '#ec4899', label: 'Orchestrator' },
  worker:       { solid: '#3b82f6', label: 'Worker' },
  validator:    { solid: '#10b981', label: 'Validator' },
  escalator:    { solid: '#f59e0b', label: 'Escalator' },
  unknown:      { solid: '#6b7280', label: 'Unknown' },
} as const;

export type RoleKey = keyof typeof ROLE;

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
