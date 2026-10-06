/**
 * D-002 (plan psu-cloud-connector-liveness-multi-signin-2026-09-29): the ONE allowlist for the
 * arguments a customer may pass to a host-started psu.
 *
 * Plain JavaScript because two very different processes must apply the same list: the workspace
 * host and the control plane (TypeScript, `hosted-psu-session.ts`), and psu's own launcher
 * (`apps/operator/scripts/psu-launcher.mjs`, which imports with no build step). The launcher
 * re-checks its argv in hosted-customer mode (D-002 rule 4), so a host bug that let a flag
 * through still does not reach psu's flag parser. Why an allowlist and not a denylist is in
 * `hosted-psu-session.ts`.
 */

/** The env switch that puts psu's launcher in hosted-customer mode (P-008). */
export const HOSTED_PSU_CUSTOMER_ENV = "PAPERCUSP_PSU_HOSTED_CUSTOMER";

/** More forwarded arguments than any real invocation needs; a longer list is refused. */
export const HOSTED_PSU_MAX_ARGS = 16;

/** The agent CLIs the customer agent toolchain carries (`hostedCustomerAgentCommand`). */
const HOSTED_PSU_AGENTS = new Set(["claude", "codex", "omp"]);

const MODEL_SPEC = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL_MAX = 128;

/** Flags that take no value. */
const HOSTED_PSU_BARE_FLAGS = new Set(["--no-picker", "--resume", "--fork", "--fork-session"]);

/** Flags that take a value, with the check that value must pass. */
const HOSTED_PSU_VALUE_FLAGS = new Map([
  ["--agent", (value) => HOSTED_PSU_AGENTS.has(value)],
  ["--model", (value) => MODEL_SPEC.test(value)],
  ["--label", (value) => value.length > 0 && value.length <= LABEL_MAX && !/[\p{Cc}]/u.test(value)],
  ["--resume", (value) => SESSION_ID.test(value)],
]);

/** True when this process is a psu the workspace host started for a customer. */
export function isHostedPsuCustomer(env = process.env) {
  return env[HOSTED_PSU_CUSTOMER_ENV] === "1";
}

/**
 * Check the customer's psu arguments against the D-002 allowlist.
 *
 * Returns the arguments NORMALISED to the `--flag=value` form, so the argv psu receives has no
 * space-separated value it could read as a separate flag. Refuses the whole list on the first
 * argument it does not admit — including `--`, which would forward the rest verbatim to the agent.
 */
export function parseHostedPsuCustomerArgv(argv) {
  if (argv === undefined || argv === null) return { ok: true, argv: [] };
  if (!Array.isArray(argv)) return { ok: false, reason: "argv_not_a_list" };
  if (argv.length > HOSTED_PSU_MAX_ARGS) return { ok: false, reason: "argv_too_long" };
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string" || arg.length === 0 || arg.length > 512 || arg.includes("\0")) {
      return { ok: false, reason: "argv_malformed" };
    }
    if (HOSTED_PSU_BARE_FLAGS.has(arg)) {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    const check = HOSTED_PSU_VALUE_FLAGS.get(flag);
    if (!check) return { ok: false, reason: `flag_not_allowed:${flag.slice(0, 64)}` };
    if (value === undefined) {
      // Space form (`--agent codex`). `--resume` alone is the bare flag handled above.
      const next = argv[i + 1];
      if (typeof next !== "string") return { ok: false, reason: `flag_needs_value:${flag}` };
      value = next;
      i++;
    }
    if (!check(value)) return { ok: false, reason: `flag_value_refused:${flag}` };
    out.push(`${flag}=${value}`);
  }
  return { ok: true, argv: out };
}
