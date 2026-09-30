/**
 * Re-export shim — the override value-backbone now lives in the shared
 * `@papercusp/ui-primitives` package (sentinel-herald P-035) so both the Vite
 * and the Next operator apps share ONE copy. Existing operator-vite imports
 * (`'../override/isOverridden'`) keep working unchanged via this shim.
 */
export { isOverridden, effectiveValue, defaultEq } from '@papercusp/ui-primitives/override';
