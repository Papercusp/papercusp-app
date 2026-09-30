/**
 * getSessionUserOrLocalDefault — the session resolution for the operator-chat
 * CARD family (state-snapshot SSE, card-response, silence-nudge).
 *
 * WI-5044: these routes 401'd on a bare `getSessionUser` cookie check — a
 * webapp-era assumption. The DESKTOP product never mints a session cookie
 * (auth/me's auto-establish is passwordless-only; the IPC transport
 * synthesizes an operator principal, not a Cookie header), so on the real
 * desktop the state channel was dead: chat:ask_choice cards never rendered
 * live, the blocking askUser timed out to {cancelled}, and the model fell
 * back to a prose option list — the owner-reported "Pick one." dead-end.
 *
 * Trust decision: EXACTLY the one /api/auth/me already makes — a caller the
 * loopback perimeter admits gets the seeded default user when no session
 * cookie is present. Non-loopback callers stay strict-session, so this
 * changes nothing for any off-box exposure (defense-in-depth per
 * loopback-guard.ts; the primary perimeter remains the loopback bind).
 */
import { getSessionUser, getSessionUserOrDefault, type User } from '../auth';
import { isLoopbackHost } from './loopback-guard';
import { currentLoopbackPeerIsForeign } from '../auth/loopback-peer-trust';
import { requestIsExternal } from '../auth/forwarded-request-trust';

/** The request's effective host: the Host header when present, else the URL's
 *  host — under @hono/node-server the URL host IS derived from the client's
 *  Host header, so the two agree in real serving (same source loopback-guard
 *  documents); the fallback matters for synthesized test requests. */
function requestHost(req: Request): string | null {
  const header = req.headers.get('host');
  if (header) return header;
  try {
    const host = new URL(req.url).host;
    return host || null;
  } catch {
    return null;
  }
}

export async function getSessionUserOrLocalDefault(req: Request): Promise<User | null> {
  let user: User | null = null;
  try {
    user = await getSessionUser(req.headers);
  } catch {
    user = null;
  }
  if (user) return user;
  if (!isLoopbackHost(requestHost(req))) return null;
  // WI-10003621: on a hosted workspace host a loopback Host header is not locality —
  // the customer account shares the interface. A foreign loopback peer gets no
  // default-user fallback, exactly like an off-loopback caller.
  if (currentLoopbackPeerIsForeign()) return null;
  // external-app-access P-004 / R-7: a tunnel or relay request whose Host was
  // rewritten to localhost gets no default-user fallback either.
  if (requestIsExternal(req.headers)) return null;
  try {
    return await getSessionUserOrDefault(req.headers);
  } catch {
    return null;
  }
}
