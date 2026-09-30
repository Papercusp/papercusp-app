'use client';

import { Slot } from '@radix-ui/react-slot';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

/**
 * Button — the operator's one button primitive.
 *
 * Two ORTHOGONAL axes (design-simplification P-015 folded the old parallel
 * `.pc-button` CTA recipe into these; P-015 part 2 folded the Operator panel's
 * `.operator-mini-btn` recipe into the `mini` size — see globals.css `.pc-btn-mini`):
 *
 *   size    — 'sm' (default) the 26px chrome/toolbar scale
 *             'lg'           the 40px page-CTA scale
 *             'mini'         the ~30px pill-shaped suggestion-card action scale
 *                             (Operator panel's accept/ignore/keep-for-review row)
 *   variant — 'neutral' (default) the plain surface
 *             'accent'           soft accent tint — the usual page CTA
 *             'primary'          filled accent — the one true CTA on a page
 *             'destructive'      red tint — "Delete", destructive confirmations
 *             'ghost'            transparent until hovered — low emphasis
 *
 * Every Button emits the `.pc-btn` base class, so a Button rendered `asChild`
 * onto a link picks up the same chrome a bare `<button>` gets for free from the
 * globals.css baseline.
 *
 * `asChild` renders the single child element instead of a `<button>` (Radix
 * Slot: classes/handlers/ref merge onto the child). Use it for link-buttons so
 * they share this component's vocabulary rather than hand-written classes:
 *
 *   <Button asChild variant="primary" size="lg">
 *     <RouteLink href="/cupboard">Browse</RouteLink>
 *   </Button>
 *
 * A bare `<button>` is still fine for a neutral inline action — the global
 * baseline already styles it. See /docs/design for the form-control matrix.
 */
export type ButtonVariant = 'neutral' | 'accent' | 'primary' | 'destructive' | 'ghost';
export type ButtonSize = 'sm' | 'lg' | 'mini';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the child element instead of a `<button>`, merging props onto it. */
  asChild?: boolean;
  children: ReactNode;
}

/** `neutral` / `sm` are the base look — they add no class of their own. */
const VARIANT_CLASS: Record<ButtonVariant, string | null> = {
  neutral: null,
  accent: 'pc-btn-accent',
  primary: 'pc-btn-primary',
  destructive: 'pc-btn-destructive',
  ghost: 'pc-btn-ghost',
};

const SIZE_CLASS: Record<ButtonSize, string | null> = {
  sm: null,
  lg: 'pc-btn-lg',
  mini: 'pc-btn-mini',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'neutral', size = 'sm', asChild = false, className, type, children, ...rest },
  ref,
) {
  const cls = ['pc-btn', SIZE_CLASS[size], VARIANT_CLASS[variant], className]
    .filter(Boolean)
    .join(' ');

  if (asChild) {
    // `type` is a button-only attribute — never stamp it onto an <a>.
    return (
      <Slot ref={ref} className={cls} {...rest}>
        {children}
      </Slot>
    );
  }

  return (
    <button ref={ref} type={type ?? 'button'} className={cls} {...rest}>
      {children}
    </button>
  );
});
