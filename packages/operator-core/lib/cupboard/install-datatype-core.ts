/**
 * Install a Cupboard `datatype` listing into the local installed-datatype layer.
 *
 * This is the DISTRIBUTION half only. Per D-010 / P-027 `datatype_registry`
 * remains the resolution layer, so a successful install materializes a verified
 * package directory and hands back the parsed definition — the caller (the IO
 * seam) is what seeds the registry row from it. Keeping the row-write out of
 * here is what stops the Cupboard becoming a second resolver.
 */
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';
import {
  DATATYPE_MANIFEST,
  readDatatypeDirForInstall,
  userInstalledDatatypesDir,
  type InstalledDatatype,
} from './datatype-store';

export { InstallSelfDescribingError as InstallDatatypeError } from './install-self-describing-core';

const DATATYPE_SPEC: SelfDescribingKindSpec<InstalledDatatype> = {
  label: 'datatype',
  manifestFile: DATATYPE_MANIFEST,
  readDir: readDatatypeDirForInstall,
  userDir: userInstalledDatatypesDir,
};

export interface InstallDatatypeCoreResult extends InstalledDatatype {
  ok: true;
  ref: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

export async function installDatatypeFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallDatatypeCoreResult> {
  const result = await installSelfDescribingFromCupboard(input, DATATYPE_SPEC, deps);
  return {
    ok: true,
    ...result.meta,
    ref: result.ref,
    installedTo: result.installedTo,
    pin: result.pin,
  };
}
