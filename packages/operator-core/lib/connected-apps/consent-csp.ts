/**
 * The Content-Security-Policy of a page whose form submission ends at an OAuth client's
 * `redirect_uri` (the portal consent page, and the local install's own consent page).
 *
 * Why this exists (WI-10004470): Chromium enforces `form-action` on EVERY hop of a form
 * submission's redirect chain, not only on the form's own `action`. A consent page served with
 * `form-action 'self'` posts to itself, the server answers with a redirect to the connector
 * (`https://claude.ai/...`, `http://127.0.0.1:<port>/callback`), and the browser silently
 * refuses that hop: the page stays where it is, the code is minted and never delivered, and no
 * chat connector can finish connecting. So the directive must also admit the ONE redirect target
 * of the request being decided — already checked against the client's registered `redirect_uris`.
 *
 * `cspAdmitsFormTarget` is a small independent evaluator of the same CSP Level 3 source matching
 * the browser applies. Tests use it to check the class invariant on real responses: every
 * redirect a consent POST can answer with is admitted by the form-action of the page that
 * rendered the form.
 */

const BASE_DIRECTIVES = "default-src 'none'; style-src 'unsafe-inline'";
const TRAILING_DIRECTIVES = "frame-ancestors 'none'";
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:$/i;

/**
 * The CSP source expression that admits navigations to `redirectUri`, or null when it cannot be
 * expressed safely. http(s) targets yield their exact origin (scheme, host and port). An IPv6
 * literal host has no CSP host-source form, so it yields its scheme. A native app's private-use
 * scheme (RFC 8252 §7.1, e.g. `cursor://...`) yields that scheme.
 */
export function formActionSourceFor(redirectUri: string): string | null {
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return null;
  }
  if (!SCHEME_RE.test(target.protocol)) return null;
  if (target.protocol === 'http:' || target.protocol === 'https:') {
    if (target.hostname.startsWith('[')) return target.protocol;
    return /^[a-z0-9.-]+(:\d+)?$/i.test(target.host) ? target.origin : null;
  }
  return target.protocol;
}

/** `form-action 'self'` plus the sources that admit each redirect target (deduplicated). */
export function formActionDirective(redirectTargets: readonly string[] = []): string {
  const sources = new Set<string>();
  for (const uri of redirectTargets) {
    const source = formActionSourceFor(uri);
    if (source) sources.add(source);
  }
  return ["form-action 'self'", ...sources].join(' ');
}

/** The full CSP for a consent/approval page that may redirect to `redirectTargets`. */
export function consentPageCsp(redirectTargets: readonly string[] = [], extra: readonly string[] = []): string {
  return [BASE_DIRECTIVES, formActionDirective(redirectTargets), TRAILING_DIRECTIVES, ...extra].join('; ');
}

const defaultPort = (protocol: string): string => (protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : '');

/**
 * Whether a CSP's `form-action` admits a form-submission navigation from `pageUrl` to `targetUrl`
 * (CSP Level 3 §6.7.2 source matching, for the source forms these pages use: 'self', scheme-source
 * and host-source with an optional port). No form-action directive means everything is admitted.
 */
export function cspAdmitsFormTarget(csp: string, pageUrl: string, targetUrl: string): boolean {
  const directive = csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find((tokens) => tokens[0]?.toLowerCase() === 'form-action');
  if (!directive) return true;
  const page = new URL(pageUrl);
  const target = new URL(targetUrl);
  const targetPort = target.port || defaultPort(target.protocol);
  return directive.slice(1).some((raw) => {
    const source = raw.toLowerCase();
    if (source === "'none'") return false;
    if (source === "'self'") {
      return target.origin === page.origin
        || (page.protocol === 'http:' && target.protocol === 'https:' && target.host === page.host);
    }
    if (SCHEME_RE.test(source)) {
      return source === target.protocol || (source === 'http:' && target.protocol === 'https:');
    }
    const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?$/.exec(source);
    if (!m) return false;
    const [, scheme, host, port] = m;
    if (scheme) {
      const okScheme = `${scheme}:` === target.protocol || (scheme === 'http' && target.protocol === 'https:');
      if (!okScheme) return false;
    } else if (target.protocol !== page.protocol && !(page.protocol === 'http:' && target.protocol === 'https:')) {
      return false;
    }
    const hostOk = host!.startsWith('*.')
      ? target.hostname.endsWith(host!.slice(1))
      : target.hostname === host;
    if (!hostOk) return false;
    if (port === '*') return true;
    const wantPort = port ?? defaultPort(scheme ? `${scheme}:` : target.protocol);
    return wantPort === targetPort;
  });
}
