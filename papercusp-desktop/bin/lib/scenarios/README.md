# Federation live-matrix scenarios — author contract (Brief 13)

`bin/deb-hetzner-matrix.sh` is the **consolidated** live federation regression
runner (federation-release-hardening Brief 13). The Hetzner project is capped at
**2 concurrent servers (PERMANENT, owner-confirmed)**, so we do **not** run six
separate provision→teardown rigs (6 serialized = hours + 6× redundant setup).
Instead the matrix provisions **2 frames ONCE** (a=owner, b=member), publishes +
joins one pot, peers the swarm, then runs every contributed scenario in sequence
and prints a PASS/FAIL matrix — one shared live run for all of briefs 3-8.

You (a scenario author) contribute **one file**: `bin/lib/scenarios/<id>.sh`.

## The contract

Your file defines a function and registers it at source time:

```bash
# bin/lib/scenarios/b3-revocation.sh
scn_revocation_kcut() {
  # ... your scenario, using the rig_*/fed_* primitives ...
  # return 0 = PASS, non-zero = FAIL. Echo ONE result line to stdout.
  echo "revoked member B correctly stopped receiving + cannot decrypt post-boundary"
}
matrix_register revocation_kcut 90 "revocation + epoch K-cut" scn_revocation_kcut
#                ^id            ^order ^label                  ^fn
```

`matrix_register <id> <order> <label> <fn>` — call it at the **top level** of your
file. The matrix sources every `bin/lib/scenarios/*.sh`, sorts by `<order>`, and
calls each `<fn>` in turn, in the current shell.

### Inputs your `scn_*` can rely on (set before ANY scenario runs)

| global | meaning |
|---|---|
| `RIG_FRAMES=(a b)` | frame `a` = **OWNER**, frame `b` = **MEMBER** (2-frame run) |
| `FRAME_IP[a]` / `FRAME_IP[b]` | public IPs |
| `FED_PG[a/b]` / `FED_SC[a/b]` | embedded-PG + sidecar ports |
| `FRAME_MEMBER_SLUG[a/b]` | each frame's joined pot member slug |
| `RIG_HIVE_ID` / `RIG_HIVE_PUBKEY` / `RIG_HIVE_LINK` | the published pot |
| `MATRIX_RUN_ID` | unique-per-run tag — **suffix your ids with it** |

The pot is already published (owner from-repo), all frames joined, and the swarm
`peer_connected` a↔b **before** your scenario runs. You start from a healthy,
federating 2-node pot.

### Primitives (sourced: `federation-asserts.sh` + `deb-hetzner-rig.sh`)

- **content:** `rig_write_content <inst> <slug> <fid> [title] [status]` ·
  `rig_read_content <inst> <fid>` → `"<slug>|<origin>"` · `rig_read_roster <inst>`
- **positive asserts:** `fed_hive_merge_probe <src> <dst> <src_slug> <fid> [tries]`
  → `"1 <slug>"`/`"0"` · `fed_plan_part_merge_assert <src> <dst> <slug> [tries]` →
  `1`/`0` · `fed_coord_merge_probe <src> <dst> <src_slug> <tag> [tries]` → `1`/`0`
- **negative asserts:** `rig_assert_absent <inst> <fid> [tries]` → `1` (correctly
  absent) / `0` (leaked) · `rig_assert_row_absent <inst> "<table> WHERE <pred>" [tries]`
  → `1`/`0`
- **SSH driver:** `rig_driver_run <inst> -- <cmd…>` (root) · `rig_pcusp_run <inst>`
  (pcusp user, stdin script) · `drv_exec <inst>` (root, stdin) · `drv_psql <inst> <sql>`
- **lifecycle:** `rig_kill_sidecar <inst>` (offline, keep pgdata) ·
  `rig_restart_sidecar <inst>` (relaunch) · `rig_wait_frame_ready <inst>`
  (re-discover `FED_PG`/`FED_SC` after a restart)

### Diagnostics that must survive a PASS

The matrix only ever prints your scenario's **last non-blank line** on PASS,
plus any line that starts with a `·` marker (WI-6057). If you add a diagnostic
dump (e.g. a `drv_psql` read to witness some internal state) and want it to
show up on a PASSING run — not just on FAIL, where the last-12-lines tail
already covers you — **every line of it must carry that marker**, or it is
silently dropped and looks identical to the dump never having run
(EI-18762718908280875).

Don't hand-write the marker with your own `sed`/`awk` — pipe through the
shared helper instead, so it can't be typo'd or "tidied" away later:

```bash
echo "  · my diagnostic — what this shows and why"
drv_psql a "SELECT …" 2>&1 | scn_diag "a: "   # scn_diag (federation-asserts.sh)
```

`scn_diag [prefix]` prefixes every line with the marker plus your optional
`prefix` (use a frame label like `"a: "` / `"b: "` when dumping the same
query against multiple frames, so the rows stay disambiguated).

1. **Do NOT provision or tear down VMs.** The matrix owns the lifecycle.
2. **Be self-bounding.** Use the bounded `fed_*`/`rig_assert_*` helpers (they cap
   their own polling). Never an unbounded `while true`/poll — scenarios run
   **in-process**, so a hang wedges the whole matrix.
3. **`return`, never `exit`.** An `exit` kills the matrix run (the EXIT-trap still
   tears down servers=0, but you lose the rest of the matrix).
4. **Leave the frames HEALTHY for the next scenario** — UNLESS you are a
   terminal/destructive scenario (revocation/ban), which registers with order ≥90 to
   run **last**. If you restart a sidecar, `rig_restart_sidecar` it back +
   `rig_wait_frame_ready` before returning.
5. **Unique ids per run.** Suffix feature_ids/msg_ids with `$MATRIX_RUN_ID` so
   scenarios don't alias each other.
6. **Write under the real workspace.** Prefer `rig_write_content` (it already does
   `COALESCE((SELECT workspace_id FROM hive_members LIMIT 1),'default')` — a bare
   INSERT defaulting to `'default'` never drains, D-050).

### Order convention (the `<order>` arg)

- **10–40** — non-destructive content/comms (content, plan-part, coord, concurrent,
  coord control-plane). Leave frames healthy.
- **50–70** — disruptive-but-restorative (reconnect/offline-catchup, restart
  durability). MUST restore healthy.
- **71–79** — **terminal/destructive, but the member still works** (e.g.
  attestation_unattested_device/79 strips one member's device attestations on the
  owner frame). May leave narrow admission state mutated for the rest of the run.
  ⚠ Below 80 **on purpose**: a leg here holds an ANTI-MONOTONE precondition (a
  value removed locally), and the churn legs at 80–89 reconnect the swarm, which
  makes each member re-announce — and both writers of a member row restore an
  announced device (the projection replaces from a newer remote op; the admission
  path UNION-merges with no clock guard at all). A leg of this shape registered
  above the churn band has its precondition silently undone mid-flight and reports
  a product defect that is not there. Registering ABOVE 80 is a real ordering
  decision — read `b9-attestation.sh`'s ORDERING INVARIANT header first.
- **80–89** — **churn** (restart durability, settle barrier, reconnect/catch-up,
  replication soak). Restart/reconnect-heavy; MUST restore healthy frames.
- **90+** — **member-disabling** (revocation/ban k-cut). Runs LAST; may leave the
  member unable to receive **or send**.

> ⚠ **Ordering rule INSIDE the terminal band — "runs LAST" is not a property two
> scenarios can both have.** A member-ban leg (`revocation_kcut`/90) revokes the
> member's pubkey, and revocation is **sticky/monotone** — once it runs, that member
> can no longer send or receive **for the rest of the run**. So any scenario that
> needs the member to still SEND must be registered **strictly below 90**. Do not
> add a scenario at 91+ without re-reading this.
>
> This is not hypothetical: `attestation_unattested_device` was registered at **91**,
> after the ban. It dutifully followed the old "terminal ⇒ 90+, runs LAST" wording,
> and its probe — a receipt B must federate to A — was silently blocked at A's
> admission on every run. It reported `identity_unresolved 0→0`, which reads as a
> product defect, and red-pinned the standing release gate 3/3, blocking first-green
> for hours (WI-5064). The band rule, not either scenario, was the bug. Guard:
> `packages/operator-core/lib/matrix-scenario-terminal-order-guard.test.ts`.

### Hand-off + self-check

- Either drop your `bin/lib/scenarios/<id>.sh` file in the tree (the matrix
  auto-sources it) **or** send the function text to **su-8b360** and I'll wire it.
- `bin/deb-hetzner-matrix.sh --list` prints the registered scenarios **without
  provisioning** — confirm yours registered.
- `bash -n bin/lib/scenarios/<id>.sh` syntax-checks your file.

See **`00-base.sh`** for three working reference scenarios (content / plan-part /
coord, A↔B) you can copy.

## Running the matrix

The consolidated runner is **`bin/deb-hetzner-matrix.sh`** (federation-release-hardening
Brief 13).

- **List (no provision, ~free):** `bin/deb-hetzner-matrix.sh --list` — sources every
  scenario file and prints what's registered, sorted by `<order>`. Confirm your file
  wired in **before** spending a live run.
- **Full live run (COSTS REAL MONEY):** `bin/deb-hetzner-matrix.sh [--deb=PATH]` —
  provisions **2 Hetzner frames ONCE** (a=owner, b=member), publishes + joins one pot,
  peers the swarm, then runs every registered scenario in `<order>` **in the current
  shell** (so a scenario's `rig_wait_frame_ready` port re-discovery persists across
  scenarios), prints a PASS/FAIL matrix, and auto-destroys (EXIT-trap → **servers=0**).
  Exit 0 = every scenario green.
  - `--only=id1,id2` runs a subset · `--locs=ash,nbg1` splits regions (Brief 8) ·
    `--type=cpx31` server type · `--keep-up` leaves frames up (**you** must then destroy
    them manually).
  - npm alias: `npm run --prefix papercusp-desktop test:federation:live-matrix`.

## ⚠ CI / cron — opt-in + gated, NEVER on push

A matrix run provisions REAL Hetzner servers (real money) and needs live secrets
(`HCLOUD_TOKEN`, the SSH identity, `gh` auth for papercupai + ownerhandle), so it is
**manual / opt-in only** — do NOT add it to the automatic push/PR CI. The supported
invocations are the one-command runs above (or the npm alias). If a scheduled
regression cadence is ever wanted, wire it as a **manual-dispatch** job (never a
push/PR trigger) that a human fires, with the Hetzner + gh secrets injected at dispatch
time. `servers=0 after every run` is the invariant the cost-safety EXIT trap enforces —
never disable it, and never leave a run `--keep-up` in an unattended job.
