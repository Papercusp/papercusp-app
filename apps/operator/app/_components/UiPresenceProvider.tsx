'use client';

/**
 * App-root provider for the agent → UI control surface.
 *
 * Mount once in the root layout. Two side effects:
 *   - keeps `harness_shared.ui_clients` row fresh for this tab
 *   - subscribes to `/api/ui/intents/stream` and runs intent handlers
 *
 * Returns null — no DOM. The state and SSE handle live in module
 * singletons so adding the provider in two places by accident
 * doesn't double-register.
 */

import { useUiPresence } from '@/lib/ui/use-ui-presence';
import { UiIntentDispatcher } from '@/lib/ui/intent-dispatcher';
import { shouldMountRemoteUiControl } from '@papercusp/operator-core/lib/ui/desktop-ui-intents';

export function UiPresenceProvider(): React.ReactElement | null {
  const enableRemoteUi = typeof window === 'undefined'
    ? true
    : shouldMountRemoteUiControl(window.location.origin);

  if (!enableRemoteUi) return null;

  useUiPresence();
  return <UiIntentDispatcher />;
}
