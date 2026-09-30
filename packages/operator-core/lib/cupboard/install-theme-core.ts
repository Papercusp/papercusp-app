import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';
import {
  THEME_MANIFEST,
  readThemeDirForInstall,
  userInstalledThemesDir,
  type InstalledTheme,
} from './theme-store';

export { InstallSelfDescribingError as InstallThemeError } from './install-self-describing-core';

const THEME_SPEC: SelfDescribingKindSpec<InstalledTheme> = {
  label: 'theme',
  manifestFile: THEME_MANIFEST,
  readDir: readThemeDirForInstall,
  userDir: userInstalledThemesDir,
};

export interface InstallThemeCoreResult extends InstalledTheme {
  ok: true;
  ref: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

export async function installThemeFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallThemeCoreResult> {
  const result = await installSelfDescribingFromCupboard(input, THEME_SPEC, deps);
  return {
    ok: true,
    ...result.meta,
    ref: result.ref,
    installedTo: result.installedTo,
    pin: result.pin,
  };
}
