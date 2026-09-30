/**
 * D-001's absolute fence, in a BROWSER-SAFE leaf module.
 *
 * A Personal Vault grant never turns a coding/review role into a personal-data
 * principal: `authorizePersonalAccess` denies these roles before it even looks
 * for a grant. That means an owner CAN mint a grant naming one of them and it
 * will authorize nothing — a dead grant that reads as live in the grants table.
 *
 * The Personal Vault settings page warns about exactly that at mint time, so
 * the predicate has two consumers: the server-side fence and the client-side
 * warning. It lives here, with ZERO imports, so both import the SAME regex
 * rather than keeping a second copy that can drift out of agreement with the
 * fence it is supposed to describe (WI-10001809).
 */
const CODING_ROLE_RE =
  /^(?:su|engineer|worker|coder|coding|implementer|validator|reviewer|architect|debugger|documenter|scoper|project[_-]?manager)$/i;

export function isCodingAgentRole(role: string | null | undefined): boolean {
  return !!role && CODING_ROLE_RE.test(role.trim());
}
