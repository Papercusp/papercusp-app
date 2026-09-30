/**
 * Cookie helpers for `defineTool` handlers.
 *
 * A `defineTool` handler returns a Web-standard `Response` — there is
 * no Next `cookies()` jar to `.set()`/`.delete()`. Cookie writes are
 * `Set-Cookie` response headers; cookie reads parse the `Cookie` request
 * header. These helpers are the route-side inverse of the `Cookie`-header
 * parse in `lib/auth.ts`.
 */

export interface SetCookieOptions {
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  path?: string;
  domain?: string;
  expires?: Date;
  /** Seconds. */
  maxAge?: number;
  secure?: boolean;
}

/** Build a `Set-Cookie` header value. */
export function serializeSetCookie(
  name: string,
  value: string,
  opts: SetCookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (typeof opts.maxAge === 'number') parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  return parts.join('; ');
}

/** A `Set-Cookie` value that deletes `name` (empty value, expired). */
export function serializeDeleteCookie(
  name: string,
  path = '/',
  opts: Pick<SetCookieOptions, 'httpOnly' | 'sameSite' | 'secure'> = {},
): string {
  return serializeSetCookie(name, '', { ...opts, path, maxAge: 0, expires: new Date(0) });
}

/** Read one cookie value from a request's `Cookie` header. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
