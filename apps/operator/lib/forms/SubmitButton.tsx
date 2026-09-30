'use client';

/**
 * SubmitButton — disabled-while-submitting button. Pairs with
 * `useFormWith().isSubmitting` so callers don't have to thread a manual
 * `busy` flag.
 */
import type { ReactNode } from 'react';

export function SubmitButton({
  pending,
  children,
  pendingLabel,
  variant = 'primary',
  ...rest
}: {
  pending: boolean;
  children: ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'ghost';
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'disabled' | 'children'>) {
  const isPrimary = variant === 'primary';
  // Adopts the .pc-btn-primary / baseline button styling from globals.css
  // so primary submit buttons across every RHF form (login, profile,
  // api-keys, agent, oracle, operator) use the operator accent token
  // and not a one-off blue. See <Button> wrapper in app/harness/Button.tsx
  // for the variant CSS classes.
  return (
    <button
      type="submit"
      disabled={pending || rest['aria-disabled'] === 'true'}
      className={isPrimary ? 'pc-btn-primary' : undefined}
      style={{
        fontWeight: 600,
        opacity: pending ? 0.7 : 1,
        ...rest.style,
      }}
      {...rest}
    >
      {pending ? (pendingLabel ?? 'Saving…') : children}
    </button>
  );
}
