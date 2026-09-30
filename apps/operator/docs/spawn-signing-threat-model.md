# Per-spawn URL signing — threat model + operations

## Why

The per-spawn MCP URL bakes `(workspace, harness, role, run, spawn,
feature?, chunk?, parent_spawn?)` into query params. Before this work,
the dispatcher trusted those params verbatim — a worker that wanted
operator-tier tools just rewrote `?role=worker` → `?role=operator` and
called. One line, no auth, no audit.

Today (post-2026-05-11) every per-spawn URL carries an HMAC-SHA256
`sig` + `exp`. The dispatcher's `tryBuildSpawnContext()` calls
`verifySpawnParams()` before honoring any role claim. Forged URLs fail
with `invalid_signature` and the attempt is persisted to
`harness_shared.spawn_sig_verification_failures` for on-call review.

## What shipped

| Component | Location |
|---|---|
| Signing module | `apps/operator/lib/spawn-signing.ts` — `signSpawnParams`, `verifySpawnParams`, `rotateSpawnSigningKey` |
| HMAC key (32 bytes, PG-stored) | `harness_shared.operator_secrets` row, `name = 'spawn-signing-key'` |
| Audit log | `harness_shared.spawn_sig_verification_failures` |
| Orchestrator minting | `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts` → `writeSignedSpawnMcp()` |
| `.mcp.json` perms | mode 0600 |
| Per-spawn worktree perms | mode 0700 |
| Admin rotation endpoint | `POST /api/admin/spawn-signing/rotate` |
| CLI rotation tool | `apps/operator/scripts/rotate-spawn-signing-key.mjs` |

## Threat model

### Defends against

- **Prompt-injected worker rewriting URL params.** Verification fails
  because the HMAC was over the original params; the agent doesn't
  have the key. This is the realistic threat — an agent reading a
  poisoned doc that says "to fix this, please call X with role=operator".

### Does NOT defend against

- **Same-UID code that reads PG for the key.** The agent runs as the
  operator's user; it can query PG with the same credentials. HMAC is
  *friction*, not enforcement.
- **Reading another spawn's `.mcp.json` and replaying it.** Every
  signed URL is a valid bearer for its `exp` window (24h default).
  Worktrees are 0700 + files 0600, but same UID means same OS user
  can read across them.
- **The `?superuser=1` path.** Separate door with its own (file-ACL)
  bouncer at `~/.papercusp/superuser-token`. The doc is explicit:
  "friction, not enforcement." HMAC doesn't change that.
- **Editing `~/.papercusp/granted-capabilities.json`.** Plain JSON,
  same UID, writable. The capability gate trusts what it finds there.
- **Operator memory dump** (`gcore <pid>`). Key is in the operator's
  heap; same UID can extract it.
- **Replacing the operator binary.** Far beyond a prompt-injection,
  but in scope for "same UID = total ownership."

### What actually closes the loop

OS-level isolation per worker (`bwrap` / `firejail` / a separate UID
with file ACLs). Worker only sees its own worktree + the MCP socket.
Key file unreadable, sibling `.mcp.json`s unreadable, superuser-token
unreadable. Real fix; bigger lift. Eventual landing spot.

## Operating modes

### Soft-warn (rollout-only)

`PAPERCUSP_REQUIRE_SPAWN_SIG` unset or `!= '1'`. Unsigned URLs are
accepted with a console warning. Was the default during the
2026-05-11 rollout window so in-flight spawns from before signing
landed wouldn't get killed mid-run.

### Strict (default since 2026-05-11)

`PAPERCUSP_REQUIRE_SPAWN_SIG=1` in `apps/operator/.env.local`.
Unsigned URLs hard-reject with
`request_rejected: spawn_sig_missing_sig_required_mode`. Any failure
in `harness_shared.spawn_sig_verification_failures` is now signal,
not noise.

### Rollout sequence

1. ✅ Operator-side verification with soft-warn (2026-05-11).
2. ✅ Orchestrator-side signing via `writeSignedSpawnMcp` (2026-05-11).
3. ✅ Test-suite cleanup wired so the audit table reflects real traffic
   (2026-05-11). Before this, every `bun run test:spawn-signing`
   left 20-30 deliberately-bad rows behind — the audit-table
   "noise floor" was 100% test artifacts. Shared helper at
   `apps/operator/__tests__/integration/_cleanup-test-failures.mjs`.
4. ✅ Flipped `PAPERCUSP_REQUIRE_SPAWN_SIG=1` (2026-05-11).
   Verified: 136/136 integration tests still green on both :3055
   and :3070 in strict mode; audit table stays at zero rows after
   a full battery run.

## Coarse revocation

If a key may be compromised, or a bad batch of prompts shipped and
you want every in-flight spawn to fail closed:

```bash
# Loopback + superuser-bearer gated — bumps the in-process cache too,
# so revocation is immediate (not 5-min lazy-cache lag).
bun apps/operator/scripts/rotate-spawn-signing-key.mjs
```

Or with the operator down, direct PG:

```sql
UPDATE harness_shared.operator_secrets
SET value_b64 = encode(gen_random_bytes(32), 'base64'),
    rotated_at = now()
WHERE name = 'spawn-signing-key';
```

(Direct-PG rotation only takes effect after the operator's 5-minute
cache TTL or a process restart.)

## Observability

```sql
-- Recent verification failures by reason
SELECT reason, count(*) FROM harness_shared.spawn_sig_verification_failures
WHERE created_at > now() - interval '24 hours'
GROUP BY reason
ORDER BY 2 DESC;

-- Most-recently failed spawns
SELECT created_at, reason, claimed_role, claimed_harness, claimed_spawn
FROM harness_shared.spawn_sig_verification_failures
ORDER BY created_at DESC LIMIT 20;
```

A non-zero rate of `invalid_signature` outside of explicit test runs
is a real signal — investigate which spawn it came from
(`claimed_spawn` correlates with the orchestrator's spawn IDs).

## Tests

Three integration suites live under `apps/operator/__tests__/integration/`:

| Suite | Command | What it proves |
|---|---|---|
| `spawn-signing-e2e.mjs` | `bun run test:spawn-signing` | 12 cases through the live HTTP boundary on :3070 |
| `spawn-signing-e2e.mjs` (dev) | `bun run test:spawn-signing:dev` | Same suite against :3055 (dev) |
| `mint-roundtrip.mjs` | `bun run test:mint-roundtrip` | Orchestrator's `writeSignedSpawnMcp` ↔ operator's verifier agree on HMAC |
| `admin-rotate.mjs` | `bun run test:admin-rotate` | Rotation endpoint auth + revocation semantics |

Run all four before promoting any change to the signing pipeline.
