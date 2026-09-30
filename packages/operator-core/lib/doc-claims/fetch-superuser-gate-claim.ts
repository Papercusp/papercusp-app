/**
 * Doc-claim: `capability:fetch`'s prose about the local `?superuser=1` credential
 * gate must stay true to the code that owns each fact.
 *
 * EI-20233090880522791. Measured against :3170 on 2026-09-05, POSTing with correct
 * dual-`Accept` and NO `Authorization`, the gate is METHOD-DEPENDENT and every row
 * is HTTP 200:
 *
 *   initialize  → 200, served normally, NO rejection
 *   tools/list  → 200, JSON-RPC error  : "mcp_auth_failed: superuser_invalid_bearer"
 *   tools/call  → 200, isError result  : "request_rejected: superuser_invalid_bearer"
 *
 * Two things about that are worth a build-time guard rather than trust.
 *
 * FIRST, THE STATUS IS COUNTER-INTUITIVE AND THE INTUITIVE VALUE IS WRONG. Every
 * convention says a rejected credential is 401 or 403, and a future editor
 * "correcting" this prose to say so would be making it worse while believing they
 * were fixing a typo. The 200 is not an oversight either — the HTTP exchange
 * genuinely succeeded; the refusal lives in the JSON-RPC payload. Three separate
 * agents were caught by this in one morning (this item's filer wrote the probe
 * "remains unverified despite a healthy :3170"; the EI-20233057540755917 holder
 * nearly filed "credential gate did not reproduce" off an initialize-only probe;
 * and their hint text asserted tools/list succeeds until it was measured). A
 * regression to 401/403 here would re-arm exactly that trap, so it is guarded.
 *
 * SECOND, THE TOKEN PATH IS CODE-OWNED. `superuser-token.ts` exports
 * SUPERUSER_TOKEN_PATH; prose naming that path is a second copy of it, so per the
 * derived-truth ladder it gets rung 2 (PIN) rather than hand-maintenance.
 *
 * DELIBERATELY NOT ASSERTED: that the prose mention the gate at all. Silence is a
 * legitimate editorial choice (and the response-path hint in `fetch-mcp-hint.ts`,
 * owned separately on EI-20233057540755917, covers callers who hit 405/406). What
 * this forbids is prose that is CONFIDENTLY WRONG about a fact the code owns.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A superuser-token path as written in prose, including the scoped home. */
const TOKEN_PATH_IN_PROSE = /(?:~|\$HOME|\$PAPERCUSP_HOME|\/[\w.-]+)(?:\/[\w.-]+)*\/superuser-token\b/g;

/** The clause vocabulary for the credential gate, so unrelated prose is not judged. */
const CREDENTIAL_CLAUSE = /superuser_invalid_bearer|superuser-token|\?superuser=1/i;

/**
 * A status assertion that would be WRONG for this gate. Bare "401"/"403" anywhere
 * is too loose — the description legitimately names 406 for the Accept gate — so
 * this only matches a status in a clause that is ALSO talking about credentials.
 */
const WRONG_AUTH_STATUS = /\b(401|403)\b/;

/** Split on clause boundaries so the 406 Accept clause is never read as an auth claim. */
function clauses(text: string): string[] {
  return text
    .split(/[.;:]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function expandHome(prosePath: string, homeDir: string, papercuspHome: string): string {
  if (prosePath.startsWith('~')) return homeDir + prosePath.slice(1);
  if (prosePath.startsWith('$HOME')) return homeDir + prosePath.slice('$HOME'.length);
  if (prosePath.startsWith('$PAPERCUSP_HOME')) return papercuspHome + prosePath.slice('$PAPERCUSP_HOME'.length);
  return prosePath;
}

export interface FetchGateClaimVerdict {
  readonly ok: boolean;
  /** Token paths the prose names, exactly as written. */
  readonly tokenPathsNamed: readonly string[];
  /** Credential clauses asserting a 401/403 status. */
  readonly wrongStatusClaims: readonly string[];
  readonly violations: readonly string[];
}

export interface FetchProseSurfaces {
  /** The tool description — delivered in the schema every caller loads. */
  readonly description: string;
  /** `guidance.when`, projected alongside it. */
  readonly when?: string;
}

/**
 * Falsifiable in both directions it claims, with permanent controls in the test:
 * a drifted token path is caught, and a credential clause asserting 401/403 is
 * caught. Prose that stays silent about the gate is deliberately allowed through.
 */
export function judgeFetchSuperuserGateClaim(
  surfaces: FetchProseSurfaces,
  opts: { readonly tokenPath: string; readonly homeDir?: string; readonly papercuspHome?: string },
): FetchGateClaimVerdict {
  const homeDir = opts.homeDir ?? homedir();
  const papercuspHome = opts.papercuspHome ?? process.env.PAPERCUSP_HOME ?? join(homeDir, '.papercusp');
  const texts = [surfaces.description, ...(surfaces.when === undefined ? [] : [surfaces.when])];
  const allProse = texts.join('\n');

  const tokenPathsNamed = Array.from(allProse.matchAll(TOKEN_PATH_IN_PROSE)).map((m) => m[0]);

  const wrongStatusClaims = texts
    .flatMap(clauses)
    .filter((c) => CREDENTIAL_CLAUSE.test(c) && WRONG_AUTH_STATUS.test(c));

  const violations: string[] = [];

  for (const named of tokenPathsNamed) {
    const expanded = expandHome(named, homeDir, papercuspHome);
    if (expanded !== opts.tokenPath) {
      violations.push(
        `capability:fetch's prose names the superuser token at ${JSON.stringify(named)} ` +
          `(expanding to ${JSON.stringify(expanded)}), but superuser-token.ts reads ` +
          `${JSON.stringify(opts.tokenPath)}. Update the prose to match SUPERUSER_TOKEN_PATH.`,
      );
    }
  }

  if (wrongStatusClaims.length > 0) {
    violations.push(
      `capability:fetch's prose asserts a 401/403 status for the ?superuser=1 credential ` +
        `gate: ${wrongStatusClaims.map((c) => JSON.stringify(c)).join(', ')}. Measured against ` +
        `a live operator, that gate returns HTTP 200 with the refusal inside the JSON-RPC body ` +
        `(initialize is served outright; tools/list returns a -32603 error; tools/call returns ` +
        `an isError result). 401/403 is the intuitive value and the wrong one, and asserting it ` +
        `re-arms the false-success trap this prose exists to defuse (EI-20233090880522791).`,
    );
  }

  return { ok: violations.length === 0, tokenPathsNamed, wrongStatusClaims, violations };
}
