"use strict";
/**
 * @papercupai/design-phase — runtime artifact, hand-written CommonJS.
 *
 * Provides the MCP + HTTP tools the designer agent calls. Plan §15
 * (MCP surface): apps/operator-docs/src/content/docs/design/design-phase-plan.mdx.
 *
 * Six tools in v0.1: validate_spec, lint_spec, submit_spec, list_memos,
 * read_memo, get_design_spec. proposeToken / searchRegistry /
 * captureCurrentSurface deferred until DTCG store + adapter integration
 * lands.
 *
 * IMPORTANT — duplication: this plugin re-implements a small slice of
 * apps/operator/lib/design-ir + apps/operator/lib/design-spec because
 * those libs aren't yet a workspace package. The operator's libs are
 * authoritative; refactor to a shared package when the duplication
 * starts hurting.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// ─── PG URL resolution (audit P-076) ────────────────────────────────
// env → embedded-pg discovery file → native-:5432 dev fallback — the same
// order as operator-core's getHarnessAdminUrl and the sibling TS plugin
// postgres-manager's readDiscoveryUrl. Without the
// discovery tier, a desktop run (embedded PG on a random port) silently
// pointed this plugin at a wrong/absent native :5432.
//
// EI-14499 (same discovery-file-hijack class as EI-13917): the discovery
// file must be resolved under `PAPERCUSP_HOME` when a caller has scoped
// its own (an isolated gate/smoke-test instance, a per-workspace fleet
// session) — never the box-canonical `~/.papercusp/`. Mirrors
// packages/operator-core/lib/embedded-pg-discovery.ts's discoveryFilePath().
function discoveryFilePath() {
  return process.env.PAPERCUSP_HOME
    ? path.join(process.env.PAPERCUSP_HOME, 'embedded-pg.json')
    : path.join(os.homedir(), '.papercusp', 'embedded-pg.json');
}

function readDiscoveryAdminUrl() {
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') return null;
  try {
    const raw = fs.readFileSync(discoveryFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.host || !parsed?.port) return null;
    if (parsed.user && parsed.password) {
      return `postgresql://${parsed.user}:${parsed.password}@${parsed.host}:${parsed.port}/papercusp`;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveAdminPgUrl() {
  return (
    process.env.HARNESS_ADMIN_DATABASE_URL
    || process.env.HARNESS_DATABASE_URL
    || readDiscoveryAdminUrl()
    || 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp'
  );
}

// ─── ajv ────────────────────────────────────────────────────────────
let ajvInstance = null;
let validateFn = null;
function getAjv() {
  if (validateFn) return validateFn;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Ajv2020 = require('ajv/dist/2020');
  ajvInstance = new (Ajv2020.default ?? Ajv2020)({ allErrors: true, strict: false });
  validateFn = ajvInstance.compile(IR_SCHEMA);
  return validateFn;
}

// ─── IR schema (mirror of apps/operator/lib/design-ir/schema.ts) ────
const IR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://papercusp.dev/schemas/ui-ir/v0.1.json',
  type: 'object',
  required: ['irVersion', 'surface', 'ecosystem', 'layout'],
  additionalProperties: false,
  properties: {
    irVersion: { type: 'string', pattern: '^0\\.[0-9]+$' },
    surface: { type: 'string', minLength: 1 },
    ecosystem: { type: 'string', minLength: 1 },
    layout: { $ref: '#/$defs/node' },
    components: { type: 'array', items: { $ref: '#/$defs/componentBinding' } },
    tokens: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uses: { type: 'array', items: { type: 'string', minLength: 1 } },
        proposed: { type: 'array', items: { $ref: '#/$defs/proposedToken' } },
      },
    },
    states: { type: 'object', additionalProperties: { $ref: '#/$defs/node' } },
    a11y: { $ref: '#/$defs/a11ySurface' },
  },
  $defs: {
    copy: {
      type: 'object',
      required: ['default'],
      additionalProperties: false,
      properties: {
        key: { type: 'string', minLength: 1 },
        default: { type: 'string' },
      },
    },
    iconRef: { type: 'string', minLength: 1 },
    tokenRef: {
      type: 'object',
      required: ['token'],
      additionalProperties: false,
      properties: { token: { type: 'string', minLength: 1 } },
    },
    motion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enter: { type: 'string', enum: ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'none'] },
        exit:  { type: 'string', enum: ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'none'] },
        duration: { $ref: '#/$defs/tokenRef' },
        easing: { $ref: '#/$defs/tokenRef' },
      },
    },
    a11yNode: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string' },
        ariaLabel: { $ref: '#/$defs/copy' },
        ariaDescribedBy: { type: 'string' },
        ariaLive: { type: 'string', enum: ['off', 'polite', 'assertive'] },
        keyboardShortcut: { type: 'string' },
        focusOrder: { type: 'integer', minimum: 0 },
      },
    },
    a11ySurface: {
      type: 'object',
      additionalProperties: false,
      properties: {
        landmark: { type: 'string', enum: ['main', 'banner', 'navigation', 'complementary', 'contentinfo', 'form', 'search', 'region'] },
        headingLevel: { type: 'integer', minimum: 1, maximum: 6 },
      },
    },
    responsive: { type: 'object', additionalProperties: { type: 'object' } },
    binding: {
      type: 'object',
      required: ['slot'],
      additionalProperties: false,
      properties: {
        slot: { type: 'string', minLength: 1 },
        repeats: { type: 'boolean' },
        shape: { type: 'string', minLength: 1 },
      },
    },
    componentBinding: {
      type: 'object',
      required: ['id', 'registry'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        registry: { type: 'string', minLength: 1 },
        props: { type: 'object' },
      },
    },
    proposedToken: {
      type: 'object',
      required: ['id', 'type', 'value', 'reason'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['color', 'dimension', 'duration', 'fontFamily', 'fontWeight', 'number', 'shadow', 'cubicBezier'] },
        value: {},
        reason: { type: 'string', minLength: 1 },
      },
    },
    node: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: [
            'stack', 'grid', 'header', 'list', 'card', 'text', 'heading',
            'image', 'icon', 'button', 'link', 'input', 'textarea', 'select',
            'checkbox', 'radio', 'switch', 'badge', 'tag', 'separator',
            'spinner', 'progress', 'tooltip', 'modal', 'drawer', 'popover',
            'menu', 'tabs', 'breadcrumb', 'pagination', 'toast', 'banner',
            'empty-state', 'form', 'fieldset', 'chart', 'component', 'raw',
          ],
        },
        direction: { type: 'string', enum: ['vertical', 'horizontal'] },
        gap: { $ref: '#/$defs/tokenRef' },
        padding: { $ref: '#/$defs/tokenRef' },
        align: { type: 'string', enum: ['start', 'center', 'end', 'stretch', 'baseline'] },
        justify: { type: 'string', enum: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'] },
        children: { type: 'array', items: { $ref: '#/$defs/node' } },
        slots: { type: 'object', additionalProperties: { $ref: '#/$defs/node' } },
        title: { $ref: '#/$defs/copy' },
        copy: { $ref: '#/$defs/copy' },
        label: { $ref: '#/$defs/copy' },
        placeholder: { $ref: '#/$defs/copy' },
        icon: { $ref: '#/$defs/iconRef' },
        item: { $ref: '#/$defs/node' },
        emptyState: { $ref: '#/$defs/node' },
        interactions: { type: 'array', items: { type: 'string' } },
        ref: { type: 'string' },
        ecosystem: { type: 'string' },
        payload: {},
        spec: { type: 'object' },
        a11y: { $ref: '#/$defs/a11yNode' },
        motion: { $ref: '#/$defs/motion' },
        responsive: { $ref: '#/$defs/responsive' },
        binding: { $ref: '#/$defs/binding' },
        tokens: {
          type: 'object',
          additionalProperties: false,
          properties: { uses: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  },
};

// ─── lint rules (subset of operator's lint.ts) ─────────────────────
const DEFAULT_MAX_DEPTH = 6;
const INTERACTIVE_KINDS = new Set(['button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio', 'switch', 'menu', 'tabs']);

function walkNodes(node, prefix, visit, depth = 0) {
  if (!node) return;
  visit(node, prefix, depth);
  if (Array.isArray(node.children)) {
    node.children.forEach((c, i) => walkNodes(c, `${prefix}/children/${i}`, visit, depth + 1));
  }
  if (node.slots && typeof node.slots === 'object') {
    for (const [k, v] of Object.entries(node.slots)) walkNodes(v, `${prefix}/slots/${k}`, visit, depth + 1);
  }
  if (node.item) walkNodes(node.item, `${prefix}/item`, visit, depth + 1);
  if (node.emptyState) walkNodes(node.emptyState, `${prefix}/emptyState`, visit, depth + 1);
}

function lintIr(ir, ctx = {}) {
  const issues = [];
  const emit = (ruleId, severity, p, m) => issues.push({ ruleId, severity, path: p, message: m });
  const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_DEPTH;

  // depth
  walkNodes(ir.layout, '/layout', (_n, p, d) => {
    if (d > maxDepth) emit('max-nesting-depth', 'warning', p, `depth ${d} exceeds max ${maxDepth}`);
  });

  // unknown tokens
  if (ctx.knownTokens) {
    const known = new Set(ctx.knownTokens);
    for (const t of (ir.tokens && ir.tokens.uses) || []) {
      if (!known.has(t)) emit('unknown-token', 'error', '/tokens/uses', `unknown token "${t}"`);
    }
    walkNodes(ir.layout, '/layout', (n, p) => {
      const inline = [
        [n.gap && n.gap.token, `${p}/gap/token`],
        [n.padding && n.padding.token, `${p}/padding/token`],
      ];
      for (const [t, pp] of inline) {
        if (t && !known.has(t)) emit('unknown-token', 'error', pp, `unknown token "${t}"`);
      }
    });
  }

  // unknown components
  if (ctx.knownComponents) {
    const known = new Set(ctx.knownComponents);
    (ir.components || []).forEach((b, i) => {
      if (!known.has(b.registry)) emit('unknown-component', 'error', `/components/${i}/registry`, `unknown registry "${b.registry}"`);
    });
  }

  // orphan component bindings
  const declared = new Set((ir.components || []).map((c) => c.id));
  const referenced = new Set();
  walkNodes(ir.layout, '/layout', (n) => {
    if (n.kind === 'component' && n.ref) referenced.add(n.ref);
  });
  for (const id of declared) {
    if (!referenced.has(id)) emit('orphan-component-binding', 'warning', '/components', `"${id}" declared but unused`);
  }
  for (const id of referenced) {
    if (!declared.has(id)) emit('orphan-component-binding', 'error', '/layout', `kind="component" ref="${id}" has no binding`);
  }

  // interactive without a11y
  walkNodes(ir.layout, '/layout', (n, p) => {
    if (INTERACTIVE_KINDS.has(n.kind)) {
      const a = n.a11y || {};
      if (!a.role && !a.ariaLabel) emit('interactive-without-a11y', 'warning', p, `${n.kind} missing a11y.role or ariaLabel`);
    }
  });

  // error state w/ recovery
  const err = ir.states && ir.states.error;
  if (err) {
    let hasRecovery = false;
    walkNodes(err, '/states/error', (n) => {
      if (n.kind === 'button' || n.kind === 'link') hasRecovery = true;
      if (Array.isArray(n.interactions) && n.interactions.includes('retry')) hasRecovery = true;
    });
    if (!hasRecovery) emit('error-state-missing-recovery', 'warning', '/states/error', 'no recovery action');
  }

  // loading state aria-live
  const loading = ir.states && ir.states.loading;
  if (loading) {
    let hasLive = false;
    walkNodes(loading, '/states/loading', (n) => {
      if (n.a11y && n.a11y.ariaLive && n.a11y.ariaLive !== 'off') hasLive = true;
    });
    if (!hasLive) emit('loading-state-missing-aria-live', 'warning', '/states/loading', 'no aria-live region');
  }

  // raw escape hatch
  walkNodes(ir.layout, '/layout', (n, p) => {
    if (n.kind === 'raw') emit('raw-escape-hatch', 'warning', p, 'kind="raw" bypasses the IR abstraction');
  });

  // copy missing key
  const checkCopy = (val, p) => {
    if (val && typeof val === 'object' && 'default' in val && !('key' in val)) {
      emit('copy-missing-key', 'warning', p, 'copy has no i18n key');
    }
  };
  walkNodes(ir.layout, '/layout', (n, p) => {
    if (n.title) checkCopy(n.title, `${p}/title`);
    if (n.copy) checkCopy(n.copy, `${p}/copy`);
    if (n.label) checkCopy(n.label, `${p}/label`);
    if (n.placeholder) checkCopy(n.placeholder, `${p}/placeholder`);
    if (n.a11y && n.a11y.ariaLabel) checkCopy(n.a11y.ariaLabel, `${p}/a11y/ariaLabel`);
  });

  return issues;
}

function validateIr(ir) {
  const v = getAjv();
  const ok = v(ir);
  if (ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (v.errors || []).map((e) => ({
      path: e.instancePath || '/',
      message: e.message || 'invalid',
      keyword: e.keyword,
      params: e.params,
    })),
  };
}

// ─── DESIGN_SPEC.md fallback resolver ──────────────────────────────
function parseFrontmatter(body) {
  if (!body.startsWith('---')) return { fm: {}, rest: body };
  const end = body.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, rest: body };
  const head = body.slice(3, end).trim();
  const rest = body.slice(end + 4).replace(/^\r?\n/, '');
  const fm = {};
  let curKey = null;
  let curObj = null;
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s+/.test(raw);
    if (!indented) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, k, val] = m;
      if (val === '' || val === undefined) {
        curKey = k; curObj = {}; fm[k] = curObj;
      } else {
        fm[k] = stripQuotes(val); curKey = null; curObj = null;
      }
    } else if (curObj) {
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) curObj[m[1]] = stripQuotes(m[2]);
    }
  }
  return { fm, rest };
}
function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
async function tryRead(p) {
  try { return await fsp.readFile(p, 'utf-8'); }
  catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}
async function resolveDesignSpec(opts) {
  const filename = 'DESIGN_SPEC.md';
  const candidates = [];
  if (opts.harnessRoot) candidates.push({ layer: 'harness', path: path.join(opts.harnessRoot, filename) });
  if (opts.workspaceRoot) candidates.push({ layer: 'workspace', path: path.join(opts.workspaceRoot, filename) });
  // app default ships with the operator app. The plugin's runtime cwd
  // varies (repo root vs apps/operator/), so try both candidate roots.
  for (const root of candidateOperatorRoots()) {
    candidates.push({ layer: 'app-default', path: path.join(root, 'lib/design-spec/default.md') });
  }
  for (const c of candidates) {
    const raw = await tryRead(c.path);
    if (raw !== null) {
      const { fm, rest } = parseFrontmatter(raw);
      return { layer: c.layer, source: c.path, body: rest, frontmatter: fm };
    }
  }
  return {
    layer: 'empty', source: null, body: '', frontmatter: {},
    warning: 'no DESIGN_SPEC.md found at harness, workspace, or app-default paths',
  };
}

// ─── memos ─────────────────────────────────────────────────────────
function candidateOperatorRoots() {
  // Plugin runs from operator-host process; cwd may be the repo root or
  // the operator app dir itself. Try both.
  const cwd = process.cwd();
  return [
    path.resolve(cwd, 'apps/operator'),
    cwd, // when cwd already IS apps/operator
    path.resolve(cwd, '../../apps/operator'),
  ];
}
function candidateDocsRoots() {
  // Design memos were moved from the retired operator content tree to the
  // Starlight source tree. The plugin still runs with either the repository
  // root or apps/operator as its cwd, so resolve both forms explicitly.
  const cwd = process.cwd();
  return [...new Set([
    path.resolve(cwd, 'apps/operator-docs'),
    path.resolve(cwd, '../operator-docs'),
    cwd,
    path.resolve(cwd, '../../apps/operator-docs'),
    path.resolve(cwd, '../../operator-docs'),
  ])];
}
async function findFirstExisting(relPath, roots = candidateOperatorRoots()) {
  for (const root of roots) {
    const full = path.join(root, relPath);
    try { await fsp.access(full); return full; } catch {}
  }
  return null;
}
const MEMOS_REL = 'src/content/docs/design';
async function listMemos(filterStatus) {
  const dir = await findFirstExisting(MEMOS_REL, candidateDocsRoots());
  if (!dir) return [];
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.mdx')) continue;
    const slug = f.slice(0, -4);
    const full = path.join(dir, f);
    const raw = await tryRead(full);
    if (!raw) continue;
    const { fm } = parseFrontmatter(raw);
    const title = String(fm.title || slug);
    const status = String(fm.status || 'open');
    if (filterStatus && filterStatus !== 'any' && status !== filterStatus) continue;
    out.push({ slug, title, status, source: full });
  }
  return out;
}
async function readMemo(slug) {
  const full = await findFirstExisting(path.join(MEMOS_REL, `${slug}.mdx`), candidateDocsRoots());
  if (!full) return null;
  const raw = await tryRead(full);
  if (!raw) return null;
  const { fm, rest } = parseFrontmatter(raw);
  return { slug, source: full, body: rest, frontmatter: fm };
}

// ─── PG persistence (submit_spec) ──────────────────────────────────
async function persistSpec(workspaceId, harnessSlug, featureId, ir, metadata) {
  // Lazy require so unit-test runs that mock fs don't pull postgres-js.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postgres = require('postgres');
  const url = resolveAdminPgUrl();
  const sql = postgres(url, { max: 1, idle_timeout: 5 });
  try {
    const id = `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      await tx`
        INSERT INTO harness_shared.harness_design_artifacts
          (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES (${id}, ${harnessSlug}, ${featureId}, 'spec',
                ${tx.json(ir)}, ${tx.json(metadata || {})}, ${now})
      `;
      await tx`
        UPDATE harness_shared.harness_features_consolidated
           SET design_status  = 'accepted',
               design_spec_id = ${id},
               needs_design   = TRUE,
               updated_ts     = ${now}
         WHERE harness_slug = ${harnessSlug}
           AND feature_id   = ${featureId}
      `;
    });
    return { ok: true, specId: id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ─── component registry (mirror of packages/operator-core/lib/design-adapter-react-tailwind/registry.ts) ─
const REGISTRY_REACT_TAILWIND = [
  {
    id: 'action.primary',
    kind: 'component',
    summary: 'Primary call-to-action button',
    inputs: [
      { name: 'label', type: 'string', required: true },
      { name: 'icon', type: 'icon' },
      { name: 'disabled', type: 'boolean' },
      { name: 'loading', type: 'boolean' },
    ],
    variants: ['default', 'loading', 'disabled'],
    states: ['hover', 'focus', 'active'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Button.tsx', symbol: 'Button' },
        importHint: "import { Button } from '@/app/harness/Button'",
        propMap: { label: 'children', icon: 'leftIcon' },
      },
    },
  },
  {
    id: 'action.secondary',
    kind: 'component',
    summary: 'Secondary / ghost button',
    inputs: [
      { name: 'label', type: 'string', required: true },
      { name: 'icon', type: 'icon' },
    ],
    variants: ['ghost', 'outline'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Button.tsx', symbol: 'Button' },
        importHint: "import { Button } from '@/app/harness/Button'",
        propMap: { label: 'children' },
      },
    },
  },
  {
    id: 'control.select',
    kind: 'component',
    summary: 'Dropdown select control',
    inputs: [
      { name: 'value', type: 'string', required: true },
      { name: 'options', type: 'array<{value,label}>', required: true },
      { name: 'placeholder', type: 'string' },
    ],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Select.tsx', symbol: 'Select' },
        importHint: "import { Select } from '@/app/harness/Select'",
      },
    },
  },
  {
    id: 'control.checkbox',
    kind: 'component',
    summary: 'Checkbox',
    searchTerms: ['task', 'task-list', 'list', 'sidebar', 'completion', 'toggle'],
    inputs: [
      { name: 'checked', type: 'boolean', required: true },
      { name: 'label', type: 'string' },
    ],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Checkbox.tsx', symbol: 'Checkbox' },
        importHint: "import { Checkbox } from '@/app/harness/Checkbox'",
      },
    },
  },
  {
    id: 'control.text',
    kind: 'component',
    summary: 'Text input with optional leading and trailing slots',
    searchTerms: ['task', 'task-list', 'list', 'sidebar', 'search', 'filter'],
    inputs: [
      { name: 'value', type: 'string', required: true },
      { name: 'placeholder', type: 'string' },
      { name: 'leading', type: 'ReactNode' },
      { name: 'trailing', type: 'ReactNode' },
    ],
    variants: ['plain', 'leading-slot', 'trailing-slot'],
    states: ['focus', 'disabled'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'libs/generic/ui-primitives/src/controls/TextInput.tsx', symbol: 'TextInput' },
        importHint: "import { TextInput } from '@papercusp/ui-primitives/controls'",
      },
    },
  },
  {
    id: 'control.theme',
    kind: 'component',
    summary: 'Controlled or locally persisted semantic theme segmented switcher',
    searchTerms: ['theme', 'light', 'dark', 'system', 'segmented', 'toggle'],
    inputs: [
      { name: 'themes', type: 'ThemeOption[]', required: true },
      { name: 'value', type: 'string' },
      { name: 'onChange', type: '(id:string)=>void' },
    ],
    variants: ['controlled-account', 'local-persisted'],
    states: ['light', 'dark', 'system'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'libs/generic/ui-primitives/src/theme/ThemeSwitcher.tsx', symbol: 'ThemeSwitcher' },
        importHint: "import { ThemeSwitcher } from '@papercusp/ui-primitives/theme'",
      },
    },
  },
  {
    id: 'feedback.tooltip',
    kind: 'component',
    summary: 'Hover/focus tooltip for buttons, labels, and compact controls',
    searchTerms: ['task', 'task-list', 'list', 'sidebar', 'compact', 'action'],
    inputs: [
      { name: 'label', type: 'ReactNode', required: true },
      { name: 'children', type: 'ReactNode', required: true },
      { name: 'side', type: '"top"|"right"|"bottom"|"left"' },
    ],
    states: ['hover', 'focus'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Tooltip.tsx', symbol: 'Tooltip' },
        importHint: "import { Tooltip } from '@/app/harness/Tooltip'",
      },
    },
  },
  {
    id: 'overlay.modal',
    kind: 'component',
    summary: 'Centered modal dialog with Radix focus and escape handling',
    inputs: [
      { name: 'open', type: 'boolean', required: true },
      { name: 'onOpenChange', type: '(open:boolean)=>void', required: true },
      { name: 'title', type: 'string', required: true },
      { name: 'children', type: 'ReactNode', required: true },
    ],
    variants: ['default', 'srOnlyTitle', 'custom-z-index'],
    states: ['open', 'closed'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Modal.tsx', symbol: 'Modal' },
        importHint: "import { Modal } from '@/app/harness/Modal'",
      },
    },
  },
  {
    id: 'overlay.popover',
    kind: 'component',
    summary: 'Anchored popover panel for stable React trigger-owned dropdowns',
    searchTerms: ['task', 'task-list', 'list', 'sidebar', 'menu', 'actions'],
    inputs: [
      { name: 'open', type: 'boolean', required: true },
      { name: 'onOpenChange', type: '(open:boolean)=>void', required: true },
      { name: 'trigger', type: 'ReactNode', required: true },
      { name: 'ariaLabel', type: 'string', required: true },
    ],
    variants: ['bottom-end', 'with-tooltip', 'no-autofocus'],
    states: ['open', 'closed'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/harness/Popover.tsx', symbol: 'Popover' },
        importHint: "import { Popover } from '@/app/harness/Popover'",
      },
    },
  },
  {
    id: 'feedback.banner',
    kind: 'component',
    summary: 'Inline banner for status/error/success messages',
    inputs: [
      { name: 'tone', type: '"info"|"warning"|"error"|"success"' },
      { name: 'children', type: 'ReactNode', required: true },
    ],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'apps/operator/app/_components/HostCheckBanner.tsx', symbol: 'HostCheckBanner' },
        importHint: "import { HostCheckBanner } from '@/app/_components/HostCheckBanner'",
      },
    },
  },
  {
    id: 'data.rich-grid',
    kind: 'component',
    summary: 'Virtualizable React grid for rows with JSX cells, status pills, actions, and expansion',
    searchTerms: ['task', 'task-list', 'list', 'sidebar', 'rows'],
    inputs: [
      { name: 'rows', type: 'Row[]', required: true },
      { name: 'columns', type: 'ColumnDef<Row>[]', required: true },
      { name: 'getRowId', type: '(row: Row) => string', required: true },
    ],
    variants: ['default', 'virtual', 'expandable'],
    ecosystems: {
      'react-tailwind': {
        sourcePointer: { path: 'libs/generic/papergrid/grid-core/src/RichGrid.tsx', symbol: 'RichGrid' },
        importHint: "import { RichGrid } from '@papercusp/grid-core'",
      },
    },
  },
];

const REGISTRIES_BY_ECOSYSTEM = {
  'react-tailwind': REGISTRY_REACT_TAILWIND,
};

function searchRegistryEntries(ecosystem, query) {
  const list = REGISTRIES_BY_ECOSYSTEM[ecosystem] || [];
  if (!query || !query.trim()) return list;

  // Treat query as free text rather than one literal substring. Designers
  // commonly include the product surface in the query (for example,
  // "Seller dock controls"), even though the registry only contains the
  // reusable primitive name ("control"). Match at token boundaries with a
  // prefix check so singular/plural forms and partial terms still work.
  const tokenize = (value) => String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const entryTokens = (e) => tokenize([
    e.id,
    e.summary,
    ...(e.searchTerms || []),
    ...(e.inputs || []).map((input) => input.name),
  ].join(' '));
  const entriesWithTokens = list.map((entry) => ({ entry, tokens: entryTokens(entry) }));
  const queryTokens = tokenize(query);
  const matchesToken = (queryToken, token) => (
    token.startsWith(queryToken) || queryToken.startsWith(token)
  );

  // Ignore contextual words that have no registry vocabulary ("Seller" and
  // "dock" above), but require every recognized term. This keeps a focused
  // query such as "primary button" precise while still returning controls
  // for a product-level query whose only registry term is "controls".
  const recognizedTokens = queryTokens.filter((queryToken) => (
    entriesWithTokens.some(({ tokens }) => tokens.some((token) => matchesToken(queryToken, token)))
  ));
  if (recognizedTokens.length === 0) return [];

  return entriesWithTokens
    .filter(({ tokens }) => recognizedTokens.every((queryToken) => (
      tokens.some((token) => matchesToken(queryToken, token))
    )))
    .map(({ entry }) => entry);
}

// ─── tool handlers ─────────────────────────────────────────────────
async function validate_spec(input) {
  if (!input || typeof input.ir !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'validate_spec: input.ir (object) is required' }] };
  }
  const r = validateIr(input.ir);
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

async function lint_spec(input) {
  if (!input || typeof input.ir !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'lint_spec: input.ir (object) is required' }] };
  }
  const issues = lintIr(input.ir, {
    knownTokens: input.knownTokens,
    knownComponents: input.knownComponents,
    knownIcons: input.knownIcons,
    maxDepth: input.maxDepth,
  });
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.length - errorCount;
  return { content: [{ type: 'text', text: JSON.stringify({ issues, errorCount, warnCount }, null, 2) }] };
}

async function submit_spec(input, ctx) {
  if (!input || typeof input.featureId !== 'string' || typeof input.ir !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'submit_spec: input.featureId (string) and input.ir (object) are required' }] };
  }
  const v = validateIr(input.ir);
  if (!v.ok) {
    return { isError: true, content: [{ type: 'text', text: `submit_spec: validation failed\n${JSON.stringify(v.errors, null, 2)}` }] };
  }
  const issues = lintIr(input.ir);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return { isError: true, content: [{ type: 'text', text: `submit_spec: lint errors block acceptance\n${JSON.stringify(errors, null, 2)}` }] };
  }
  ctx.progress(50, 'persisting');
  const result = await persistSpec(ctx.workspaceId, ctx.harnessSlug, input.featureId, input.ir, input.metadata);
  ctx.progress(100, 'done');
  return { content: [{ type: 'text', text: JSON.stringify({ ...result, lintWarnings: issues }, null, 2) }] };
}

async function list_memos(input) {
  const memos = await listMemos(input && input.status);
  return { content: [{ type: 'text', text: JSON.stringify(memos, null, 2) }] };
}

async function read_memo(input) {
  if (!input || typeof input.slug !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'read_memo: input.slug (string) is required' }] };
  }
  const memo = await readMemo(input.slug);
  if (!memo) return { isError: true, content: [{ type: 'text', text: `memo "${input.slug}" not found` }] };
  return { content: [{ type: 'text', text: JSON.stringify(memo, null, 2) }] };
}

async function get_design_spec(input, ctx) {
  const harnessRoot = (input && input.harnessRoot) || ctx.projectDir;
  const workspaceRoot = (input && input.workspaceRoot) || process.cwd();
  const r = await resolveDesignSpec({ harnessRoot, workspaceRoot });
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

const TOKEN_HELPERS = require('./tokens.cjs');

async function list_tokens(input) {
  const r = await TOKEN_HELPERS.listTokens(input && input.category);
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

async function read_token(input) {
  if (!input || typeof input.id !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'read_token: input.id (string) is required' }] };
  }
  const tok = await TOKEN_HELPERS.readToken(input.id);
  if (!tok) {
    return { isError: true, content: [{ type: 'text', text: 'token "' + input.id + '" not found' }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(tok, null, 2) }] };
}

async function get_accepted_spec(input, ctx) {
  if (!input || typeof input.featureId !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'get_accepted_spec: input.featureId (string) is required' }] };
  }
  const postgres = require('postgres');
  const url = resolveAdminPgUrl();
  const sql = postgres(url, { max: 1, idle_timeout: 5 });
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      // Resolve the accepted spec via design_spec_id pointer on the feature.
      return await tx`
        SELECT a.id, a.payload, a.metadata, a.created_ts
          FROM harness_shared.harness_features_consolidated f
          JOIN harness_shared.harness_design_artifacts a
            ON a.harness_slug = f.harness_slug AND a.id = f.design_spec_id
         WHERE f.harness_slug = ${ctx.harnessSlug}
           AND f.feature_id   = ${input.featureId}
           AND a.kind         = 'spec'
         LIMIT 1
      `;
    });
    if (rows.length === 0) {
      return { isError: true, content: [{ type: 'text', text: `no accepted spec for feature ${input.featureId}` }] };
    }
    const r = rows[0];
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          specId: r.id,
          ir: r.payload,
          metadata: r.metadata,
          createdTs: r.created_ts == null ? null : Number(r.created_ts),
        }, null, 2),
      }],
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const REVIEW_VERDICTS = new Set(['approved', 'rejected', 'changes-requested']);

async function record_review(input, ctx) {
  if (!input || typeof input.featureId !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'record_review: input.featureId (string) is required' }] };
  }
  if (!REVIEW_VERDICTS.has(input.verdict)) {
    return { isError: true, content: [{ type: 'text', text: `record_review: input.verdict must be one of ${[...REVIEW_VERDICTS].join('|')}` }] };
  }
  const postgres = require('postgres');
  const url = resolveAdminPgUrl();
  const sql = postgres(url, { max: 1, idle_timeout: 5 });
  try {
    const id = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const reviewPayload = {
      verdict: input.verdict,
      notes: typeof input.notes === 'string' ? input.notes : null,
      reviewedSpecId: typeof input.specId === 'string' ? input.specId : null,
    };
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
      await tx`
        INSERT INTO harness_shared.harness_design_artifacts
          (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES (${id}, ${ctx.harnessSlug}, ${input.featureId}, 'review',
                ${tx.json(reviewPayload)}, ${tx.json({ source: 'reviewer-agent' })}, ${now})
      `;
      // Approved keeps design_status=accepted (terminal-ok).
      // Rejected and changes-requested flip back to 'pending' so the
      // orchestrator's spawn loop re-spawns a designer with the verdict
      // notes as new input. Plan §4.2.
      if (input.verdict !== 'approved') {
        await tx`
          UPDATE harness_shared.harness_features_consolidated
             SET design_status   = 'pending',
                 design_spec_id  = NULL,
                 updated_ts      = ${now}
           WHERE harness_slug = ${ctx.harnessSlug}
             AND feature_id   = ${input.featureId}
        `;
      }
    });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          reviewId: id,
          verdict: input.verdict,
          designStatusAfter: input.verdict === 'approved' ? 'accepted' : 'pending',
        }, null, 2),
      }],
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function search_registry(input) {
  const ecosystem = (input && input.ecosystem) || 'react-tailwind';
  const query = (input && input.query) || '';
  const results = searchRegistryEntries(ecosystem, query);
  const isBundledEcosystem = Object.prototype.hasOwnProperty.call(REGISTRIES_BY_ECOSYSTEM, ecosystem);
  // This registry is an in-memory bundled source. An empty match is therefore
  // an authoritative answer, even when the MCP proxy is reporting a recent
  // upstream retry; expose that contract so the transport can avoid a false
  // data-plane degradation warning.
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ecosystem,
        results,
        ...(isBundledEcosystem ? { authoritative: true } : {}),
      }, null, 2),
    }],
  };
}

async function get_registry_component(input) {
  if (!input || typeof input.id !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'get_registry_component: input.id (string) is required' }] };
  }
  const ecosystem = input.ecosystem || 'react-tailwind';
  const list = REGISTRIES_BY_ECOSYSTEM[ecosystem] || [];
  const entry = list.find((e) => e.id === input.id);
  if (!entry) {
    return { isError: true, content: [{ type: 'text', text: `component "${input.id}" not in ${ecosystem} registry` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(entry, null, 2) }] };
}

// ─── design-compare bridge (plan P-006, D-017) ──────────────────────────────
//
// The mockup-to-implementation comparison engine lives in the OPERATOR
// (packages/operator-core/lib/design-compare/*.ts), not here. This plugin does
// not — and must not — require it: D-017 measured that a CommonJS require of
// those modules fails under plain node (constructor parameter properties;
// extensionless relative specifiers) and succeeds only because the operator
// host happens to run under tsx. Depending on that would make the production
// path untestable and one refactor away from breaking.
//
// So the host PUBLISHES its verb surface into a slot pinned on `globalThis`,
// and this reads it. The only thing crossing the boundary is
// `@papercusp/module-singleton`, which requires cleanly under both runtimes.
//
// The KEY IS DUPLICATED between here and host-registry.ts's
// DESIGN_COMPARE_HOST_SLOT — unavoidably, since the whole point is that neither
// side imports the other. `design-compare-plugin-bridge.test.ts` asserts the two
// literals are equal, so they cannot drift apart into a silent no-rendezvous.
const DESIGN_COMPARE_HOST_SLOT = '@papercusp/design-compare.host';

/**
 * Read the installed verb surface for a harness, or null.
 *
 * Null is a real answer: a standalone papercusp install has no operator, so
 * there is no engine and these verbs cannot run. Every caller below turns that
 * into a loud refusal and NEVER into a comparison verdict — an absent engine is
 * a host misconfiguration, not evidence about a render.
 */
function readDesignCompareVerbs(harnessSlug) {
  let pinModuleState;
  try {
    ({ pinModuleState } = require('@papercusp/module-singleton'));
  } catch {
    return null;
  }
  if (typeof pinModuleState !== 'function') return null;
  const slot = pinModuleState(DESIGN_COMPARE_HOST_SLOT, () => ({ verbs: new Map() }));
  if (!slot || !(slot.verbs instanceof Map)) return null;
  return slot.verbs.get(harnessSlug) || null;
}

function engineUnavailable(verb, harnessSlug) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        code: 'engine-unavailable',
        detail:
          `${verb}: no design-compare engine is installed for harness '${harnessSlug}'. This verb is ` +
          'backed by the operator\'s comparison adapter, which publishes itself at boot; a standalone ' +
          'papercusp install does not have one. No comparison was attempted, so no verdict is reported.',
      }, null, 2),
    }],
  };
}

/**
 * Who the host says is calling.
 *
 * Read from `ctx`, never from tool input. `ratify_reference` writes this into
 * immutable provenance, and a principal a caller can name for itself is not a
 * principal. There is deliberately no input field to override it.
 */
function callerFrom(ctx) {
  return { actorId: (ctx && ctx.spawnId) || '', role: (ctx && ctx.role) || 'unknown' };
}

function requireStrings(verb, input, keys) {
  for (const k of keys) {
    if (!input || typeof input[k] !== 'string' || input[k].length === 0) {
      return `${verb}: input.${k} (non-empty string) is required`;
    }
  }
  return null;
}

/** Shape a verb outcome as a tool result. A refusal is an error; an `invalid` verdict is not. */
function verbResult(outcome) {
  return {
    ...(outcome && outcome.ok === false ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
  };
}

async function ratify_reference(input, ctx) {
  const bad = requireStrings('ratify_reference', input, ['featureId', 'referenceId', 'contentSha256']);
  if (bad) return { isError: true, content: [{ type: 'text', text: bad }] };
  const verbs = readDesignCompareVerbs(ctx.harnessSlug);
  if (!verbs) return engineUnavailable('ratify_reference', ctx.harnessSlug);
  return verbResult(await verbs.ratifyReference(input, callerFrom(ctx)));
}

async function compare_render(input, ctx) {
  const bad = requireStrings('compare_render', input, [
    'featureId', 'referenceId', 'actualImagePath', 'diffImagePath',
  ]);
  if (bad) return { isError: true, content: [{ type: 'text', text: bad }] };
  const verbs = readDesignCompareVerbs(ctx.harnessSlug);
  if (!verbs) return engineUnavailable('compare_render', ctx.harnessSlug);
  return verbResult(await verbs.compareRender(input, callerFrom(ctx)));
}

async function get_design_evidence(input, ctx) {
  const bad = requireStrings('get_design_evidence', input, ['featureId', 'referenceId']);
  if (bad) return { isError: true, content: [{ type: 'text', text: bad }] };
  const verbs = readDesignCompareVerbs(ctx.harnessSlug);
  if (!verbs) return engineUnavailable('get_design_evidence', ctx.harnessSlug);
  return verbResult(await verbs.getDesignEvidence(input, callerFrom(ctx)));
}

const tools = {
  validate_spec,
  lint_spec,
  submit_spec,
  list_memos,
  read_memo,
  get_design_spec,
  search_registry,
  get_registry_component,
  list_tokens,
  read_token,
  get_accepted_spec,
  record_review,
  ratify_reference,
  compare_render,
  get_design_evidence,
};

const plugin = {
  name: '@papercupai/design-phase',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'MCP + HTTP tools for the design-phase agent loop.',
  capabilities: [
    'tools:design:validate_spec',
    'tools:design:lint_spec',
    'tools:design:submit_spec',
    'tools:design:list_memos',
    'tools:design:read_memo',
    'tools:design:get_design_spec',
    'tools:design:search_registry',
    'tools:design:get_registry_component',
    'tools:design:list_tokens',
    'tools:design:read_token',
    'tools:design:get_accepted_spec',
    'tools:design:record_review',
    'tools:design:ratify_reference',
    'tools:design:compare_render',
    'tools:design:get_design_evidence',
    'fs:read:design_memos',
    'fs:read:design_tokens',
    'db:write:harness_design_artifacts',
    'db:write:harness_features_consolidated',
  ],
  tools,
};

module.exports = plugin;
module.exports.default = plugin;
// expose internals for in-process tests
module.exports._internal = {
  validateIr,
  lintIr,
  parseFrontmatter,
  resolveDesignSpec,
  listMemos,
  readMemo,
  resolveAdminPgUrl,
  // P-006 bridge. Exposed so a test can assert the KEY matches the host's
  // constant and that resolution actually reaches the pinned slot — the
  // rendezvous is the part that fails silently if it is wrong.
  DESIGN_COMPARE_HOST_SLOT,
  readDesignCompareVerbs,
};
