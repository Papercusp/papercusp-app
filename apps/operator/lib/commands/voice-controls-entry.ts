/**
 * UI-side registration of the browser voice controls into operator-core's
 * voice-control bridge.
 *
 * operator-core (headless backend) must not statically import the UI app, so
 * the `voice.*` command handlers reach the browser voice engine through a
 * loader registered here. This module owns the one `@/app` reference (inside
 * the lazy loader, so the heavy voice module is only imported when a voice
 * command actually runs).
 *
 * Imported for side effect at app boot (see `apps/operator-vite/src/routes/
 * __root.tsx`). Mirrors the chat-cards `*Entry` registration pattern.
 */
import { registerVoiceControlsLoader } from '@papercusp/operator-core/lib/commands/voice-control-bridge';

registerVoiceControlsLoader(async () => {
  const { setVoiceMode } = await import('@/app/_components/voice/voice-mode');
  return { setVoiceMode };
});
