/**
 * Dock layouts persistence — Phase 0 / Phase 2 of the dockview migration.
 *
 * Stores per-user named dock layouts in PG. The on-disk shape is the
 * LOGICAL layout (LayoutDoc), not raw dockview JSON — we control schema
 * versioning, validation, and dockview-API portability at the adapter.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §4
 */

import { sharedUtilityPoolMax } from './resource-profile';
import { getLongLivedAdminPool } from './long-lived-admin-pool';

export const CURRENT_LAYOUT_SCHEMA_VERSION = 1 as const;

/**
 * schemaVersion = 0 is the OPAQUE escape hatch. Used by pi-tab persistence
 * (raw dockview JSON, not the logical LayoutDoc shape). The PG row still
 * tracks the value; the LayoutDoc adapter is bypassed. Callers must
 * remember which schemaVersion they wrote — pi-tab reads back its own
 * opaque body and feeds it directly to dockview's fromJSON.
 *
 * For the eventual whole-app dock (Phase 5), the adapter at the boundary
 * converts between LayoutDoc and dockview JSON, so schemaVersion=1 is
 * the canonical path.
 */
export const OPAQUE_SCHEMA_VERSION = 0 as const;

// ───────── Logical layout schema (storage shape) ─────────

export type PanelInstance = {
  id: string;
  type: string;
  title?: string;
  params?: Record<string, unknown>;
  keepAlive?: boolean;
};

export type TabStrip = {
  kind: 'tabs';
  id: string;
  activePanelId: string;
  panels: PanelInstance[];
  /** Fractional split size (0–1) when this strip is a child of a GroupNode —
   *  the seed layouts set it on tab cells just like on GroupNode children. */
  size?: number;
};

export type GroupNode = {
  kind: 'group';
  id: string;
  direction?: 'row' | 'col';
  children: Array<GroupNode | TabStrip>;
  size?: number;
};

export type FloatingGroup = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  panels: PanelInstance[];
  activePanelId: string;
};

export type LayoutDoc = {
  schemaVersion: 1;
  root: GroupNode | TabStrip;
  floating?: FloatingGroup[];
};

// ───────── Auth resolver ─────────

export type LayoutPrincipal = { workspaceId: string; userId: string };

async function notifyDockLayout(principal: LayoutPrincipal, name: string): Promise<void> {
  try {
    const { notifySyncInvalidate } = await import('./sync-sse');
    await Promise.all([
      notifySyncInvalidate('dockLayouts.byName', { workspaceId: principal.workspaceId, name }),
      notifySyncInvalidate('dockLayouts.list', { workspaceId: principal.workspaceId }),
    ]);
  } catch { /* table bridge remains the fallback */ }
}

/**
 * Returns the (workspaceId, userId) tuple to scope a layout request.
 *
 * Resolution order:
 *   1. Authenticated session (cookie) → real user_id
 *   2. Loopback fallback (env vars; defaults workspace=default user=_local)
 *
 * Workspace ID:
 *   1. Request URL `?ws=<id>` query param (per useWorkspaceId convention)
 *   2. PAPERCUSP_WORKSPACE_ID env
 *   3. 'default'
 *
 * Async because cookie reads via Next.js are async; getSessionUser hits PG.
 */
export async function getUserIdForLayouts(
  req?: Request,
): Promise<LayoutPrincipal> {
  // Workspace ID — prefer URL param, then env, then default.
  let workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? 'default';
  if (req) {
    try {
      const url = new URL(req.url);
      const fromUrl = url.searchParams.get('ws');
      if (fromUrl && fromUrl.length > 0) workspaceId = fromUrl;
    } catch {
      /* malformed URL — fall through */
    }
  }

  // User ID — prefer authenticated session, fall back to loopback.
  let userId = process.env.PAPERCUSP_USER_ID ?? '_local';
  try {
    // Lazy import to avoid the auth module's PG-pool side effects in
    // contexts that don't need it (unit tests, scripts).
    const { getSessionUser } = await import('./auth');
    const user = await getSessionUser();
    if (user?.id) userId = user.id;
  } catch {
    /* auth lookup failed — fall back to env */
  }

  return { workspaceId, userId };
}

// ───────── Default layout seed ─────────

/**
 * The static seed used on first read miss. **Mirrors the classic
 * HarnessDashboard layout** at /harness/<slug> so users opening the
 * dock for the first time see the same arrangement they're used to:
 *
 *   ┌─────────────┬───────────────────────────────────────┐
 *   │ git (30%)   │ Feature queue                  (40%)  │
 *   │             │                                       │
 *   │             ├───────────────────────────────────────┤
 *   │ + overview  │ Issues                         (35%)  │
 *   │   tab       │                                       │
 *   │             ├──────────────────┬────────────────────┤
 *   │             │ Recent agents 50%│ run.log         50%│
 *   │             │                  │                    │
 *   └─────────────┴──────────────────┴────────────────────┘
 *
 * Source of truth for the classic layout: HarnessDashboard.tsx
 * PanelGroup tree around line 4481. Git rail is collapsible at 30%
 * default; main area splits 40/35/25 vertically, with the bottom
 * row split 50/50 horizontally (agents | logs).
 *
 * `view:harness-overview` lives as a second tab in the git rail
 * (the classic .h-header bar's metadata, displayed on demand).
 */
export function defaultDashboardLayout(harnessSlug = ''): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'root',
      direction: 'row',
      children: [
        // Left: Git rail with harness-overview as secondary tab.
        // Classic dashboard defaults this to 30% width, collapsible.
        {
          kind: 'tabs',
          id: 'git-rail',
          size: 0.3,
          activePanelId: 'p-git',
          panels: [
            {
              id: 'p-git',
              type: 'data:git',
              params: { harnessSlug },
            },
            {
              id: 'p-overview',
              type: 'view:harness-overview',
              params: { harnessSlug, phase: 'staging' },
            },
          ],
        },
        // Right: vertical stack of features (40%), issues (35%), and
        // an agents+logs row (25% split 50/50).
        {
          kind: 'group',
          id: 'main-stack',
          direction: 'col',
          size: 0.7,
          children: [
            {
              kind: 'tabs',
              id: 'features-row',
              size: 0.4,
              activePanelId: 'p-features',
              panels: [
                {
                  id: 'p-features',
                  type: 'data:features',
                  params: { harnessSlug },
                },
              ],
            },
            {
              kind: 'tabs',
              id: 'issues-row',
              size: 0.35,
              activePanelId: 'p-issues',
              panels: [
                {
                  id: 'p-issues',
                  type: 'data:issues',
                  params: { harnessSlug },
                },
              ],
            },
            {
              kind: 'group',
              id: 'telemetry-row',
              direction: 'row',
              size: 0.25,
              children: [
                {
                  kind: 'tabs',
                  id: 'agents-cell',
                  size: 0.5,
                  activePanelId: 'p-agents',
                  panels: [
                    {
                      id: 'p-agents',
                      type: 'data:agents',
                      params: { harnessSlug },
                    },
                  ],
                },
                {
                  kind: 'tabs',
                  id: 'logs-cell',
                  size: 0.5,
                  activePanelId: 'p-logs',
                  panels: [
                    {
                      id: 'p-logs',
                      type: 'data:logs',
                      params: { harnessSlug },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    floating: [],
  };
}

/**
 * /adv/harnesses seed — three horizontal panes (Features 25 / Issues 25 /
 * Detail 50). The Detail pane swaps content based on the `?sel=<id>`
 * URL selector — feature mode for `F-*` ids, issue mode for `I-*` ids,
 * empty state when nothing selected.
 *
 * Right-clicking a row in either list and choosing "Pin to new panel"
 * opens an `adv:pinned` tab whose item is fixed (it ignores `?sel=`).
 * These pinned tabs ride alongside Detail and are arbitrarily resizable
 * / draggable / closable via dockview.
 */
/**
 * /adv Harness tab seed (`adv-harnesses3`). Two rows, the top one SPLIT:
 *
 *   ┌──────────────────┬──────────────────┐
 *   │ Work items       │ Dependency graph │   top row (50% height)
 *   ├──────────────────┴──────────────────┤
 *   │ Detail              (full width)    │   bottom row (50% height)
 *   └─────────────────────────────────────┘
 *
 * The graph pane (dependency-health-pane-2026-08-02) pairs with the GRID because they are two
 * views of ONE dataset — same `workItems.byHarness` subscription, same `?sel` selection — so
 * filtering or selecting in either moves both. Owner-ratified layout: D-006.
 *
 * Fractional sizes (0.5) — dockview rescales proportionally on mount.
 * The unified work_items grid (blueprint-aware-harness-ui P-010) replaced
 * the retired Features | Issues pair (2026-06-10).
 *
 * Dock-name history — each bump deliberately ABANDONS persisted rows:
 *   adv-harnesses  → adv-harnesses2  (2026-06-10, the adv-create2 convention) so rows
 *                    holding the retired Features/Issues panel types are dropped rather
 *                    than hydrated into MissingPanel fallbacks.
 *   adv-harnesses2 → adv-harnesses3  (2026-08-03, dependency-health-pane D-002) so the
 *                    new dependency-graph pane actually REACHES existing users: a
 *                    persisted layout row wins over this seed, so without the bump the
 *                    pane would appear for new installs only.
 */
export function defaultAdvHarnessesLayout(harnessSlug = ''): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'root',
      direction: 'col',
      children: [
        // Top ROW: the work-items grid and the dependency graph, side by side.
        // dependency-health-pane-2026-08-02 D-006 (owner-ratified): the graph pairs with the
        // GRID, not with Detail — they are two views of ONE dataset (same
        // `workItems.byHarness` subscription, same `?sel` selection), so they sit adjacent and
        // Detail stays full-width beneath both.
        {
          kind: 'group',
          id: 'work-row',
          direction: 'row',
          size: 0.5,
          children: [
            {
              kind: 'tabs',
              id: 'work-items-cell',
              size: 0.5,
              activePanelId: 'p-adv-work-items',
              panels: [
                {
                  id: 'p-adv-work-items',
                  type: 'adv:work-items',
                  params: { harnessSlug },
                },
              ],
            },
            {
              kind: 'tabs',
              id: 'dep-graph-cell',
              size: 0.5,
              activePanelId: 'p-adv-dep-graph',
              panels: [
                {
                  id: 'p-adv-dep-graph',
                  type: 'adv:dep-graph',
                  params: { harnessSlug },
                },
              ],
            },
          ],
        },
        // Bottom: Detail reader pane, full width.
        {
          kind: 'tabs',
          id: 'detail-cell',
          size: 0.5,
          activePanelId: 'p-adv-detail',
          panels: [
            {
              id: 'p-adv-detail',
              type: 'adv:detail',
              params: { harnessSlug },
            },
          ],
        },
      ],
    },
    floating: [],
  };
}

/**
 * Seed layout for the /adv Git dock (AdvGitWorkspace): the RichGrid git
 * graph on the left, pull requests on the right, split ~58/42.
 */
export function defaultAdvGitLayout(harnessSlug = ''): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'root',
      direction: 'row',
      children: [
        {
          kind: 'tabs',
          id: 'git-graph-cell',
          size: 0.58,
          activePanelId: 'p-adv-git-graph',
          panels: [
            {
              id: 'p-adv-git-graph',
              type: 'adv:git-graph',
              params: { harnessSlug },
            },
          ],
        },
        {
          kind: 'tabs',
          id: 'prs-cell',
          size: 0.42,
          activePanelId: 'p-adv-prs',
          panels: [
            {
              id: 'p-adv-prs',
              type: 'adv:prs',
              params: { harnessSlug },
            },
          ],
        },
      ],
    },
    floating: [],
  };
}

/**
 * Seed layout for the /adv "Create" dock (?tab=plans, AdvCreateDock).
 *
 * Option-B "free panels": the three former subtabs (plan browser / inbox /
 * Two fixed regions — a left FILTER sidebar (create:filter: New plan + the
 * Plans/Inbox/Sessions view buttons + search/bucket filters + the plan list)
 * and a right MAIN region (create:main) that renders the active `?view`
 * (Plans = one full-width pane, Inbox/Sessions = split list|detail). The
 * panels are workspace/scope-driven via URL params (?slug/?scope/?h/?view),
 * so the seed carries no harnessSlug — nothing to rebind on slug change. The
 * Create dock uses dockview purely for the resizable, header-less, locked
 * sidebar|main split; navigation is the external buttons, not dockview tabs.
 */
export function defaultAdvCreateLayout(): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'root',
      direction: 'row',
      children: [
        {
          kind: 'tabs',
          id: 'create-filter',
          size: 0.24,
          activePanelId: 'p-create-filter',
          panels: [{ id: 'p-create-filter', type: 'create:filter', params: {} }],
        },
        {
          kind: 'tabs',
          id: 'create-main',
          size: 0.76,
          activePanelId: 'p-create-main',
          panels: [{ id: 'p-create-main', type: 'create:main', params: {} }],
        },
      ],
    },
    floating: [],
  };
}

/**
 * Pi-tab-specific seed for Phase 2. The pi tab today owns its own
 * localStorage layout; this seeds the PG-backed replacement.
 */
export function defaultPiTerminalsLayout(): LayoutDoc {
  return {
    schemaVersion: 1,
    root: {
      kind: 'tabs',
      id: 'pi-root',
      activePanelId: 'p-terminal-1',
      panels: [
        {
          id: 'p-terminal-1',
          type: 'pi:terminal',
          title: 'Terminal 1',
          params: { sessionId: 'default' },
        },
      ],
    },
    floating: [],
  };
}

/**
 * Top-level workbench seed (desktop-workbench-shell-2026-06-05) — three
 * panes side by side: the embedded **pui** terminal, the **main /adv app**,
 * and a **voice/video** comms pane. Per D-001 the standalone operator-chat
 * pane is RETIRED (the operator chat lives inside the /adv app pane). The
 * pui + voice panels carry the active `harnessSlug`, patched at runtime from
 * the route's `?harness=` (the dock-preview pattern), so the static seed
 * bakes an empty slug; the /adv app pane self-manages its own harness
 * selector, so it carries no slug.
 */
export function defaultWorkbenchLayout(harnessSlug = ''): LayoutDoc {
  // The pui/terminal is NO LONGER a dockview pane (native-terminal-desktop-2026-06-06
  // D-002/D-008, superseding desktop-workbench-shell D-003). A webview can't host
  // a NATIVE terminal, so the terminal workbench (`pui workbench` = zellij + the
  // ratatui pui) runs as a native SIBLING window glued to the GUI, launched by the
  // Tauri shell (src-tauri/src/native_terminal.rs) — not embedded here. This dock
  // keeps only the GUI surfaces: the main /adv app + the voice/video pane.
  return {
    schemaVersion: 1,
    root: {
      kind: 'group',
      id: 'root',
      direction: 'row',
      children: [
        {
          kind: 'tabs',
          id: 'wb-app',
          size: 0.6,
          activePanelId: 'p-wb-app',
          panels: [
            {
              id: 'p-wb-app',
              type: 'workbench:app',
              title: 'App',
              params: { src: '/adv' },
            },
          ],
        },
        {
          kind: 'tabs',
          id: 'wb-voice',
          size: 0.4,
          activePanelId: 'p-wb-voice',
          panels: [
            {
              id: 'p-wb-voice',
              type: 'workbench:voice',
              title: 'Peers',
              params: { harnessSlug },
            },
            {
              // The P2P hive-directory browse list (p2p-hive-directory P-007).
              // Without a seed entry the registered panel type is UNREACHABLE —
              // nothing else ever adds it to a layout.
              id: 'p-wb-hives',
              type: 'workbench:hive-directory',
              title: 'Hives',
              params: {},
            },
          ],
        },
      ],
    },
    floating: [],
  };
}

// ───────── Validation ─────────

export class LayoutValidationError extends Error {
  constructor(message: string) {
    super(`LayoutValidationError: ${message}`);
    this.name = 'LayoutValidationError';
  }
}

export function validateLayoutDoc(doc: unknown): asserts doc is LayoutDoc {
  if (!doc || typeof doc !== 'object') {
    throw new LayoutValidationError('layout must be an object');
  }
  const d = doc as { schemaVersion?: number };
  if (d.schemaVersion === OPAQUE_SCHEMA_VERSION) {
    // Opaque body: no structural validation. The PG row preserves the
    // schemaVersion so readers know they wrote it.
    return;
  }
  const ld = doc as LayoutDoc;
  if (ld.schemaVersion !== CURRENT_LAYOUT_SCHEMA_VERSION) {
    throw new LayoutValidationError(
      `unsupported schemaVersion ${ld.schemaVersion} (expected ${CURRENT_LAYOUT_SCHEMA_VERSION} or ${OPAQUE_SCHEMA_VERSION})`,
    );
  }
  if (!ld.root || typeof ld.root !== 'object') {
    throw new LayoutValidationError('layout.root required');
  }
  validateNode(ld.root);
  if (ld.floating !== undefined) {
    if (!Array.isArray(ld.floating)) {
      throw new LayoutValidationError('layout.floating must be array');
    }
    for (const f of ld.floating) validateFloating(f);
  }
}

/**
 * Non-throwing structural check for a v1 LayoutDoc. Returns true only when the
 * body is schemaVersion 1 AND `root` (plus every descendant node) is
 * well-formed.
 *
 * Use at trust boundaries that must NOT crash on a malformed layout. The dock
 * reads a layout from the API/PG that, during a save/fetch race, can
 * transiently come back with a null/absent `root`; feeding that to the render
 * path threw `undefined is not an object (evaluating 'e.kind')` (HarnessDock's
 * collectTypes → walk(doc.root)) and latched the whole /adv route error
 * boundary, taking down every tab. Callers treat `false` as "no usable layout"
 * (render empty / refetch / reseed) instead of trusting `schemaVersion === 1`
 * to imply a valid tree.
 */
export function isWellFormedLayout(doc: unknown): doc is LayoutDoc {
  if (!doc || typeof doc !== 'object') return false;
  if (
    (doc as { schemaVersion?: unknown }).schemaVersion !==
    CURRENT_LAYOUT_SCHEMA_VERSION
  ) {
    // Opaque (v0) and unknown bodies have no structural guarantee — not usable
    // by the render path. validateLayoutDoc would pass v0 (it skips structural
    // checks), so gate on v1 here before delegating.
    return false;
  }
  try {
    validateLayoutDoc(doc);
    return true;
  } catch {
    return false;
  }
}

function validateNode(n: GroupNode | TabStrip): void {
  if (n.kind === 'group') {
    if (!Array.isArray(n.children)) {
      throw new LayoutValidationError(`group ${n.id} missing children`);
    }
    for (const child of n.children) validateNode(child);
  } else if (n.kind === 'tabs') {
    if (!Array.isArray(n.panels)) {
      throw new LayoutValidationError(`tabs ${n.id} missing panels`);
    }
    if (n.panels.length > 0) {
      const ids = new Set(n.panels.map((p) => p.id));
      if (!ids.has(n.activePanelId)) {
        throw new LayoutValidationError(
          `tabs ${n.id} activePanelId ${n.activePanelId} not in panels`,
        );
      }
    }
    for (const p of n.panels) validatePanel(p);
  } else {
    throw new LayoutValidationError(`unknown node kind`);
  }
}

function validatePanel(p: PanelInstance): void {
  if (!p.id || typeof p.id !== 'string') {
    throw new LayoutValidationError('panel missing id');
  }
  if (!p.type || typeof p.type !== 'string') {
    throw new LayoutValidationError(`panel ${p.id} missing type`);
  }
}

function validateFloating(f: FloatingGroup): void {
  if (typeof f.x !== 'number' || typeof f.y !== 'number') {
    throw new LayoutValidationError(`floating ${f.id} bad x/y`);
  }
  if (typeof f.width !== 'number' || typeof f.height !== 'number') {
    throw new LayoutValidationError(`floating ${f.id} bad w/h`);
  }
  for (const p of f.panels) validatePanel(p);
}

// ───────── DB plumbing ─────────

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () =>
  getLongLivedAdminPool('dock-layouts', { max: sharedUtilityPoolMax(), prepare: false });

export type LayoutRow = {
  workspaceId: string;
  userId: string;
  layoutName: string;
  schemaVersion: number;
  layoutJson: LayoutDoc;
  updatedTs: number;
  createdTs: number;
};

// ───────── CRUD ─────────

/**
 * Seed layout for a dock `name`, resolved by its conventional prefix. Shared
 * by getLayout (read-miss seed) and resetLayout (hard reset) so the two can't
 * drift — the `adv-create` dock was wired into the seed path but silently
 * missing from reset, so a Shift+Esc reset reseeded it to the dashboard
 * layout. Pi is intentionally NOT handled here: its two call sites diverge
 * (getLayout seeds an opaque placeholder body; resetLayout seeds
 * defaultPiTerminalsLayout), so each handles pi itself before delegating.
 *
 * `dashboard:<slug>` / `adv-git2:<slug>` / `adv-harnesses3:<slug>` carry the
 * harnessSlug so seeded panels fetch the right harness; adv-create is
 * scope-driven via URL params and carries no slug.
 */
export function seedForDockName(name: string): LayoutDoc {
  const slugAfter = (prefix: string) =>
    name.startsWith(prefix) ? name.slice(prefix.length) : '';
  // adv-create2: bumped from adv-create when the Create dock changed from the
  // 5-panel free layout to the fixed filter|main split — the old name's
  // persisted rows would hydrate now-unregistered panels (create:inbox, …).
  if (name === 'adv-create2' || name.startsWith('adv-create2:')) {
    return defaultAdvCreateLayout();
  }
  if (name === 'adv-git2' || name.startsWith('adv-git2:')) {
    return defaultAdvGitLayout(slugAfter('adv-git2:'));
  }
  // adv-harnesses3: bumped from adv-harnesses when the Features/Issues panels
  // were retired for the unified Work-items grid — the old name's persisted
  // rows would hydrate now-unregistered panels (adv:features, adv:issues).
  if (name === 'adv-harnesses3' || name.startsWith('adv-harnesses3:')) {
    return defaultAdvHarnessesLayout(slugAfter('adv-harnesses3:'));
  }
  if (name === 'workbench' || name.startsWith('workbench:')) {
    return defaultWorkbenchLayout(slugAfter('workbench:'));
  }
  return defaultDashboardLayout(slugAfter('dashboard:'));
}

/**
 * Returns the named layout for (workspaceId, userId). On miss, seeds
 * `defaultDashboardLayout()` (or pi-terminals seed when `name === 'pi'`),
 * INSERTs the row, and returns it. Subsequent calls hit the row.
 *
 * Schema migration: stored bodies older than CURRENT_LAYOUT_SCHEMA_VERSION
 * are lifted via migrateLayoutBody before being returned. Migrations are
 * not persisted automatically — the next save round-trip writes the
 * lifted body back. Opaque bodies (pi-tab) are passed through unchanged.
 */
export async function getLayout(
  principal: LayoutPrincipal,
  name = 'default',
): Promise<LayoutRow> {
  const sql = db();
  const rows = await sql<
    Array<{
      workspace_id: string;
      user_id: string;
      layout_name: string;
      schema_version: number;
      layout_json: LayoutDoc;
      updated_ts: bigint;
      created_ts: bigint;
    }>
  >`
    SELECT workspace_id, user_id, layout_name, schema_version, layout_json,
           updated_ts, created_ts
      FROM harness_shared.harness_dock_layouts
     WHERE workspace_id = ${principal.workspaceId}
       AND user_id = ${principal.userId}
       AND layout_name = ${name}
     LIMIT 1
  `;
  if (rows.length > 0) {
    const row = rowToLayout(rows[0]);
    // Migrate body if stale. Imported lazily to avoid a cycle.
    const { migrateLayoutBody } = await import('./dock-layout-migrators');
    const { layout, migrated, warning } = migrateLayoutBody(row.layoutJson, {
      isPi: name === 'pi' || name.startsWith('pi:'),
    });
    if (warning) {
      console.warn(`[dock-layouts] ${name}: ${warning}`);
    }
    if (migrated) {
      row.layoutJson = layout;
      row.schemaVersion = (layout as { schemaVersion?: number }).schemaVersion ?? row.schemaVersion;
    }
    return row;
  }
  // Seed. Pi-tab layouts (any `pi:<slug>` name) get an opaque empty body
  // — pi-tab's persistence stores raw dockview JSON and reads back its
  // own writes, so the seed is just a placeholder that won't be parsed.
  // Every other dock name routes through seedForDockName (shared with
  // resetLayout so the seed/reset pair can't drift).
  const seed: LayoutDoc =
    name === 'pi' || name.startsWith('pi:')
      ? ({ schemaVersion: OPAQUE_SCHEMA_VERSION, dockviewJson: null } as unknown as LayoutDoc)
      : seedForDockName(name);
  return saveLayout(principal, name, seed);
}

/**
 * Inserts or updates a layout. If `expectedUpdatedTs` is given, the
 * UPDATE is conditional (optimistic concurrency) — returns null on stale.
 */
export async function saveLayout(
  principal: LayoutPrincipal,
  name: string,
  doc: LayoutDoc,
  expectedUpdatedTs?: number,
): Promise<LayoutRow> {
  validateLayoutDoc(doc);
  const sql = db();
  const now = Date.now();
  if (typeof expectedUpdatedTs === 'number') {
    const updated = await sql<
      Array<{
        workspace_id: string;
        user_id: string;
        layout_name: string;
        schema_version: number;
        layout_json: LayoutDoc;
        updated_ts: bigint;
        created_ts: bigint;
      }>
    >`
      UPDATE harness_shared.harness_dock_layouts
         -- jsonb write MUST use sql.json() for the db() pool. db() is a default-config
         -- postgres-js pool, unlike the operator getOrgPg client where sql.json throws
         -- "Buffer.byteLength received Object" (see 7b4cfb25c /
         -- agent-insights/postgres-js-jsonb-binding). On this pool the JSON.stringify
         -- form double-encodes: postgres-js json-serializes the already-stringified
         -- text, storing a jsonb STRING (jsonb_typeof=string), so reads return a string
         -- and the dock white-screens (collectTypes walks a string -> undefined.kind).
         SET layout_json = ${sql.json(doc as unknown as Record<string, unknown>)},
             schema_version = ${doc.schemaVersion},
             updated_ts = ${now}
       WHERE workspace_id = ${principal.workspaceId}
         AND user_id = ${principal.userId}
         AND layout_name = ${name}
         AND updated_ts = ${expectedUpdatedTs}
       RETURNING *
    `;
    if (updated.length === 0) {
      throw new LayoutConflictError(
        `stale write: expected updated_ts ${expectedUpdatedTs}`,
      );
    }
    const row = rowToLayout(updated[0]);
    await notifyDockLayout(principal, name);
    return row;
  }
  const upserted = await sql<
    Array<{
      workspace_id: string;
      user_id: string;
      layout_name: string;
      schema_version: number;
      layout_json: LayoutDoc;
      updated_ts: bigint;
      created_ts: bigint;
    }>
  >`
    INSERT INTO harness_shared.harness_dock_layouts
      (workspace_id, user_id, layout_name, schema_version, layout_json, updated_ts, created_ts)
    VALUES
      (${principal.workspaceId}, ${principal.userId}, ${name}, ${doc.schemaVersion},
       -- sql.json() here too (see the UPDATE branch above) — JSON.stringify(doc)::jsonb
       -- double-encodes to a jsonb string on this default postgres-js pool.
       ${sql.json(doc as unknown as Record<string, unknown>)}, ${now}, ${now})
    ON CONFLICT (workspace_id, user_id, layout_name) DO UPDATE
      SET layout_json    = EXCLUDED.layout_json,
          schema_version = EXCLUDED.schema_version,
          updated_ts     = EXCLUDED.updated_ts
    RETURNING *
  `;
  const row = rowToLayout(upserted[0]);
  await notifyDockLayout(principal, name);
  return row;
}

export async function deleteLayout(
  principal: LayoutPrincipal,
  name: string,
): Promise<void> {
  const sql = db();
  await sql`
    DELETE FROM harness_shared.harness_dock_layouts
     WHERE workspace_id = ${principal.workspaceId}
       AND user_id = ${principal.userId}
       AND layout_name = ${name}
  `;
  await notifyDockLayout(principal, name);
}

export async function listLayouts(
  principal: LayoutPrincipal,
): Promise<Array<{ name: string; updatedTs: number }>> {
  const sql = db();
  const rows = await sql<
    Array<{ layout_name: string; updated_ts: bigint }>
  >`
    SELECT layout_name, updated_ts
      FROM harness_shared.harness_dock_layouts
     WHERE workspace_id = ${principal.workspaceId}
       AND user_id = ${principal.userId}
     ORDER BY updated_ts DESC
  `;
  return rows.map((r) => ({
    name: r.layout_name,
    updatedTs: Number(r.updated_ts),
  }));
}

export async function resetLayout(
  principal: LayoutPrincipal,
  name = 'default',
): Promise<LayoutRow> {
  // Pi reset reseeds the pi-terminals default (unlike getLayout, which seeds
  // an opaque placeholder); every other name shares seedForDockName so reset
  // matches the read-miss seed exactly (incl. adv-create, which this path
  // previously dropped through to the dashboard layout).
  const seed =
    name === 'pi' || name.startsWith('pi:')
      ? defaultPiTerminalsLayout()
      : seedForDockName(name);
  return saveLayout(principal, name, seed);
}

export class LayoutConflictError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'LayoutConflictError';
  }
}

function rowToLayout(r: {
  workspace_id: string;
  user_id: string;
  layout_name: string;
  schema_version: number;
  layout_json: LayoutDoc;
  updated_ts: bigint;
  created_ts: bigint;
}): LayoutRow {
  return {
    workspaceId: r.workspace_id,
    userId: r.user_id,
    layoutName: r.layout_name,
    schemaVersion: r.schema_version,
    layoutJson: r.layout_json,
    updatedTs: Number(r.updated_ts),
    createdTs: Number(r.created_ts),
  };
}

// ───────── Last-used phase per harness (Phase 4) ─────────

export async function getLastUsedPhase(
  principal: LayoutPrincipal,
  harnessSlug: string,
): Promise<string | null> {
  const sql = db();
  const rows = await sql<Array<{ phase: string }>>`
    SELECT phase
      FROM harness_shared.harness_phase_last_used
     WHERE workspace_id = ${principal.workspaceId}
       AND harness_slug = ${harnessSlug}
       AND user_id = ${principal.userId}
     LIMIT 1
  `;
  return rows[0]?.phase ?? null;
}

export async function setLastUsedPhase(
  principal: LayoutPrincipal,
  harnessSlug: string,
  phase: string,
): Promise<void> {
  const sql = db();
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.harness_phase_last_used
      (workspace_id, harness_slug, user_id, phase, updated_ts)
    VALUES
      (${principal.workspaceId}, ${harnessSlug}, ${principal.userId}, ${phase}, ${now})
    ON CONFLICT (workspace_id, harness_slug, user_id) DO UPDATE
      SET phase = EXCLUDED.phase,
          updated_ts = EXCLUDED.updated_ts
  `;
}
