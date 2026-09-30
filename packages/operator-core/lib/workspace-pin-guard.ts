/**
 * Guardrail for the `PAPERCUSP_WORKSPACE_ID` host pin.
 *
 * `activeWorkspaceId()` honours `PAPERCUSP_WORKSPACE_ID` (precedence step 2,
 * above `registry.current`), so setting it pins workspace resolution for every
 * NON-request path: background work, the spawn envelope, and the
 * harness-list/features tools whenever a request didn't stamp
 * `x-papercusp-workspace`. The `:3070` operator host is inherently
 * multi-workspace (it serves every desktop window), so a pin there silently
 * rebinds all of them — a leftover `=default` once made `papercusp-workspace`
 * surface `default`'s entire harness registry, and a bare `# TEMPORARY` comment
 * in `.env.local` was not enough to stop it surviving.
 *
 * Pure + side-effect free so it's unit-testable; the host logs the returned
 * string at boot. See agent-insight `workspace-id-pin-and-harness-membership`.
 *
 * @returns a warning string when the pin is set (non-empty after trim), else null.
 */
export function workspacePinWarning(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const pin = env.PAPERCUSP_WORKSPACE_ID?.trim();
  if (!pin) return null;
  return (
    `[hono-host] ⚠ PAPERCUSP_WORKSPACE_ID=${pin} is set — this PINS workspace ` +
    `resolution to '${pin}' for every non-request path on this multi-workspace ` +
    `host. Any window/tool that doesn't carry the x-papercusp-workspace header ` +
    `will see '${pin}'s harnesses/features/registry, regardless of the active ` +
    `workspace. Unset it unless this host is intentionally single-workspace.`
  );
}
