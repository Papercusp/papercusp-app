/**
 * k6 load-test category helpers (P-010 of testing-shell-cross-project-2026-06-01).
 *
 * The smoke/load/stress/spike/soak/browser taxonomy + colors are ported
 * from Restart's `/load-tests` page (LoadTestPanel) so the shared
 * <DomainTestPanel> can render the same category badges + filter chips for
 * any project that routes a k6 runner through it. Pure + React-free so the
 * registry entry (`@papercusp/testing-shell/registry`) and tests can import
 * it without pulling in the panel.
 */

export type K6Category = 'smoke' | 'load' | 'stress' | 'spike' | 'soak' | 'browser';

/** Canonical ordering used for the filter-chip row. */
export const K6_CATEGORIES: readonly K6Category[] = [
  'smoke',
  'load',
  'stress',
  'spike',
  'soak',
  'browser',
] as const;

const K6_CATEGORY_COLORS: Record<K6Category, string> = {
  smoke: '#4ade80',
  load: '#60a5fa',
  stress: '#f97316',
  spike: '#f43f5e',
  soak: '#a78bfa',
  browser: '#facc15',
};

const K6_CATEGORY_LABELS: Record<K6Category, string> = {
  smoke: 'Smoke',
  load: 'Load',
  stress: 'Stress',
  spike: 'Spike',
  soak: 'Soak',
  browser: 'Browser',
};

/** A k6 runner with no explicit category is treated as a plain load test. */
export const DEFAULT_K6_CATEGORY: K6Category = 'load';

/** Display color for a category; unknown categories fall back to a neutral grey. */
export function k6CategoryColor(cat: string | undefined): string {
  return K6_CATEGORY_COLORS[cat as K6Category] ?? '#94a3b8';
}

/** Human label for a category; unknown categories echo back verbatim. */
export function k6CategoryLabel(cat: string | undefined): string {
  if (!cat) return k6CategoryLabel(DEFAULT_K6_CATEGORY);
  return K6_CATEGORY_LABELS[cat as K6Category] ?? cat;
}

/** Minimal shape the category helpers need from a runner descriptor. */
export interface CategorizedRunner {
  kind: string;
  category?: string;
}

/** The effective category of a runner (defaulting a categoryless k6 runner). */
export function runnerCategory(r: CategorizedRunner): string {
  return r.category ?? DEFAULT_K6_CATEGORY;
}

/**
 * Which categories actually occur among a section's k6 runners, in canonical
 * order. Drives whether (and which) filter chips render — an empty result
 * means "no k6 runners here, show no chips".
 */
export function k6CategoriesPresent(runners: CategorizedRunner[]): K6Category[] {
  const present = new Set<string>();
  for (const r of runners) {
    if (r.kind === 'k6') present.add(runnerCategory(r));
  }
  return K6_CATEGORIES.filter((c) => present.has(c));
}

/**
 * Filter a runner list by the active category chip. `'all'` (or an empty
 * value) shows everything. A specific category keeps the k6 runners whose
 * effective category matches AND every non-k6 runner (categories only filter
 * k6 — a vitest/cargo runner has no category and is never hidden by it).
 */
export function visibleByCategory<T extends CategorizedRunner>(
  runners: T[],
  category: string | null | undefined,
): T[] {
  if (!category || category === 'all') return runners;
  return runners.filter((r) => r.kind !== 'k6' || runnerCategory(r) === category);
}
