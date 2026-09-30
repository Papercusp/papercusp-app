/**
 * dock-layout-migrators — in-process schema migration for LayoutDoc.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §4.6
 *
 * When `CURRENT_LAYOUT_SCHEMA_VERSION` bumps beyond what's stored, this
 * module walks registered migrators (v1→v2→v3...) to lift the body.
 *
 * Unknown future versions: return the seed default + warn, don't crash.
 *
 * Migrators are pure functions. They never write to PG; the caller
 * persists the migrated body once (next save round-trip).
 */

import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  OPAQUE_SCHEMA_VERSION,
  defaultDashboardLayout,
  type LayoutDoc,
} from './dock-layouts';

export type LayoutMigrator = (
  /** Body at the source version (cast loosely). */
  body: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * Registered migrators keyed by SOURCE version. A migrator at key N
 * transforms a v=N body to v=N+1. The runner walks consecutively until
 * the version matches CURRENT_LAYOUT_SCHEMA_VERSION.
 *
 * Add an entry here when bumping CURRENT_LAYOUT_SCHEMA_VERSION.
 */
const MIGRATORS: Record<number, LayoutMigrator> = {
  // Example skeleton for when v2 lands:
  //   1: (body) => ({
  //     ...body,
  //     schemaVersion: 2,
  //     // ...transform shape here...
  //   }),
};

export interface MigrateResult {
  /** The lifted body. May be the original (no migration needed) or seed (unknown). */
  layout: LayoutDoc;
  /** Whether migration actually happened. */
  migrated: boolean;
  /** Warning string if we fell back to seed. */
  warning?: string;
}

export function migrateLayoutBody(
  body: unknown,
  context: { isPi?: boolean; harnessSlug?: string } = {},
): MigrateResult {
  // Opaque schemaVersion=0 is never migrated — pi-tab raw dockview JSON.
  // The presence of `dockviewJson` distinguishes opaque-pi from a
  // legacy v0 LayoutDoc that just hasn't been versioned yet.
  if (
    body &&
    typeof body === 'object' &&
    (body as { schemaVersion?: number }).schemaVersion === OPAQUE_SCHEMA_VERSION &&
    'dockviewJson' in (body as object)
  ) {
    return { layout: body as LayoutDoc, migrated: false };
  }
  if (!body || typeof body !== 'object') {
    return {
      layout: defaultDashboardLayout(context.harnessSlug),
      migrated: true,
      warning: 'layout body was null/not-object — reseeded',
    };
  }
  const obj = body as Record<string, unknown>;
  let version = typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0;
  let working: Record<string, unknown> = obj;
  let migrated = false;

  // Walk migrators until we hit the current schema or run out.
  while (version < CURRENT_LAYOUT_SCHEMA_VERSION) {
    const m = MIGRATORS[version];
    if (!m) {
      return {
        layout: defaultDashboardLayout(context.harnessSlug),
        migrated: true,
        warning: `no migrator for schemaVersion ${version}; reseeded`,
      };
    }
    working = m(working);
    version = typeof working.schemaVersion === 'number' ? working.schemaVersion : version + 1;
    migrated = true;
  }

  if (version > CURRENT_LAYOUT_SCHEMA_VERSION) {
    return {
      layout: defaultDashboardLayout(context.harnessSlug),
      migrated: true,
      warning: `schemaVersion ${version} ahead of current ${CURRENT_LAYOUT_SCHEMA_VERSION}; reseeded`,
    };
  }

  return { layout: working as unknown as LayoutDoc, migrated };
}

/** Test-only — clears registered migrators. */
export function _resetMigratorsForTests(): void {
  for (const k of Object.keys(MIGRATORS)) delete MIGRATORS[+k];
}

/** Test-only — register a migrator. Production migrators are baked in above. */
export function _registerMigratorForTests(from: number, fn: LayoutMigrator): void {
  MIGRATORS[from] = fn;
}
