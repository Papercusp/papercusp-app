/**
 * resolveBindHost — the canonical loopback-default HTTP bind host
 * (infra-fail-fast-build-integrity-2026-06-19 P-015 / D2; LOCKS audit P-027).
 *
 * Returns `PAPERCUSP_BIND_HOST` when explicitly set, else `127.0.0.1`.
 *
 * Deliberately does NOT fall back to `HOSTNAME`: that generic var is routinely the
 * machine's name on servers/containers, which silently turns the bind into an
 * off-loopback (off-box-reachable) listen that BYPASSES the operator loopback guard
 * (audit P-027). Binding off-loopback is an explicit `PAPERCUSP_BIND_HOST` opt-in.
 *
 * P-015 verification: the cluster-worker listen in hono-host.ts already binds
 * `host: hostname` (this value), so the "workers bind 0.0.0.0 under PAPERCUSP_CLUSTER=2"
 * concern does not reproduce — both the primary and the reusePort cluster workers bind
 * loopback by default. This helper extracts the resolution so the loopback default is
 * tested + can't drift back to a HOSTNAME/0.0.0.0 default in a future refactor.
 */
export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PAPERCUSP_BIND_HOST?.trim();
  return explicit ? explicit : '127.0.0.1';
}
