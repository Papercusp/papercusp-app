export const CURRENT_LAYOUT_SCHEMA_VERSION = 1 as const;
export const OPAQUE_SCHEMA_VERSION = 0 as const;

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
  schemaVersion: typeof CURRENT_LAYOUT_SCHEMA_VERSION;
  root: GroupNode | TabStrip;
  floating?: FloatingGroup[];
};

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
  if (d.schemaVersion === OPAQUE_SCHEMA_VERSION) return;
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
 * Every distinct panel `type` a layout references — docked groups AND floating
 * groups. Shared by the component-bridge map and the dead-layout classifier
 * below so the two can never disagree about what a layout "contains".
 */
export function collectPanelTypes(doc: LayoutDoc): Set<string> {
  const into = new Set<string>();
  function walk(n: GroupNode | TabStrip | null | undefined): void {
    if (!n) return;
    if (n.kind === 'tabs') {
      for (const p of n.panels ?? []) into.add(p.type);
    } else {
      for (const c of n.children ?? []) walk(c);
    }
  }
  walk(doc.root);
  for (const f of doc.floating ?? []) {
    for (const p of f.panels ?? []) into.add(p.type);
  }
  return into;
}

/**
 * True when a persisted layout is DEAD — i.e. every panel it references is a
 * type this build can never render, so hydrating it produces a wall of
 * "not installed" placeholders and zero usable panes. The caller's recovery is
 * to fall back to the seed.
 *
 * ⚠ The obvious rule — "no panel type is registered ⇒ dead" — is UNSAFE, and
 * getting this wrong is worse than the bug it fixes. A host may register some
 * panel types ASYNCHRONOUSLY (a plugin fetched at runtime); until that lands,
 * a perfectly VALID layout referencing those types looks identical to a dead
 * one. A guard without the exemption would discard a good layout whenever that
 * fetch was slow — an intermittent, load-dependent data-loss bug.
 *
 * Hence `isDeferredType`: the host declares which types may still be arriving,
 * and those NEVER count as dead. Callers should also allow a short grace window
 * before acting, so synchronous registrations racing first paint settle first.
 *
 * A PARTLY-dead layout is deliberately NOT dead: its live panes still work, and
 * showing a placeholder beside them is informative and recoverable, whereas
 * silently deleting a user's arrangement is neither.
 *
 * @param isRegistered   does this build currently render `type`?
 * @param isDeferredType may `type` still be registered later? (never dead)
 */
export function isLayoutEntirelyUnregistered(
  doc: LayoutDoc,
  isRegistered: (type: string) => boolean,
  isDeferredType?: (type: string) => boolean,
): boolean {
  const types = collectPanelTypes(doc);
  // An empty layout is not "dead" — there is nothing to have gone stale, and
  // reseeding it would fight a host that legitimately renders an empty dock.
  if (types.size === 0) return false;
  for (const type of types) {
    if (isRegistered(type)) return false;
    if (isDeferredType?.(type)) return false;
  }
  return true;
}

export function isWellFormedLayout(doc: unknown): doc is LayoutDoc {
  if (!doc || typeof doc !== 'object') return false;
  if ((doc as { schemaVersion?: unknown }).schemaVersion !== CURRENT_LAYOUT_SCHEMA_VERSION) return false;
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
        throw new LayoutValidationError(`tabs ${n.id} activePanelId ${n.activePanelId} not in panels`);
      }
    }
    for (const p of n.panels) validatePanel(p);
  } else {
    throw new LayoutValidationError('unknown node kind');
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
