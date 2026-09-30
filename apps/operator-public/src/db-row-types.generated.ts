/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: apps/operator-public/migrations/*.sql applied in filename order
 * Migration digest: cbd35dbf58fb628f50c1530d3d5b7183d65b6a3d0df6e68d5bd305a53d3ce065
 * Regenerate with: npm run db:types:generate --workspace @papercusp/cupboard-worker
 */

export const GENERATED_MIGRATION_DIGEST =
  "cbd35dbf58fb628f50c1530d3d5b7183d65b6a3d0df6e68d5bd305a53d3ce065";
export const GENERATED_TABLES = [
  "audit",
  "banned_publisher_pubkeys",
  "commerce_entitlements",
  "commerce_event_log",
  "commerce_ledger_events",
  "commerce_offers",
  "commerce_orders",
  "commerce_payouts",
  "commerce_products",
  "commerce_refunds",
  "commerce_webhook_inbox",
  "creator_drafts",
  "harnesses",
  "indexer_runs",
  "payment_channels",
  "prepaid_credit_balances",
  "prepaid_credit_events",
  "prepaid_credit_reservations",
  "publish_rate_limit",
  "reports",
  "settlement_batch_vouchers",
  "settlement_batches",
  "treasury_safe_deployments",
  "treasury_transfers",
  "usage_receipts",
  "wallet_binding_challenges",
  "wallet_bindings",
] as const;

export interface AuditRow {
  id: number;
  ts: number;
  kind: string;
  detail: string | null;
}

export interface BannedPublisherPubkeysRow {
  pubkey: string;
  reason: string;
  added_at: number;
  added_by_operator_user_id: number | null;
  updated_at: number;
}

export interface CommerceEntitlementsRow {
  entitlement_id: string;
  order_id: string;
  product_id: string;
  buyer_id: string;
  state: string;
  granted_at_ms: number;
  revoked_at_ms: number | null;
  revoke_reason: string | null;
}

export interface CommerceEventLogRow {
  event_id: string;
  stream_id: string;
  kind: string;
  version: number;
  issuer: string;
  sequence: number;
  occurred_at_ms: number;
  idempotency_key: string;
  payload: string;
  signature: string;
  recorded_at_ms: number;
}

export interface CommerceLedgerEventsRow {
  ledger_event_id: string;
  kind: string;
  occurred_at_ms: number;
  provider: string;
  provider_event_id: string | null;
  payload_json: string;
}

export interface CommerceOffersRow {
  offer_id: string;
  product_id: string;
  pricing_model: string;
  amount_minor: number;
  currency: string;
  active: number;
  unit_price_micros: number | null;
  meter_unit: string | null;
  price_version: string | null;
  split_manifest_hash: string | null;
}

export interface CommerceOrdersRow {
  order_id: string;
  offer_id: string;
  product_id: string;
  buyer_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  provider: string | null;
  provider_ref: string | null;
  refunded_minor: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommercePayoutsRow {
  payout_id: string;
  creator_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  provider: string | null;
  provider_ref: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommerceProductsRow {
  product_id: string;
  sku_ref: string;
  creator_id: string;
  title: string;
  active: number;
}

export interface CommerceRefundsRow {
  refund_id: string;
  order_id: string;
  amount_minor: number;
  currency: string;
  state: string;
  provider: string | null;
  provider_ref: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CommerceWebhookInboxRow {
  provider: string;
  provider_event_id: string;
  provider_event_type: string | null;
  body_digest: string;
  received_at_ms: number;
  outcome: string;
  rejection_code: string | null;
  ledger_event_ids_json: string;
}

export interface CreatorDraftsRow {
  id: string;
  owner_github_user_id: number;
  owner_github_login: string;
  listing_kind: string;
  listing_ref: string | null;
  title: string;
  description: string | null;
  manifest_json: string;
  provenance_json: string;
  state: string;
  artifact_key: string | null;
  artifact_content_hash: string | null;
  artifact_size_bytes: number | null;
  artifact_content_type: string | null;
  upload_token_hash: string | null;
  upload_expires_at: number | null;
  reviewed_at: number | null;
  reviewed_by_github_user_id: number | null;
  review_reason: string | null;
  published_listing_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface HarnessesRow {
  id: string;
  listing_kind: string;
  blueprint_kind: string | null;
  project_ref: string | null;
  listing_ref: string | null;
  github_repository_id: number;
  github_owner: string;
  github_name: string;
  github_url: string;
  title: string;
  description: string | null;
  topic_hex: string | null;
  publisher_github_user_id: number;
  publisher_github_login: string;
  publisher_permission: string | null;
  publisher_device_pubkey: string | null;
  publisher_attestation_gist_id: string | null;
  claim_status: string;
  claimant_github_user_id: number | null;
  claimant_github_login: string | null;
  superseded_by: string | null;
  stars: number;
  contributor_count: number;
  last_activity_at: number | null;
  languages: string | null;
  stats_refreshed_at: number | null;
  created_at: number;
  updated_at: number;
  unlisted_at: number | null;
  unlisted_reason: string | null;
  tarball_r2_key: string | null;
  tarball_content_hash: string | null;
  tarball_bytes: number | null;
  provides_tools: string | null;
  hive_pubkey: string | null;
  hive_title: string | null;
  review_status: string;
  reviewed_at: number | null;
  review_reason: string | null;
  provides_events: string | null;
  requires_events: string | null;
  delivery_type: string | null;
  latest_json_url: string | null;
  release_repo: string | null;
  icon_url: string | null;
  platforms: string | null;
  requires_rubrics: string | null;
  visibility: string;
  tenant_id: string | null;
  sku_ref: string | null;
  pricing_model: string | null;
  price_amount_micros: number | null;
  price_currency: string | null;
  compatibility_json: string | null;
  required_permissions: string | null;
  release_version: string | null;
  release_content_hash: string | null;
  release_manifest_digest: string | null;
  release_signature: string | null;
  release_published_at: number | null;
  yanked_at: number | null;
  yanked_reason: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  pinned_commit_sha: string | null;
  pinned_tree_digest: string | null;
  pinned_at: number | null;
  release_manifest: string | null;
  uses_tools: string | null;
  identity_surface: string | null;
}

export interface IndexerRunsRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  harnesses_examined: number;
  harnesses_updated: number;
  errors_count: number;
  error_summary: string | null;
}

export interface PaymentChannelsRow {
  channel_id: string;
  principal_id: string;
  rail: string;
  chain_id: number;
  stablecoin_address: string;
  settlement_contract_address: string;
  funding_source: string;
  funding_ref: string;
  wallet_address: string | null;
  escrow_micros: number;
  committed_micros: number;
  refunded_micros: number;
  state: string;
  open_tx_hash: string | null;
  open_block_number: string | null;
  close_tx_hash: string | null;
  close_block_number: string | null;
  failure_code: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  closed_at_ms: number | null;
}

export interface PrepaidCreditBalancesRow {
  principal_id: string;
  available_micros: number;
  reserved_micros: number;
  spent_micros: number;
  debt_micros: number;
  granted_micros: number;
  reversed_micros: number;
  updated_at_ms: number;
}

export interface PrepaidCreditEventsRow {
  credit_event_id: string;
  kind: string;
  occurred_at_ms: number;
  principal_id: string;
  payload_json: string;
}

export interface PrepaidCreditReservationsRow {
  reservation_id: string;
  principal_id: string;
  channel_id: string;
  reserved_micros: number;
  committed_micros: number;
  state: string;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PublishRateLimitRow {
  github_user_id: number;
  window_start: number;
  count: number;
}

export interface ReportsRow {
  id: string;
  harness_id: string;
  reporter_github_user_id: number;
  reporter_github_login: string;
  reason: string;
  ip_hash: string | null;
  status: string;
  resolved_at: number | null;
  resolved_by_operator_note: string | null;
  created_at: number;
}

export interface SettlementBatchVouchersRow {
  batch_id: string;
  channel_id: string;
  usage_nonce: string;
  voucher_digest: string;
  cumulative_claim_micros: number;
}

export interface SettlementBatchesRow {
  batch_id: string;
  channel_id: string;
  principal_id: string;
  request_hash: string;
  chain_id: number;
  settlement_contract_address: string;
  stablecoin_address: string;
  claim_micros: number;
  prior_cumulative_micros: number;
  cumulative_claim_micros: number;
  voucher_digests: string;
  settlement_id: string;
  split_manifest_hash: string;
  allocations_micros: string;
  provider_cost_micros: number;
  distributable_micros: number;
  dao_treasury: string;
  receipt_hash: string;
  state: string;
  required_confirmations: number;
  confirmations: number;
  claim_tx_hash: string;
  claim_block_number: string;
  claim_block_hash: string;
  refund_tx_hash: string | null;
  refund_block_number: string | null;
  freeze_reason: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  finalized_at_ms: number | null;
}

export interface TreasurySafeDeploymentsRow {
  chain_id: number;
  safe_address: string;
  roles_module_address: string;
  roles_version: string;
  deployment_tx_hash: string;
  network: string;
  owners: string;
  threshold: number;
  automation_signer: string;
  deployed_at_ms: number;
  recorded_at_ms: number;
  recorded_by: string;
}

export interface TreasuryTransfersRow {
  transfer_id: string;
  batch_id: string;
  channel_id: string;
  principal_id: string;
  settlement_id: string;
  receipt_hash: string;
  split_manifest_hash: string;
  share: string;
  role: string;
  chain_id: number;
  safe_address: string;
  roles_module_address: string;
  token: string;
  recipient: string;
  amount_micros: number;
  safe_tx_hash: string;
  transaction_hash: string;
  block_number: string;
  proof_event_id: string | null;
  created_at_ms: number;
}

export interface UsageReceiptsRow {
  channel_id: string;
  usage_nonce: string;
  principal_id: string;
  offer_id: string;
  payer: string;
  seller: string;
  release_ref: string;
  meter_unit: string;
  meter_quantity: number;
  unit_price_micros: number;
  price_version: string;
  split_manifest_hash: string;
  reserved_micros: number;
  amount_micros: number | null;
  cumulative_claim_micros: number;
  expires_at_ms: number;
  voucher_digest: string;
  voucher_signature: string;
  receipt_signature: string | null;
  state: string;
  reserved_at_ms: number;
  settled_at_ms: number | null;
}

export interface WalletBindingChallengesRow {
  challenge_id: string;
  principal_id: string;
  wallet_address: string;
  chain_id: number;
  nonce: string;
  domain: string;
  uri: string;
  message: string;
  issued_at_ms: number;
  expires_at_ms: number;
  consumed_at_ms: number | null;
  consumed_token: string | null;
}

export interface WalletBindingsRow {
  principal_id: string;
  wallet_address: string;
  chain_id: number;
  challenge_id: string;
  verified_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}
