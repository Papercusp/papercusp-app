/**
 * Re-export shim — the `pc-override-*` styles now live in the shared
 * `@papercusp/ui-primitives` package (sentinel-herald P-035). Existing
 * operator-vite imports keep working unchanged via this shim.
 */
export { OVERRIDE_CSS } from '@papercusp/ui-primitives/override';
