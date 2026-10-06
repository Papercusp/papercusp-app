/**
 * CSRF guard for an HTML form a page posts back to its own origin (an approve / consent button).
 *
 * The exact page Origin is the normal case. `Origin: null` is ALSO what a real browser sends for a
 * same-origin form post whenever the page runs under a `no-referrer` policy: the Fetch spec
 * serializes the Origin of a non-GET navigation as the literal "null" under that policy, whether
 * the page chose it or the user's privacy setting forced it. Fetch Metadata (`Sec-Fetch-Site`, set
 * by the browser and not forgeable by a page) then proves the post came from a same-origin
 * document; a cross-site or sandboxed-opaque initiator reports `cross-site`.
 *
 * Pages that post a form should still send `referrer-policy: same-origin`, not `no-referrer`: it
 * keeps a URL secret (a user code, a request handle) from other origins and lets the browser send
 * its real Origin. Twice a page shipped `no-referrer` beside an exact-Origin check and refused every
 * browser (WI-10003612 hosted CLI sign-in, WI-10004462 portal MCP consent);
 * ./same-origin-form-post.test.ts scans for that pairing.
 */
export function isSameOriginFormPost(headers: Headers, origin: string): boolean {
  const requestOrigin = headers.get('origin');
  if (requestOrigin === origin) return true;
  return requestOrigin === 'null' && headers.get('sec-fetch-site') === 'same-origin';
}
