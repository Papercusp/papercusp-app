/**
 * UI IR v0.1 — JSON Schema.
 *
 * The design-phase intermediate representation. Designer agents emit
 * this; ecosystem adapters consume it. Plan: §7 of
 * apps/operator-docs/src/content/docs/design/design-phase-plan.mdx.
 *
 * v0.x is explicitly unstable — breaking changes likely until v1.0.
 * Lock criteria: ≥2 production adapters consuming for ≥1 month
 * without breaking changes.
 */

export const IR_VERSION = '0.1';

/**
 * The top-level schema. Sub-schemas are inlined via $defs so a single
 * `validate(spec)` call covers the whole document.
 */
export const uiIrSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://papercusp.dev/schemas/ui-ir/v0.1.json',
  title: 'UI IR',
  description: 'Ecosystem-agnostic UI intermediate representation, v0.1',
  type: 'object',
  required: ['irVersion', 'surface', 'ecosystem', 'layout'],
  additionalProperties: false,
  properties: {
    irVersion: { type: 'string', pattern: '^0\\.[0-9]+$' },
    surface: { type: 'string', minLength: 1 },
    ecosystem: { type: 'string', minLength: 1 },
    layout: { $ref: '#/$defs/node' },
    components: {
      type: 'array',
      items: { $ref: '#/$defs/componentBinding' },
    },
    tokens: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uses: { type: 'array', items: { type: 'string', minLength: 1 } },
        proposed: {
          type: 'array',
          items: { $ref: '#/$defs/proposedToken' },
        },
      },
    },
    states: {
      type: 'object',
      additionalProperties: { $ref: '#/$defs/node' },
    },
    a11y: { $ref: '#/$defs/a11ySurface' },
  },
  $defs: {
    /**
     * A copy node — every user-facing string in IR uses this shape so i18n
     * is trivial later. Adapters without i18n treat `default` as literal.
     */
    copy: {
      type: 'object',
      required: ['default'],
      additionalProperties: false,
      properties: {
        key: { type: 'string', minLength: 1 },
        default: { type: 'string' },
      },
    },

    /** A reference into the registry's icon sub-set. */
    iconRef: {
      type: 'string',
      minLength: 1,
    },

    /** A token reference. Must resolve in the active DTCG store. */
    tokenRef: {
      type: 'object',
      required: ['token'],
      additionalProperties: false,
      properties: {
        token: { type: 'string', minLength: 1 },
      },
    },

    /** A motion declaration on a node. */
    motion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enter: {
          type: 'string',
          enum: ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'none'],
        },
        exit: {
          type: 'string',
          enum: ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'none'],
        },
        duration: { $ref: '#/$defs/tokenRef' },
        easing: { $ref: '#/$defs/tokenRef' },
      },
    },

    /** Per-element a11y. */
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

    /** Surface-level a11y — landmark / heading depth. */
    a11ySurface: {
      type: 'object',
      additionalProperties: false,
      properties: {
        landmark: {
          type: 'string',
          enum: ['main', 'banner', 'navigation', 'complementary', 'contentinfo', 'form', 'search', 'region'],
        },
        headingLevel: { type: 'integer', minimum: 1, maximum: 6 },
      },
    },

    /** Responsive overrides keyed by viewport-token name. */
    responsive: {
      type: 'object',
      additionalProperties: { type: 'object' }, // partial node override; relaxed in v0.x
    },

    /** Data-binding hint for nodes that render dynamic data. */
    binding: {
      type: 'object',
      required: ['slot'],
      additionalProperties: false,
      properties: {
        slot: { type: 'string', minLength: 1 },
        repeats: { type: 'boolean' },
        shape: { type: 'string', minLength: 1 }, // named type the impl maps to its data layer
      },
    },

    /** A reference to a registry component instance. */
    componentBinding: {
      type: 'object',
      required: ['id', 'registry'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        registry: { type: 'string', minLength: 1 }, // semantic registry id, e.g., "action.primary"
        props: { type: 'object' }, // adapter validates against registry entry
      },
    },

    /** A proposed-but-not-yet-accepted DTCG token. */
    proposedToken: {
      type: 'object',
      required: ['id', 'type', 'value', 'reason'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['color', 'dimension', 'duration', 'fontFamily', 'fontWeight', 'number', 'shadow', 'cubicBezier'] },
        value: {}, // type-dependent; adapter validates per DTCG
        reason: { type: 'string', minLength: 1 },
      },
    },

    /** The recursive node type — every layout/widget element. */
    node: {
      type: 'object',
      required: ['kind'],
      properties: {
        kind: {
          type: 'string',
          // OpenUI-aligned vocabulary; expand as needed in v0.x.
          enum: [
            'stack',
            'grid',
            'header',
            'list',
            'card',
            'text',
            'heading',
            'image',
            'icon',
            'button',
            'link',
            'input',
            'textarea',
            'select',
            'checkbox',
            'radio',
            'switch',
            'badge',
            'tag',
            'separator',
            'spinner',
            'progress',
            'tooltip',
            'modal',
            'drawer',
            'popover',
            'menu',
            'tabs',
            'breadcrumb',
            'pagination',
            'toast',
            'banner',
            'empty-state',
            'form',
            'fieldset',
            'chart',
            'component',  // refers to an entry in `components`
            'raw',        // ecosystem-native escape hatch (lint-warned)
          ],
        },

        // Stack/grid layout
        direction: { type: 'string', enum: ['vertical', 'horizontal'] },
        gap: { $ref: '#/$defs/tokenRef' },
        padding: { $ref: '#/$defs/tokenRef' },
        align: { type: 'string', enum: ['start', 'center', 'end', 'stretch', 'baseline'] },
        justify: { type: 'string', enum: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'] },

        // Container children
        children: { type: 'array', items: { $ref: '#/$defs/node' } },

        // Single-slot containers
        slots: {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/node' },
        },

        // Common content
        title: { $ref: '#/$defs/copy' },
        copy: { $ref: '#/$defs/copy' },
        label: { $ref: '#/$defs/copy' },
        placeholder: { $ref: '#/$defs/copy' },
        icon: { $ref: '#/$defs/iconRef' },

        // List/grid items
        item: { $ref: '#/$defs/node' },
        emptyState: { $ref: '#/$defs/node' },

        // Interactions (declared by name; adapter binds)
        interactions: {
          type: 'array',
          items: { type: 'string' },
        },

        // Component reference (when kind == "component")
        ref: { type: 'string' }, // matches a `components[].id`

        // Raw escape hatch (when kind == "raw")
        ecosystem: { type: 'string' },
        payload: {}, // ecosystem-native; adapter handles

        // Chart escape hatch (when kind == "chart")
        spec: { type: 'object' }, // Plotly JSON; not validated here

        // Cross-cutting
        a11y: { $ref: '#/$defs/a11yNode' },
        motion: { $ref: '#/$defs/motion' },
        responsive: { $ref: '#/$defs/responsive' },
        binding: { $ref: '#/$defs/binding' },
        tokens: {
          type: 'object',
          additionalProperties: false,
          properties: {
            uses: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      // Required-by-kind constraints handled in lint, not schema, since
      // JSON Schema's allOf-by-discriminator is verbose and error
      // messages are worse.
      additionalProperties: false,
    },
  },
} as const;

/** Lightly-typed handle for IR documents. Schema is the source of truth. */
export interface UiIr {
  irVersion: string;
  surface: string;
  ecosystem: string;
  layout: UiNode;
  components?: ComponentBinding[];
  tokens?: { uses?: string[]; proposed?: ProposedToken[] };
  states?: Record<string, UiNode>;
  a11y?: { landmark?: string; headingLevel?: number };
}

export interface UiNode {
  kind: string;
  direction?: 'vertical' | 'horizontal';
  gap?: { token: string };
  padding?: { token: string };
  align?: string;
  justify?: string;
  children?: UiNode[];
  slots?: Record<string, UiNode>;
  title?: Copy;
  copy?: Copy;
  label?: Copy;
  placeholder?: Copy;
  icon?: string;
  item?: UiNode;
  emptyState?: UiNode;
  interactions?: string[];
  ref?: string;
  ecosystem?: string;
  payload?: unknown;
  spec?: object;
  a11y?: A11yNode;
  motion?: Motion;
  responsive?: Record<string, Partial<UiNode>>;
  binding?: { slot: string; repeats?: boolean; shape?: string };
  tokens?: { uses?: string[] };
}

export interface Copy {
  default: string;
  key?: string;
}

export interface ComponentBinding {
  id: string;
  registry: string;
  props?: Record<string, unknown>;
}

export interface ProposedToken {
  id: string;
  type: 'color' | 'dimension' | 'duration' | 'fontFamily' | 'fontWeight' | 'number' | 'shadow' | 'cubicBezier';
  value: unknown;
  reason: string;
}

export interface A11yNode {
  role?: string;
  ariaLabel?: Copy;
  ariaDescribedBy?: string;
  ariaLive?: 'off' | 'polite' | 'assertive';
  keyboardShortcut?: string;
  focusOrder?: number;
}

export interface Motion {
  enter?: string;
  exit?: string;
  duration?: { token: string };
  easing?: { token: string };
}
