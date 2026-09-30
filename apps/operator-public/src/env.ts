/**
 * Cupboard server bindings + secrets + vars.
 *
 * Mirrors the papercusp-publish env shape so the deploy patterns
 * carry over. D1 + KV bindings; GitHub OAuth secrets; rate-limit vars.
 */

export interface Env {
  // Bindings
  DB: D1Database;
  COUNTERS: KVNamespace;
  /** Existing shared bucket, namespaced under artifacts/workspace-host/. */
  ARTIFACTS: R2Bucket;

  // Secrets
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  IP_HASH_PEPPER: string;
  /** Stripe endpoint signing secret (`whsec_…`), installed via
   *  `wrangler secret put STRIPE_WEBHOOK_SECRET` (P-010). OPTIONAL on purpose:
   *  a deployment that has not configured it fails CLOSED — the commerce webhook
   *  route answers 503 rather than accepting a delivery it cannot authenticate. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Stripe API secret key (`sk_…`), installed via
   *  `wrangler secret put STRIPE_SECRET_KEY` (P-010 / D-045 §3c). OPTIONAL for
   *  the same fail-closed reason as the webhook secret above: a deployment that
   *  has not configured it answers 503 on the checkout-session route rather than
   *  attempting an unauthenticated call to Stripe. Installing it in a deployment
   *  is an OWNER credential action, deliberately outside any agent's scope. */
  STRIPE_SECRET_KEY?: string;
  /** Repo-scoped GitHub token used ONLY to publish public Cupboard release
   *  assets to the mirror repo (P-045 / D-056), installed via
   *  `wrangler secret put GITHUB_RELEASE_MIRROR_TOKEN`. OPTIONAL for the same
   *  fail-closed reason as the Stripe secrets above: a deployment that has not
   *  configured it answers 503 on the mirror route rather than attempting an
   *  unauthenticated write. Installing it is an OWNER credential action,
   *  deliberately outside any agent's scope. Reads of mirrored bytes are
   *  tokenless, so this credential is never spent on delivery. */
  GITHUB_RELEASE_MIRROR_TOKEN?: string;
  /** `owner/repo` receiving the public release assets. A var, not a secret:
   *  the mirror repo is public by construction (its whole purpose is public
   *  availability), so its name confers nothing. */
  GITHUB_RELEASE_MIRROR_REPO?: string;
  /** Base-compatible RPC URL for the buyer-side P-032 payment-channel rail. */
  PAYMENT_CHANNEL_RPC_URL?: string;
  /** 32-byte EVM private key. The bound-wallet funding path additionally
   * requires its derived address to equal the authenticated wallet binding. */
  PAYMENT_CHANNEL_PRIVATE_KEY?: string;
  /** 32-byte EVM private key the P-034 treasury automation signs Zodiac Roles
   *  module calls with. OPTIONAL and fail-closed like the Stripe secrets: an
   *  unconfigured deployment answers 503 on the treasury routing route rather
   *  than attempting a transfer it cannot sign. Installing it is an OWNER
   *  credential action, deliberately outside any agent's scope — and the key
   *  MUST NOT be a Safe owner, which `validateTreasuryConfig` refuses outright:
   *  an always-online key that also counts toward the owner threshold erodes
   *  the offline control meant to sit above the automated role. */
  TREASURY_AUTOMATION_PRIVATE_KEY?: string;
  /** Idempotent channel contract implementing openChannel/closeChannel. */
  PAYMENT_CHANNEL_SETTLEMENT_CONTRACT?: string;
  /** Stablecoin contract address (pilot: Base-compatible USDC). */
  PAYMENT_CHANNEL_STABLECOIN?: string;

  // Vars
  /** Confirmation depth before a P-033 batch claim counts as FINAL. Unset takes
   *  the module default; a set-but-unparseable value is an error, never a
   *  silent fallback — settling at depth 1 when the operator meant 12 is the
   *  claim-vs-finality mistake acceptance line 14 exists to prevent. */
  SETTLEMENT_REQUIRED_CONFIRMATIONS?: string;
  /** DAO revenue split for P-033 settlement accounting, as JSON:
   *  `{"version":"v1","sharesBps":{"creator":...,"host":...,...}}`. Its
   *  canonical `sha256:` hash is DERIVED (never configured) and must equal the
   *  `splitManifestHash` the payer signed into each voucher, so a settlement
   *  can only apply a split the buyer actually agreed to. */
  REVENUE_SPLIT_MANIFEST?: string;
  /** Destination recorded in the settlement receipt for the DAO share, and —
   *  since P-034 — the recipient a reconciled treasury routing pays. A var, not
   *  a secret: a treasury address is public by construction. */
  DAO_TREASURY_ADDRESS?: string;
  /** Safe smart account holding DAO treasury capital (P-034). A var: a Safe
   *  address is public by construction. Routing additionally requires a
   *  RECORDED on-chain deployment for (chain, address) — a configured address
   *  alone is not evidence a Safe exists there, and a typo is unrecoverable
   *  once funds are sent. */
  TREASURY_SAFE_ADDRESS?: string;
  /** Zodiac Roles v2 modifier enabled on that Safe. The automation executes
   *  through this module, never as an owner, so the module is what enforces the
   *  role's target/selector scopes on chain. */
  TREASURY_ROLES_MODULE_ADDRESS?: string;
  /** Comma-separated Safe owner addresses, and the owner threshold. Recorded
   *  with the deployment so an audit can see owner control was separate from
   *  the automated role AT THE TIME the deployment was accepted. */
  TREASURY_SAFE_OWNERS?: string;
  TREASURY_SAFE_THRESHOLD?: string;
  /** Per-transfer cap on the automated `settlement` role, in stablecoin micros.
   *  The bound the Zodiac role enforces on chain; asserted here too so a
   *  transfer over the cap refuses before it is submitted. */
  TREASURY_SETTLEMENT_MAX_MICROS?: string;
  /** Comma-separated revenue shares routed to the Safe. Default `dao`.
   *  `creator`, `host` and `component` are PAYEE shares — money owed outward to
   *  a person, not DAO capital — so the door refuses them here rather than
   *  quietly sweeping a creator's earnings into the treasury. */
  TREASURY_ROUTED_SHARES?: string;
  /** Owner-gated. Routing on a deployment recorded as `mainnet` refuses unless
   *  this is exactly 'true'. Acceptance line 13 gates Safe signers and any
   *  mainnet capital on the owner; this is that gate, defaulting to refuse. */
  TREASURY_MAINNET_CAPITAL_APPROVED?: string;
  ENVIRONMENT: string;
  CUPBOARD_HOST: string;
  /** Comma-separated GitHub user ids allowed to use /admin operator surfaces
   *  (moderation and artifact publication). Empty ⇒ no operators ⇒ every
   *  /admin endpoint 403s. GitHub user ids are public, not secret, so this is
   *  a var (not a `wrangler secret`). Auth still requires a valid GitHub bearer. */
  CUPBOARD_OPERATOR_GITHUB_IDS: string;     // default '' (no operators)
  RATE_PER_USER_PUBLISH_HOURLY: string;     // default '5'
  RATE_PER_USER_REPORT_HOURLY: string;      // default '10'
  RATE_PER_IP_LIST_PER_MINUTE: string;      // default '60'
  INDEXER_BATCH_SIZE: string;               // default '100'
  /** CAIP-compatible EVM numeric chain id for the payment-channel pilot. */
  PAYMENT_CHANNEL_CHAIN_ID?: string;
}
