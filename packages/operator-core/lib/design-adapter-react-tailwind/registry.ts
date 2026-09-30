/**
 * React + Tailwind registry surface.
 *
 * v0.1 ships a hand-curated set of primitives mapping the most-used
 * live operator wrappers. The full TS-prop-extractor (using
 * ts-morph or the TS compiler API) is intentionally deferred — getting
 * to a working end-to-end loop matters more than auto-extraction
 * accuracy for the v0.1 milestone.
 *
 * Future: replace `HANDCURATED` with a scanner that walks
 * `sourcePaths`, parses TSX, infers props from interfaces / FC<P>
 * signatures, and captures Storybook screenshots as examples.
 */
import type { RegistryEntry, RegistrySurface, SourcePointer } from '../design-adapter';

const ECOSYSTEM = 'react-tailwind';
const LIVE_HARNESS = 'apps/operator/app/harness';

const HANDCURATED: RegistryEntry[] = [
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Button.tsx`, symbol: 'Button' },
        importHint: "import { Button } from '@/app/harness/Button'",
        propMap: { label: 'children' },
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Button.tsx`, symbol: 'Button' },
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Select.tsx`, symbol: 'Select' },
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Checkbox.tsx`, symbol: 'Checkbox' },
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
      [ECOSYSTEM]: {
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
      [ECOSYSTEM]: {
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Tooltip.tsx`, symbol: 'Tooltip' },
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Modal.tsx`, symbol: 'Modal' },
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
      [ECOSYSTEM]: {
        sourcePointer: { path: `${LIVE_HARNESS}/Popover.tsx`, symbol: 'Popover' },
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
      [ECOSYSTEM]: {
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
      [ECOSYSTEM]: {
        sourcePointer: { path: 'libs/generic/papergrid/grid-core/src/RichGrid.tsx', symbol: 'RichGrid' },
        importHint: "import { RichGrid } from '@papercusp/grid-core'",
      },
    },
  },
];

export function makeReactTailwindRegistry(opts: { sourcePaths: string[] }): RegistrySurface {
  return {
    sourcePaths: opts.sourcePaths,
    async listPrimitives() {
      return HANDCURATED;
    },
    async sourceFor(id: string): Promise<SourcePointer | null> {
      const e = HANDCURATED.find((r) => r.id === id);
      return e?.ecosystems[ECOSYSTEM]?.sourcePointer ?? null;
    },
  };
}

/** Test-only export of the curated set for round-trip + integration tests. */
export const _CURATED_FOR_TESTS = HANDCURATED;

/**
 * The RETIRED `@papercusp/ui` package, matched at a package boundary.
 *
 * The trailing `(?![\w-])` is load-bearing and must not be simplified back to a plain
 * `.includes('@papercusp/ui')`: the LIVE `@papercusp/ui-primitives` package — which the
 * curated registry deliberately points implementers at — contains that string as a prefix,
 * so a substring test reports the live primitives package as retired UI (WI-1222525). This
 * still matches '@papercusp/ui' and '@papercusp/ui/anything'.
 *
 * Exported so the registry and code-emit guards share ONE definition; two copies of a
 * lookahead this subtle drift apart the first time the retired name changes.
 */
export const RETIRED_UI_IMPORT = /@papercusp\/ui(?![\w-])/;
