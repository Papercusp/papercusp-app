/**
 * Judge whether the Personal Vault's RLS policies encode CONSENT, or only
 * workspace isolation.
 *
 * The distinction is the whole reason `personalVaultRefusal` exists in
 * `pg-read-query.ts`. A workspace-only policy looks like a data-layer control in
 * review and is none: this cluster holds exactly one workspace, so every agent
 * already satisfies it, and the policy denies today only because
 * `app.workspace_id` happens to be unset — an accident, not a decision.
 */

/** A `CREATE POLICY` found on a `personal_*` relation. */
export interface VaultPolicy {
  /** Policy name as written — `%I` when the statement is built by `format()`. */
  name: string;
  /** The statement text, normalised out of any `format()` quote-doubling. */
  body: string;
  /** How the statement was tied to a vault relation. */
  boundBy: 'literal' | 'format-loop';
  /** Tokens showing the predicate consults the grant rows. */
  consentTokens: string[];
}

export interface VaultPolicyVerdict {
  policies: VaultPolicy[];
  /** True once ANY vault policy consults consent rather than workspace alone. */
  consentAware: boolean;
}

/**
 * Tokens that mean the predicate reached for the consent rows. `personal_grants`
 * is the relation; the others are its columns, so a policy that joins or
 * sub-selects against it is caught even if it aliases the table away.
 */
const CONSENT_TOKENS = ['personal_grants', 'revoked_at', 'granted_at', 'principal_id', 'scopes'];

const VAULT_RELATION = /\bpersonal_[a-z_]+\b/i;

/**
 * How far back to look for the relation a `format()`-built policy applies to.
 *
 * Migration 874 creates all six vault policies from one `FOREACH tbl IN ARRAY`
 * loop, so the statement itself carries only `%I` and the table names sit in the
 * array above it. A bounded lookback ties the two together without pretending to
 * parse PL/pgSQL. 2000 chars clears 874's loop header with room to spare; the
 * cost of overshooting is a false POSITIVE (a policy judged to be a vault
 * policy), which fails safe here — it can only add scrutiny, never remove it.
 */
const FORMAT_LOOKBACK_CHARS = 2000;

/**
 * Extract every `CREATE POLICY` that applies to a `personal_*` relation.
 *
 * Handles both shapes in the tree: the direct form (migration 983) names its
 * relation inline, while the `format()`-wrapped form inside a DO block (migration
 * 874) carries `%I` placeholders and arrives as a SQL string literal with its
 * quotes doubled. Undoubling first is what lets one token list serve both.
 */
export function findVaultPolicies(sql: string): VaultPolicy[] {
  const out: VaultPolicy[] = [];
  const re = /CREATE\s+POLICY\s+(%I|[A-Za-z_][\w$]*)/gi;

  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    // A policy body runs to the statement terminator — for the format() shape,
    // that is the `);` closing the EXECUTE, which still contains the predicate.
    const rest = sql.slice(m.index);
    const end = rest.indexOf(';');
    const body = (end === -1 ? rest : rest.slice(0, end)).replace(/''/g, "'");

    // Direct form: the relation is right there in the statement.
    let boundBy: VaultPolicy['boundBy'] | null = VAULT_RELATION.test(body) ? 'literal' : null;

    // format() form: the relation is a placeholder, so consult the loop above it.
    if (!boundBy && body.includes('%I')) {
      const from = Math.max(0, m.index - FORMAT_LOOKBACK_CHARS);
      if (VAULT_RELATION.test(sql.slice(from, m.index))) boundBy = 'format-loop';
    }
    if (!boundBy) continue;

    out.push({
      name: m[1],
      body,
      boundBy,
      consentTokens: CONSENT_TOKENS.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(body)),
    });
  }
  return out;
}

/** Classify a migration's vault policies as consent-aware or workspace-only. */
export function judgeVaultPolicyConsent(sql: string): VaultPolicyVerdict {
  const policies = findVaultPolicies(sql);
  return { policies, consentAware: policies.some((p) => p.consentTokens.length > 0) };
}
