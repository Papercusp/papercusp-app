import { isStaticPreviewHost } from './desktop-static-host';

/**
 * Whether to mount the agent → UI control surface (presence heartbeats +
 * the intent-dispatch SSE) for a given page origin.
 *
 * Enabled on :3070 (the operator host the desktop ships on — it fronts the
 * live Hono backend) and :3055 (the Vite dev server). Disabled only on the
 * backend-less build-preview host (:4173), where `/api/ui/*` would 404.
 *
 * History: during the operator-vite migration's static-desktop suppression
 * batch this was briefly gated off on ALL static hosts (including :3070,
 * alongside Chatwoot), which silently disabled agent UI-driving in the
 * shipped desktop. Narrowed back to the preview-only host so the operator
 * can drive the UI in the real app while `vite preview` stays quiet.
 */
export function shouldMountRemoteUiControl(origin: string): boolean {
  return !isStaticPreviewHost(origin);
}
