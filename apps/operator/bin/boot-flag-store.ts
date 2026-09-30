/**
 * Side-effect boot module: install the PG-backed runtime flag-override store
 * BEFORE any other module in the host's import graph resolves a flag
 * (WI-4275 / scorecard-blender-pipeline-fixes-2026-07-11 P-002).
 *
 * flag-bus.ts installs the same store as a module side effect, but nothing
 * guarantees flag-bus evaluates before the first `getFlag()` in the boot
 * graph — on bg-host (hono-host with PAPERCUSP_BACKGROUND_WORKERS=1) it
 * demonstrably lost that race on every boot ("No override store installed …
 * getFlag() serving FLAG_DEFAULTS"), which made every runtime `flags:set`
 * kill-switch silently INVISIBLE to background routines (scout cycles,
 * watchdog sweeps, git-sync). Importing THIS module immediately after
 * `boot-integrity-first` pins the install into the module-evaluation order —
 * the same fix shape the standalone inference-gateway sidecar uses
 * (substrate-sidecar-server.ts).
 */
import { installFlagOverrideStore } from '@papercusp/operator-core/lib/flag-override-store';

installFlagOverrideStore();
