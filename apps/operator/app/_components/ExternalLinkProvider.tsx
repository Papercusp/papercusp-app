"use client";

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { canUseContentOriginDesktopActions } from "@/lib/ipc-status-tauri";

/** Hostnames that ARE the app itself (any port) — never externalized. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/**
 * Whether a clicked link points OUT of the app and should open in the OS default
 * browser instead of navigating the Tauri webview. A same-window nav to an
 * external origin replaces the whole SPA, and a desktop window has no back
 * button — so this returns true only for an http(s) URL to a non-local host on a
 * different origin than the app. Everything else (same-origin, a local host/port,
 * mailto:, the papercusp:// custom scheme, an unparseable href) returns false and
 * is left to default handling. Pure — exported for unit tests.
 */
export function isExternalWebUrl(href: string, currentHref: string): boolean {
  let target: URL;
  let current: URL;
  try {
    target = new URL(href);
    current = new URL(currentHref);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (LOCAL_HOSTS.has(target.hostname)) return false;
  return target.origin !== current.origin;
}

/** Same-app OAuth launch links need the system browser after the local route builds state. */
export function isOAuthStartUrl(href: string, currentHref: string): boolean {
  try {
    const target = new URL(href, currentHref);
    const current = new URL(currentHref);
    return (
      target.protocol === current.protocol &&
      target.host === current.host &&
      target.pathname === "/api/oauth/start"
    );
  } catch {
    return false;
  }
}

/**
 * Hand an already-validated web URL to the operating system's default browser.
 * OAuth and the global external-link interceptor share this single Tauri shell
 * seam so browser launches cannot drift into separate command spellings.
 */
export async function openExternalWebUrl(href: string): Promise<void> {
  await invoke("plugin:shell|open", { path: href });
}

/**
 * Ask the local OAuth route to create signed state without following its
 * provider redirect inside the webview, then open the returned HTTPS URL in
 * the operating system browser. Used by generic plugin OAuth anchors; provider-
 * specific screens may add a stricter hostname check before using the opener.
 */
export async function openOAuthStartInSystemBrowser(
  href: string,
  currentHref: string,
): Promise<void> {
  const start = new URL(href, currentHref);
  start.searchParams.set("response", "json");
  const response = await fetch(start.pathname + start.search, {
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    authorizationUrl?: unknown;
    error?: unknown;
  };
  if (
    !response.ok ||
    payload.ok === false ||
    typeof payload.authorizationUrl !== "string"
  ) {
    const detail =
      typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }

  const authorizationUrl = new URL(payload.authorizationUrl);
  if (
    authorizationUrl.protocol !== "https:" ||
    !isExternalWebUrl(authorizationUrl.toString(), currentHref)
  ) {
    throw new Error("OAuth server returned an unsafe authorization URL");
  }
  await openExternalWebUrl(authorizationUrl.toString());
}

/**
 * ExternalLinkProvider — a global, capture-phase click interceptor that routes
 * EXTERNAL links to the OS default browser via the Tauri shell plugin, so an
 * external `<a>` (e.g. a GitHub link in the Insights tab) never replaces the SPA
 * inside the desktop webview (where there is no back button to recover). This is
 * an app-wide fix, not per-link — every external anchor in the app is covered.
 *
 * No-op outside the desktop shell (`isTauri()` false): a plain browser handles
 * external links fine (new tab / back button), so we let the default happen.
 * Mirrors RouteTransitionProvider's capture-phase document listener. Renders
 * nothing — mount it once, anywhere in the tree.
 *
 * Opens via the core `invoke('plugin:shell|open', …)` — the exact command that
 * `@tauri-apps/plugin-shell`'s `open()` wraps — so no extra JS dependency is
 * needed. The Rust `tauri-plugin-shell` is registered and `shell:allow-open` is
 * granted (papercusp-desktop/src-tauri).
 */
export default function ExternalLinkProvider() {
  useEffect(() => {
    let cancelled = false;
    let listening = false;
    function handleClickCapture(event: MouseEvent) {
      // Let modified / non-primary clicks and already-handled events through.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      // `anchor.href` is always the resolved ABSOLUTE url for an <a href>.
      if (!anchor || anchor.hasAttribute("download")) return;
      const oauthStart = isOAuthStartUrl(anchor.href, window.location.href);
      if (!oauthStart && !isExternalWebUrl(anchor.href, window.location.href))
        return;

      // Keep the SPA put; hand the URL to the OS browser instead.
      event.preventDefault();
      const opening = oauthStart
        ? openOAuthStartInSystemBrowser(anchor.href, window.location.href)
        : openExternalWebUrl(anchor.href);
      void opening.catch((err: unknown) => {
        console.error("[ExternalLinkProvider] shell open failed", err);
        if (oauthStart) {
          toast.error(
            `Couldn’t open provider sign-in: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }

    void canUseContentOriginDesktopActions().then((allowed) => {
      if (cancelled || !allowed) return;
      document.addEventListener("click", handleClickCapture, { capture: true });
      listening = true;
    });
    return () => {
      cancelled = true;
      if (listening)
        document.removeEventListener("click", handleClickCapture, {
          capture: true,
        });
    };
  }, []);

  return null;
}
