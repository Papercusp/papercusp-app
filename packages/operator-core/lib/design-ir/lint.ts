/**
 * UI IR linter — anti-pattern checks for *good* IR (vs validator's check
 * for *valid* IR). See plan §7.15.
 *
 * Lint rules are registered in `RULES` below. Each returns issues with
 * severity {error, warning}. Errors block acceptance; warnings flow into
 * the design-crit prompt.
 */
import type { UiIr, UiNode } from './schema';

export type Severity = 'error' | 'warning';

export interface LintIssue {
  ruleId: string;
  severity: Severity;
  path: string;
  message: string;
}

export interface LintContext {
  /** Known token IDs in the active DTCG store. */
  knownTokens?: ReadonlySet<string>;
  /** Known component registry IDs. */
  knownComponents?: ReadonlySet<string>;
  /** Known icon IDs. */
  knownIcons?: ReadonlySet<string>;
  /** Maximum allowed nesting depth. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 6;

interface Rule {
  id: string;
  check(ir: UiIr, ctx: LintContext, emit: (issue: Omit<LintIssue, 'ruleId'>) => void): void;
}

function walkNodes(
  root: UiNode | undefined,
  pathPrefix: string,
  visit: (node: UiNode, path: string, depth: number) => void,
  depth = 0,
): void {
  if (!root) return;
  visit(root, pathPrefix, depth);
  if (root.children) {
    root.children.forEach((c, i) => walkNodes(c, `${pathPrefix}/children/${i}`, visit, depth + 1));
  }
  if (root.slots) {
    for (const [k, v] of Object.entries(root.slots)) {
      walkNodes(v, `${pathPrefix}/slots/${k}`, visit, depth + 1);
    }
  }
  if (root.item) walkNodes(root.item, `${pathPrefix}/item`, visit, depth + 1);
  if (root.emptyState) walkNodes(root.emptyState, `${pathPrefix}/emptyState`, visit, depth + 1);
}

const RULES: Rule[] = [
  // -------------------------------------------------------------------
  // structural
  // -------------------------------------------------------------------
  {
    id: 'max-nesting-depth',
    check(ir, ctx, emit) {
      const max = ctx.maxDepth ?? DEFAULT_MAX_DEPTH;
      walkNodes(ir.layout, '/layout', (_n, path, depth) => {
        if (depth > max) {
          emit({
            severity: 'warning',
            path,
            message: `nesting depth ${depth} exceeds max ${max}; flatten the layout`,
          });
        }
      });
    },
  },

  // -------------------------------------------------------------------
  // tokens
  // -------------------------------------------------------------------
  {
    id: 'unknown-token',
    check(ir, ctx, emit) {
      const known = ctx.knownTokens;
      if (!known) return; // can't check without context
      const used = new Set<string>(ir.tokens?.uses ?? []);
      walkNodes(ir.layout, '/layout', (n, path) => {
        if (n.gap?.token) used.add(n.gap.token);
        if (n.padding?.token) used.add(n.padding.token);
        if (n.tokens?.uses) for (const t of n.tokens.uses) used.add(t);
        if (n.motion?.duration?.token) used.add(n.motion.duration.token);
        if (n.motion?.easing?.token) used.add(n.motion.easing.token);
        // referenced inline tokens must resolve
        const inlineRefs: Array<[string | undefined, string]> = [
          [n.gap?.token, `${path}/gap/token`],
          [n.padding?.token, `${path}/padding/token`],
          [n.motion?.duration?.token, `${path}/motion/duration/token`],
          [n.motion?.easing?.token, `${path}/motion/easing/token`],
        ];
        for (const [t, p] of inlineRefs) {
          if (t && !known.has(t)) {
            emit({
              severity: 'error',
              path: p,
              message: `unknown token "${t}" — not in DTCG store; declare in tokens.proposed if intentional`,
            });
          }
        }
      });
      // surface-level tokens.uses must also resolve
      for (const t of ir.tokens?.uses ?? []) {
        if (!known.has(t)) {
          emit({
            severity: 'error',
            path: '/tokens/uses',
            message: `unknown token "${t}"`,
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------
  // components
  // -------------------------------------------------------------------
  {
    id: 'unknown-component',
    check(ir, ctx, emit) {
      const known = ctx.knownComponents;
      if (!known) return;
      ir.components?.forEach((b, i) => {
        if (!known.has(b.registry)) {
          emit({
            severity: 'error',
            path: `/components/${i}/registry`,
            message: `unknown registry component "${b.registry}"`,
          });
        }
      });
    },
  },

  {
    id: 'orphan-component-binding',
    check(ir, _ctx, emit) {
      const declared = new Set((ir.components ?? []).map((c) => c.id));
      const referenced = new Set<string>();
      const collectRefs = (root: UiNode | undefined, pathPrefix: string) => {
        walkNodes(root, pathPrefix, (n) => {
          if (n.kind === 'component' && n.ref) referenced.add(n.ref);
        });
      };
      collectRefs(ir.layout, '/layout');
      for (const [stateName, stateRoot] of Object.entries(ir.states ?? {})) {
        collectRefs(stateRoot, `/states/${stateName}`);
      }
      for (const id of declared) {
        if (!referenced.has(id)) {
          // warning, not error: pre-declaring components for later use is OK
          emit({
            severity: 'warning',
            path: `/components`,
            message: `component "${id}" declared but never referenced from layout or state roots`,
          });
        }
      }
      for (const id of referenced) {
        if (!declared.has(id)) {
          emit({
            severity: 'error',
            path: `/layout`,
            message: `kind="component" with ref="${id}" but no matching components[].id`,
          });
        }
      }
    },
  },

  // -------------------------------------------------------------------
  // icons
  // -------------------------------------------------------------------
  {
    id: 'unknown-icon',
    check(ir, ctx, emit) {
      const known = ctx.knownIcons;
      if (!known) return;
      walkNodes(ir.layout, '/layout', (n, path) => {
        if (n.icon && !known.has(n.icon)) {
          emit({
            severity: 'error',
            path: `${path}/icon`,
            message: `unknown icon "${n.icon}"`,
          });
        }
      });
    },
  },

  // -------------------------------------------------------------------
  // a11y
  // -------------------------------------------------------------------
  {
    id: 'interactive-without-a11y',
    check(ir, _ctx, emit) {
      const interactiveKinds = new Set([
        'button', 'link', 'input', 'textarea', 'select',
        'checkbox', 'radio', 'switch', 'menu', 'tabs',
      ]);
      walkNodes(ir.layout, '/layout', (n, path) => {
        if (interactiveKinds.has(n.kind)) {
          // allowed if registry-component (registry entry supplies role)
          if (n.kind === 'component') return;
          if (!n.a11y?.role && !n.a11y?.ariaLabel) {
            // checkbox/radio/switch/etc. typically have a sibling label,
            // so this is a warning not error
            emit({
              severity: 'warning',
              path,
              message: `interactive node kind="${n.kind}" missing a11y.role or ariaLabel`,
            });
          }
        }
      });
    },
  },

  // -------------------------------------------------------------------
  // states
  // -------------------------------------------------------------------
  {
    id: 'error-state-missing-recovery',
    check(ir, _ctx, emit) {
      const errorState = ir.states?.['error'];
      if (!errorState) return;
      // require either a retry interaction, a button child, or a link
      let hasRecovery = false;
      walkNodes(errorState, '/states/error', (n) => {
        if (n.kind === 'button' || n.kind === 'link') hasRecovery = true;
        if (n.interactions?.includes('retry')) hasRecovery = true;
      });
      if (!hasRecovery) {
        emit({
          severity: 'warning',
          path: '/states/error',
          message: 'error state has no recovery action (button/link/retry)',
        });
      }
    },
  },

  {
    id: 'loading-state-missing-aria-live',
    check(ir, _ctx, emit) {
      const loading = ir.states?.['loading'];
      if (!loading) return;
      let hasLive = false;
      walkNodes(loading, '/states/loading', (n) => {
        if (n.a11y?.ariaLive && n.a11y.ariaLive !== 'off') hasLive = true;
      });
      if (!hasLive) {
        emit({
          severity: 'warning',
          path: '/states/loading',
          message: 'loading state has no aria-live region; screen-reader users won\'t hear it',
        });
      }
    },
  },

  // -------------------------------------------------------------------
  // raw escape hatch
  // -------------------------------------------------------------------
  {
    id: 'raw-escape-hatch',
    check(ir, _ctx, emit) {
      walkNodes(ir.layout, '/layout', (n, path) => {
        if (n.kind === 'raw') {
          emit({
            severity: 'warning',
            path,
            message: 'kind="raw" bypasses the IR abstraction; prefer composing primitives',
          });
        }
      });
    },
  },

  // -------------------------------------------------------------------
  // i18n
  // -------------------------------------------------------------------
  {
    id: 'copy-missing-key',
    check(ir, _ctx, emit) {
      const visit = (val: unknown, path: string) => {
        if (
          val &&
          typeof val === 'object' &&
          'default' in (val as object) &&
          !('key' in (val as object))
        ) {
          emit({
            severity: 'warning',
            path,
            message:
              'copy node has no i18n key; agents without i18n runtime are fine but apps with i18n need keys',
          });
        }
      };
      walkNodes(ir.layout, '/layout', (n, path) => {
        if (n.title) visit(n.title, `${path}/title`);
        if (n.copy) visit(n.copy, `${path}/copy`);
        if (n.label) visit(n.label, `${path}/label`);
        if (n.placeholder) visit(n.placeholder, `${path}/placeholder`);
        if (n.a11y?.ariaLabel) visit(n.a11y.ariaLabel, `${path}/a11y/ariaLabel`);
      });
    },
  },
];

/** Run all lint rules against an IR doc. */
export function lintIr(ir: UiIr, ctx: LintContext = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const rule of RULES) {
    rule.check(ir, ctx, (issue) => {
      issues.push({ ...issue, ruleId: rule.id });
    });
  }
  return issues;
}

/** Just the error-severity issues. */
export function lintErrors(ir: UiIr, ctx: LintContext = {}): LintIssue[] {
  return lintIr(ir, ctx).filter((i) => i.severity === 'error');
}
