/**
 * Install a Cupboard `event` listing into the local installed-event layer.
 *
 * This is the DISTRIBUTION half only. Per D-010 `event_key_registry` remains the
 * resolution layer — the place a rule's `on` and an agent's `await` key must
 * RESOLVE — so a successful install materializes a verified package directory
 * and hands back the parsed vocabulary. The caller (the IO seam,
 * `install-event-io.ts`) is what seeds the registry row from it.
 *
 * Keeping the row-write out of here is the whole point, not an implementation
 * detail: the moment this file registers a key, the Cupboard becomes a second
 * resolver and `events:catalog` has two disagreeing sources of truth — the exact
 * drift P-029's registry half exists to end.
 *
 * The package a publisher ships carries only the CURATED half of a registry row
 * (D-058); `emitter` / `emitterExists` / `emitSiteCount` are measurements of the
 * PUBLISHER's tree and are refused at read time by `readEventDir`, never carried
 * across an install. An installing pot derives those against its own tree.
 */
import {
  installSelfDescribingFromCupboard,
  type InstallSelfDescribingDeps,
  type InstallSelfDescribingInput,
  type SelfDescribingKindSpec,
  type VerifiedContentPin,
} from './install-self-describing-core';
import {
  EVENT_MANIFEST,
  readEventDirForInstall,
  userInstalledEventsDir,
  type InstalledEvent,
} from './event-store';

export { InstallSelfDescribingError as InstallEventError } from './install-self-describing-core';

const EVENT_SPEC: SelfDescribingKindSpec<InstalledEvent> = {
  label: 'event',
  manifestFile: EVENT_MANIFEST,
  readDir: readEventDirForInstall,
  userDir: userInstalledEventsDir,
};

export interface InstallEventCoreResult extends InstalledEvent {
  ok: true;
  ref: string;
  installedTo: string;
  /** The content pin this install VERIFIED (P-002), or null for an unverified tip clone. */
  pin: VerifiedContentPin | null;
}

export async function installEventFromCupboardCore(
  input: InstallSelfDescribingInput,
  deps: InstallSelfDescribingDeps,
): Promise<InstallEventCoreResult> {
  const result = await installSelfDescribingFromCupboard(input, EVENT_SPEC, deps);
  return {
    ok: true,
    ...result.meta,
    ref: result.ref,
    installedTo: result.installedTo,
    pin: result.pin,
  };
}
