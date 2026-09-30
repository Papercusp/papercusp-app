/**
 * Re-export shim — <OverridableSetting> now lives in the shared
 * `@papercusp/ui-primitives` package (sentinel-herald P-035) so both the Vite
 * and the Next operator apps share ONE copy. Existing operator-vite imports
 * (`import OverridableSetting from '../override/OverridableSetting'`) keep
 * working unchanged via this default re-export.
 *
 * The package exposes it as the NAMED `OverridableSetting` (its index has no
 * default export), so re-alias it to this module's default for the legacy
 * default-import call sites.
 */
import { OverridableSetting } from '@papercusp/ui-primitives/override';

export {
  OverridableSettingStyle,
  type OverridableSettingProps,
  type OverrideBadgeStyle,
} from '@papercusp/ui-primitives/override';

export default OverridableSetting;
