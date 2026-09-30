# Social platform integrations — per-wave acceptance runbook
URL: /internal/docs/testing/social-platform-acceptance

What the connect→arm→inbound→draft→approve→reply→ledger loop is, which parts an agent can accept unattended, which parts are owner-walled at each wave, and the exact recipe for driving the two social surfaces in a real Tauri shell.

The social platform integrations (plan `social-platform-integrations-2026-08-23`)
ship as **three waves**, and acceptance is **per wave, not big-bang**. This page is
the runbook: what the full loop is, which parts an agent can accept on its own,
which parts only the owner can unblock, and the exact repeatable recipe for
driving the UI half in the real desktop shell.

## The loop being accepted

1. **Connect an account** — a `trigger_sources` row for the platform, with a credential.
2. **Arm a binding** — attach a plan to an event pattern (`ext:<platform>:…`). New bindings always install **off**; arming is a deliberate owner act.
3. **A live inbound event** arrives and launches the plan.
4. **An agent drafts a reply.**
5. **The owner approves** it.
6. **The reply lands on the platform.**
7. **The delivery ledger shows the full trace.**

## The honest split — read this before claiming acceptance

Steps 1–5 and 7 are exercisable with fixtures and a simulated inbound event.
**Step 6 — "the reply lands on the platform" — is owner-walled at every wave**,
and no amount of agent work clears it. It needs credentials (Wave A) or a
multi-week external review (Waves B and C). An agent that reports P-028 or any
wave as fully accepted without a live reply landing is reporting something it did
not verify.

What an agent CAN accept, per wave, unattended:

* the platform's adapter passing the shared conformance kit,
* the registry facts (wave, auth mode, transport, rate budget, `blockedOn`) rendering in the product,
* the binding composer prefilling storm caps from that platform's rate budget,
* the four cursor-freshness states rendering correctly,
* a simulated inbound → binding → run → ledger trace.

## Per-wave acceptance

Wave, platforms, and the wall are **derived from the platform registry**
(`packages/operator-core/lib/external-triggers/social/platform-registry.ts`) —
if a row below disagrees with that file, the file is right.

| Wave  | Platforms                                   | What blocks the LIVE half                                                                                                                                                                                                                                                 |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Bluesky, Mastodon, Reddit                   | **Owner credentials only** — a Bluesky app password, a Mastodon instance account, a Reddit app registration. No external review. This is the cheapest wave to take live.                                                                                                  |
| **B** | YouTube, Facebook Pages, Instagram, Threads | YouTube: owner approves the **Google incremental consent** screen once (scopes are additive on the existing Workspace connection). Facebook Pages / Instagram / Threads: **Meta app review** — identity, legal and business verification, multi-week lead time.           |
| **C** | LinkedIn, TikTok, X (Twitter)               | LinkedIn: **partner review** for organization/page access. TikTok: **TikTok audit** — unaudited apps cannot direct-publish, so v1 targets the draft/inbox path. X: **paid-tier purchase authorization**, a recurring cost outside agent authority under any mode (D-002). |

Wave A is the only wave whose wall is purely a credential. Waves B and C need
someone with legal/business standing to file with the vendor, so their code halves
are built and verified against fixtures and stay that way until the owner clears
the review.

## Driving the UI half in the real shell

UI here is **never** "unverifiable headless". The operator only renders correctly
inside Tauri, so never point a browser at `:3055`/`:3070`.

Boot your **own** isolated instance rather than driving a shell someone else
launched — a bridge you find with `probe` may be the owner's live desktop.

```sh
# 1. tauri-agent-tools is NOT on PATH on this box.
export PATH="$HOME/.local/node25/bin:$PATH"

# 2. The verifier REFUSES to launch without PAPERCUSP_SID (an unattributed
#    bridge could be confused with the owner's desktop). A server-side
#    capability:bash does NOT inherit it — pass it explicitly.
export PAPERCUSP_SID="<your su session id>"

# 3. Own Xvfb display + own devUrl port, sharing the live DB.
scripts/verify-tauri-headless.sh --boot-only
#    -> prints: source /tmp/verify-tauri-headless.<id>/env.sh
```

Then drive it, and **tear it down when done**:

```sh
source /tmp/verify-tauri-headless.<id>/env.sh
tauri-agent-tools check --pid "$VERIFY_TAURI_PID" --selector body --text 'Social (4)'
bash /tmp/verify-tauri-headless.<id>/stop.sh
```

Pass `VERIFY_TAURI_ISOLATED_DB=1` if you intend to click **write** paths — that
boots a throwaway migrated Postgres so every write is discarded at teardown. It
boots into first-run onboarding with an empty DB, so it is the wrong choice when
you need to see existing rows.

### Routes and params

| Surface               | URL                                                              |
| --------------------- | ---------------------------------------------------------------- |
| Social sources pane   | `/admin/triggers?view=sources&sources=social`                    |
| Plan binding composer | `/admin/plans?plan=<plan-slug>&ptab=triggers` → **Attach event** |

Two params bite:

* The plan-detail tab key is **`ptab`**, not `tab` — on `/adv` the shell owns `tab`, and sharing the key clobbered it.
* The plan is selected by **`plan=<slug>`**, and the plans rail is **click-driven with no anchor hrefs**.

### Assertions must be falsifiable

`eval` is for exploration — it exits 0 whether or not your hope was true, so no
transcript of it proves anything. Carry assertions with **`check`** (exit-coded),
and pair them with a **negative control** that must fail. A `screenshot` is
accepted evidence but is *not* falsifiable on its own: it writes a plausible file
even for a window that never painted, so open the image and confirm it painted.

Note `screenshot` requires `--selector` (or `--title`/`--window-id`); `--pid`
alone is an error.

A trap worth naming: querying `closest()` up from an `h1` lands on a small header
wrapper whose text is just the page title, which reads exactly like "the page
rendered its disabled shape". Query the real container (`.tr-tabs`, `.tr-card`,
`.pc-plan-dialog`) instead. An absence claim needs a positive control.

## Fixtures

No production code persists a social cursor yet, and there are normally **no
social `trigger_sources` rows at all**, so both panes are legitimately empty
until you seed. Create fixtures through the real
`createOwnedExternalTriggerSource` (not a raw INSERT), stamp them with a
recognisable `created_by`, and delete them by that stamp afterwards:

```ts
await createOwnedExternalTriggerSource(sql, {
  workspaceId: 'papercusp-workspace',
  kind: 'reddit',                       // the source's `kind` IS the platform id
  ownerUserId: '<owner uuid>',
  status: 'connected',
  cursor: { newestFullname: 't3_1p028ab' },
  config: { seededBy: 'p028-e2e-fixture' },
  createdBy: 'p028-e2e-fixture',
});
```

Seeding one source per cursor shape is what makes the four freshness states
visible in one pane:

| Seed cursor             | State rendered                                             |
| ----------------------- | ---------------------------------------------------------- |
| `{ seq, lastEventAt }`  | `synced · 3m ago`                                          |
| `{ newestFullname }`    | `advancing · … · no timestamp on this platform`            |
| `{}`                    | `never synced — no cursor persisted yet`                   |
| `{ bogusUnknownField }` | `unreadable cursor — matches no known social cursor shape` |

The third and fourth rows are the ones worth keeping in any future run: a healthy
Reddit source carries no timestamp **by design**, and collapsing that into "never
synced" is a false alarm the pane exists to avoid.

## What is verified today

Driven in a real Tauri shell (isolated display, live DB, fixtures seeded and
removed):

* The `sources=all|social` filter isolates social sources from non-social ones (`All (7)` / `Social (4)`).
* All four cursor-freshness states render distinctly and correctly.
* Three different rate-budget bases render — `conservative-default`, `rate-budget`, `quota-bucket`.
* A wave-B platform renders its `blockedOn` wall in the product itself.
* The binding composer prefills storm caps from the selected platform's budget and re-derives them when the source changes (Bluesky `12/300s` → Reddit `30/300s`), along with the `ext:<platform>:` pattern prefix.

Not verified, and not verifiable by an agent: **step 6 at any wave.**
