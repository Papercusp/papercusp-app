# The default blind relay: what Papercusp runs, what it can see, how to opt out
URL: /internal/docs/privacy/default-blind-relay

Papercusp ships one default blind-relay key (b1015b56…) that peers on the public DHT fall back through when they cannot holepunch. It forwards end-to-end encrypted streams and cannot read content, but it does see pairing metadata (peer keys, IPs, timing, volume). Opt out with PAPERCUSP_RELAY_DEFAULTS=0. Its GCP egress is capped by a monthly budget the daemon enforces.

## What it is

Two Papercusp peers normally connect directly: hyperdht holepunches a UDP path between them. Some pairs cannot holepunch (both behind randomized or carrier-grade NAT, the same NAT without hairpin, client-isolating Wi-Fi). For those pairs the voice and sync swarms fall back through a **blind relay**: a reachable hyperdht node that pairs the two peers and forwards their packets.

Papercusp runs one such relay and ships its public key in every build:

|            |                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public key | `b1015b569f617f58d68a41542a3f42ba0765909ffee43379a96d4c7c9cf49f4c` (`DEFAULT_RELAY_KEYS` in `packages/operator-core/lib/voice-node/voice-relay.ts`) |
| Host       | GCE e2-micro `pc-blind-relay-1`, project `papercusp-hosted-workspaces`, zone `us-central1-c`                                                        |
| Service    | `papercusp-blind-relay.service`, running the bundled `scripts/relay/blind-relay-daemon.ts`                                                          |
| Managed by | `scripts/relay/provision-relay-vm.sh up \| verify \| status \| down`                                                                                |

The seed behind the key never enters the repo; it lives at `~/.papercusp/relay/seed.hex` on the provisioning machine and in `/opt/papercusp-relay/seed.hex` on the VM. Rotating the key means a new release, because the key is compiled into the client.

## What the relay can and cannot see

**It cannot read content.** Each relayed connection is the two peers' own NoiseSecretStream; the relay forwards its UDX packets and never holds the session keys. End-to-end encryption is preserved through the relay by construction.

**It does see pairing metadata:**

* the public keys of the two peers it pairs, and the pairing token they present;
* both peers' IP addresses and ports;
* when a pairing starts and ends;
* how many bytes flow, in each direction.

The daemon logs only aggregate counters (sessions, pairings, streams, and the month's egress bytes) plus stream error messages. It does not log peer keys or IPs. That is a property of the current daemon code, not a cryptographic guarantee: whoever operates the VM could observe the metadata above.

## When it applies, and how to opt out

The default key is added to a swarm's `relayThrough` only when **all** of these hold (`defaultRelayKeysApply`):

1. `PAPERCUSP_RELAY_DEFAULTS` is not `0`;
2. the swarm is on the **public** DHT (no custom `PAPERCUSP_DHT_BOOTSTRAP`), because a private or isolated DHT cannot reach a public-DHT relay;
3. a declared private bootstrap did not silently fall back to the public DHT (`bootstrapMisconfigured`). That case fails closed: an operator who asked for a private network is never routed through Papercusp's relay because of a config typo.

**Opt out:** set `PAPERCUSP_RELAY_DEFAULTS=0` in the Server's environment. Pairs that cannot holepunch will then not connect unless you supply your own relay.

**Use your own relay instead (or as well):** list its hex public key in `PAPERCUSP_VOICE_RELAY_KEYS` (comma-separated), or in the operator-state row `voice_relay.relayKeys`. Configured keys are tried before the default. Any operator can serve one: set `voice_relay.serve = true` and hand out the printed key.

## Cost bound: the monthly egress budget

The relay is open to anyone on the public DHT, and an e2-micro can push roughly 1 Gbps, so the cost risk is **GCP internet egress**, not CPU. The daemon enforces a monthly egress budget (WI-10004956):

* Each check (every 30 s by default) it reads the VM's transmit bytes from `/proc/net/dev` (all non-loopback interfaces) and charges the delta to the current **UTC** month. That counts relayed traffic and the DHT node's own background traffic, which is exactly what GCP bills.
* Usage persists in `/opt/papercusp-relay/egress-state.json`, so a restart or reboot does not reset the month. When the kernel counter resets after a reboot, everything since the reboot is charged.
* Once the month's usage reaches the budget, the daemon logs `egress-budget-exhausted`, closes the relay **and its DHT node** (egress stops), and stays up suspended. At the next UTC month it logs `egress-budget-reset` and serves again.
* Overshoot is bounded by one check interval: at 1 Gbps, 30 s is about 3.75 GB.
* If the guard is on and the transmit counter cannot be read at boot, the daemon refuses to start. A cost guard that cannot measure fails loudly instead of serving unbounded.

The default budget is **50 GB per UTC month** (`DEFAULT_EGRESS_BUDGET_GB`; provisioning passes `RELAY_EGRESS_BUDGET_GB`, default 50). At an assumed premium-tier list price of about $0.12/GB, that caps relay egress near **$6/month**. Check the project's billing for the actual rate. Change it with `RELAY_EGRESS_BUDGET_GB=<n> scripts/relay/provision-relay-vm.sh up`; `0` turns the guard off.

**Reading usage.** Every `stats` line (every 300 s) carries `egress: { month, usedBytes, budgetBytes, usedPct }` and `serving`. `scripts/relay/provision-relay-vm.sh status` prints the last log lines and the state file.

**Measured baseline** (2026-10-01, about 4 h after boot, 6 drill sessions): 34 MB transmitted, almost all DHT background. That extrapolates to about 6 GB/month idle, well inside the budget. There is no load data yet for real relayed traffic.

## When the budget trips

Only pairs that *needed* the relay are affected: they cannot connect until the month rolls over or the budget is raised. Pairs that holepunch directly never touch the relay. If the budget trips from legitimate use, raise it deliberately and record why; if it trips from abuse, the suspension is the intended outcome.
