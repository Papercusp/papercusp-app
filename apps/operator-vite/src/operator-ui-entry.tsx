/**
 * Side effect: tell @papercusp/operator-ui it is running INSIDE the operator.
 *
 * The panels in that package were extracted from this app (WI-2143109) so the
 * cloud portal can mount them natively instead of framing us. Three things they
 * used to import directly are now injected, because they are the only things
 * that genuinely differ between the two hosts:
 *
 *   Link     — TanStack's, so `/settings/deploy-accounts` is a client-side nav
 *              here rather than a document load.
 *   toast    — sonner's, matching every other toast this app raises.
 *   apiFetch — identity: the operator IS the API origin, so an operator-relative
 *              path is already correct. The portal is the host that has to
 *              rewrite these onto a proxy.
 *
 * Imported for effect from main.tsx BEFORE the router mounts. If it ever stops
 * being imported the panels do not crash — they fall back to a plain <a> and
 * console toasts (see the seam's defaults), which is a quiet degradation, so the
 * import lives next to the other boot-critical side effects rather than beside a
 * component that might get lazy-loaded.
 */
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { configureOperatorUi } from '@papercusp/operator-ui';

configureOperatorUi({
  Link: ({ to, className, children }) => (
    // `to` is typed as a plain string at the seam (the portal has no TanStack
    // route tree to check it against), so it is cast back into TanStack's typed
    // route union here — the one place that knows the route table.
    <Link to={to as never} className={className}>{children}</Link>
  ),
  toast: {
    success: (message) => void toast.success(message),
    error: (message) => void toast.error(message),
  },
  apiFetch: (path, init) => fetch(path, init),
});
