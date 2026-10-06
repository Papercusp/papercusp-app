# Money-journal and budget population locks
URL: /internal/docs/agent-insights/money-journal-population-lock-order

Verified local journal and budget writer ordering, retained census locks, and separate provider/cash authority.

## The measured lock cycle

A settlement's SELECT FOR UPDATE takes ROW SHARE on the rollup table. It then inserts a journal entry, acquiring ROW EXCLUSIVE there, and later UPDATEs the rollup, upgrading its table lock to ROW EXCLUSIVE. A full population reader that holds SHARE on rollups and waits for the journal write can cycle with that later upgrade. Ordering the reader's table locks alone does not prevent this.

The conventional money-journal.integration.test.ts suite distinguishes the causes in a disposable Postgres database: the old three lock phases produce exactly one 40P01 victim; the actual corrected settleUsageRollup is paused at its entry INSERT, and the census is observed waiting at its first rollup lock. After the writer is released both finish and the reader sees the committed rollup and entry. Proof: WI-10005829 thread-post:1159155, exact journal test\_runs:20828398 and budget test\_runs:20828399. These are working-source focused proofs, with exact source hashes and dirty-tree provenance on the work-item, rather than full-suite or shipment evidence.

## The existing source contract

settleUsageRollup explicitly takes ROW EXCLUSIVE on money\_journal\_rollups before inserting a journal entry. accrueUsageMicros already takes that mode with its first rollup INSERT. Migration1385 extends the existing lock\_hosted\_stripe\_funding\_population bridge: SHARE on rollups, micro-accruals, journal entries, lines, payment receipts and hosted billing customers, in that order. Locks are retained until the caller's transaction commits or rolls back, including empty tables. The service bridge keeps customer/app roles out and grants only selected read columns on rollups/accruals.

readLockedMoneyJournalPopulation(sql) requires READ COMMITTED and the same caller transaction throughout. It returns all LOCAL workspaces, currencies and times, exact individual accrual amounts, rollups, journal entries and lines. Workspace-local IDs stay separate. Global account acquisition precedes funding source acquisition. The population phase must never write these sources or invoke an append-owning collector: concurrent SHARE-to-write upgrades can deadlock. Do not transplant this read-only phase into reserve(), which inserts receipts in its transaction; first prove the complete organization/account/source/writer order and an appropriate write-compatible contract.

## Evidence remains local

No local journal, accrual, reservation or opaque providerLimitRef establishes an authenticated provider-account/invoice/generation join. Local population completeness does not establish provider completeness, paid settlement, cash backing or trusted policy/entitlement authority. Retain or refuse legacy/unmapped identities during reconciliation; do not assign them by amount or name. Production budget context and paid dispatch require those genuine authorities separately.

## Budget receipt writers and the full local history

Migration1388 adds a fixed 'budget-writer' phase to the EXISTING lock\_hosted\_stripe\_funding\_population bridge. The no-argument source phase retains its account-first contract. The new phase takes SHARE ROW EXCLUSIVE on hosted\_budget\_receipts before the organization lock; the store then preserves organization -> account -> source ordering. It rejects acquisition after advisory or source SHARE locks unless the writer fence is already held. This serializes receipt writers across organizations for the complete local census and permits the caller's own receipt INSERT without a later SHARE-to-write upgrade.

The hosted\_service role cannot directly take this lock mode under its SELECT/INSERT grants. A first conventional test run measured 'permission denied for table hosted\_budget\_receipts'; the restricted SECURITY DEFINER phase, owned by the existing table owner, acquires only this fixed lock. It adds no financial UPDATE/DELETE grants and rejects unknown/null phases. The full population reader requires the already-held fence rather than acquiring it late after the account or source phase.

readLockedHostedBudgetPopulation(sql) returns every local receipt revision plus one latest revision per control workspace, organization and reservation. It retains old windows, unknown admissions, exact fractional corrections and opaque provider-limit references. Arrays, receipts and scopes are frozen. READ COMMITTED, a retained writer fence and the same transaction are required; autocommit and stale snapshots refuse.

Conventional budget-store.integration.test.ts tests distinguish the unsafe pattern from actual writers: two SHARE holders upgrading to a writer produce exactly one 40P01 victim in disposable transactions. Actual reserve readers serialize under the early write-capable fence and both commit; an actual observation is visible after commit and rolls back atomically. Empty writer blocking, retained commit/rollback locks, compound identities, exact revisions, phase permissions and late-acquisition refusals are covered. Current working-source proof: test\_runs:20830042, 73 passed, including 10 new cases; source fingerprints and dirty-tree provenance belong on WI-10005829. Earlier budget20828399 is historical for its superseded source/test tuple; the unchanged journal20828398 remains a separate proof.

This local receipt population supplies no authenticated account/invoice/generation join or no-overlap deduction against provider bills or journal charges. Cash backing, trusted policy/entitlements, provider completeness and runtime paid admission remain independent requirements.

## A local admission-to-generation join stays separate from billing authority

The private OpenRouter generation capture now optionally carries the existing HostedBudgetExecutionGrant. Migration 1391 adds a nullable private field on the existing usage receipt, a trigger checking the original immutable revision-zero budget admission, and a partial unique index allowing one generation per local admission. The lookup matches the full control/organization/customer/reservation scope, month, key, maximum, provider-limit reference, policy identity/revision and original authority evidence. The admission must precede execution and be committed. Legacy captures stay unjoined; equal amounts, account-key names and opaque limit references never manufacture a mapping.

The writer freezes its input before awaiting, includes the grant in replay identity, and retains it through private collector reads and readLockedPopulation. Public receipt/statement normalization excludes it. A binding cannot acquire an existing generation by attaching, replacing or removing a grant on replay. Two distinct generation writers for one admission serialize at the unique index; the loser receives the existing replay-mismatch refusal. Direct SQL cannot bypass the exact admission trigger or the one-generation index.

Original admission reads add no budget, organization or account write lock. They do not invert the early budget fence ordering described above. The binding writer appends usage and therefore must not run inside a source SHARE-only census phase.

Conventional usage-store.integration.test.ts uses actual executeOnce with explicit fixture-only authority. The final armed-migration run, test\_runs:20831228, passed 31 cases (24 retained and 7 new); the separate OpenRouter source proof20831157 passed 47. WI-10005829 thread1159337 pins six full source/test/migration hashes and exact dirty-tree provenance. Neither result is a combined full-suite verdict or shipment. Three named paths typecheck with zero errors.

This is a persisted LOCAL admission join. A credential fingerprint identifies a key, not the provider billing account or invoice. Authentic provider-account census, final invoices/settlement, journal/provider/budget no-overlap liability terms, bank/cash backing, trusted policy and enforced provider maximum remain independent requirements. The production paid context/runtime remains uninstalled.
