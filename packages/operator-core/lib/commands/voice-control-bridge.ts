/**
 * Browser voice-control seam (injection inversion).
 *
 * operator-core is the headless backend — it must not statically import the UI
 * app (`@/app`). The `voice.*` command handlers (`commands/defs/voice.ts`) need
 * to drive the browser voice engine, which lives in the UI
 * (`apps/operator/app/_components/voice/voice-mode.ts`). Rather than core
 * reaching back into `@/app` (the carve's one remaining UI back-edge), the UI
 * registers a *loader* here at boot and core awaits it lazily on first use.
 *
 * This preserves the original "dynamic-import-on-call" semantics exactly — the
 * same module is imported the first time a voice command runs — with the only
 * change being that the `@/app` reference now lives on the UI side
 * (`apps/operator/lib/commands/voice-controls-entry.ts`).
 *
 * Mirrors the chat-cards registration inversion (a UI entry module registers a
 * concrete impl into a core-owned registry).
 */

export type VoiceMode = 'off' | 'push-to-talk' | 'always-on';

export interface VoiceControls {
  setVoiceMode: (mode: VoiceMode) => void;
}

type VoiceControlsLoader = () => Promise<VoiceControls>;

let loader: VoiceControlsLoader | null = null;

/**
 * Called once by the UI (browser) at boot to supply a loader for the concrete
 * voice controls. The loader is invoked lazily (on first voice command), so the
 * heavy browser voice module is only imported when actually needed.
 */
export function registerVoiceControlsLoader(l: VoiceControlsLoader): void {
  loader = l;
}

/**
 * Core command handlers await this to reach the browser voice controls. Throws a
 * clear error if no UI has registered a loader (e.g. invoked headlessly, or
 * before the app shell has booted).
 */
export async function loadVoiceControls(): Promise<VoiceControls> {
  if (!loader) {
    throw new Error(
      'voice controls loader not registered — voice.* commands require the browser ' +
        'UI to call registerVoiceControlsLoader() at boot',
    );
  }
  return loader();
}

/** Test-only: reset the registered loader between cases. */
export function __resetVoiceControlsForTest(): void {
  loader = null;
}
