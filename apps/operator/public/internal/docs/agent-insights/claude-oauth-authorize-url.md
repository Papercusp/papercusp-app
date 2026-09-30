# You CANNOT hand-build a Claude Max OAuth link — claude.ai needs claude-code's own handshake; use `claude setup-token`
URL: /internal/docs/agent-insights/claude-oauth-authorize-url

Linking a Claude Max account by having the owner click a hand-built claude.ai authorize URL does NOT work — claude.ai returns "Authorization failed Invalid request format" even for a URL byte-for-byte identical to what `claude setup-token` generates. claude.ai requires the claude-code client's own handshake, which a plain browser click can't reproduce. The ONLY working path is `claude setup-token` (the CLI does the handshake) → paste the sk-ant-oat token / .credentials.json. Stop re-attempting the in-app OAuth link.

import { Aside } from '@astrojs/starlight/components';

The title/description on this page still say "you CANNOT hand-build a Claude Max OAuth link" / the in-app OAuth link "does NOT work" / "Stop re-attempting the in-app OAuth link." **That is no longer true.** The in-app one-click OAuth link is now the **working default**. The historical dead-end narrative below is preserved intentionally (it is the WHY the current flow exists), but read it as history.

* **The in-app one-click OAuth IS the working default.** `apps/operator/app/settings/deploy-accounts/page.tsx:68` defaults `linkMode` to `'oauth'` (the "🔗 One-click (browser login)" tab), not the paste path. It works because it spawns the **real `claude setup-token` CLI in a pty server-side** and relays the URL the CLI itself prints, so claude.ai accepts it (`packages/operator-core/lib/deployment/account-link-cli.ts:2-3` header "the WORKING …flow"; `:139` `spawn(process.env.CLAUDE_BIN || 'claude', ['setup-token'], …)`).
* **`account-link-store.ts` no longer exists.** The "Where it lives" section below cites it as the place the OAuth URL is built; it was removed as orphaned dead code and replaced by `packages/operator-core/lib/deployment/account-link-cli.ts` (`account-link-cli.ts:6-8` records the removal). The hand-built-URL approach it embodied is gone.

The pty-driven CLI flow, the D-017 Enter-after-settle fix, the `OUTCOME_RE` fast-fail, the paste fallback, and the `client_id 9d1c250a-…` are all still accurate — see the CURRENT STATE header immediately below.

## CURRENT STATE (2026-06-17, D-016/D-017) — the in-app one-click WORKS; the real stall was the code→token Enter

The hand-built-URL dead-end (below) is HISTORY. **D-016** replaced it: the in-app
"🔗 One-click (browser login)" now spawns the **real `claude setup-token` in a pty**
(`deployment/account-link-cli.ts`), relays the URL the CLI itself prints, and pipes the
owner's pasted `code#state` back into that same held process — so claude.com accepts it (the
CLI did its own handshake). Authorize works; this is the DEFAULT add-account path now.

**The leg that then stalled** ("Linking…" forever) was the code→token completion — the one
leg no test could cover (needs a real approval; the plan's `Now`/`Next` flagged exactly this).
Root cause, proven against **claude CLI v2.1.181** with a node-pty probe:

* `claude setup-token` is now a full **Ink TUI** (animated banner + spinner + a **masked**
  code input), not a line prompt.
* Feeding the code as a single ``pty.write(`${code}\r`)`` pastes it but the **trailing CR is
  absorbed into the paste** — the code is NEVER submitted, no token is minted, and the 60s
  `readUntil` times out → the stall.
* **Fix (D-017):** paste the code, then send Enter (`\r`) as a **SEPARATE `pty.write` after a
  \~300 ms settle**. Then the TUI submits + exchanges. Live-proven: with a deliberately-wrong
  code the separate Enter produced `OAuth error: Request failed with status code 400` — i.e.
  the exchange actually fired (a correct code mints `sk-ant-oat…`). Also: settle on the token
  OR a rejection line so a bad/expired code fails fast instead of hanging the full 60 s.
  (`completeCliLink` in `account-link-cli.ts`.)

So when **"Add account → One-click" stalls**: it is NOT the authorize URL and NOT claude.ai —
it is the pty submit. Diagnose by replicating `account-link-cli.ts` in a node-pty probe and
watching whether the fed code actually submits. The `claude setup-token` paste fallback (below)
always works regardless.

***

## The bottom line (this has burned ≥3 agents on `accounts-pool-tab-2026-06-15`)

Do **not** try to let the owner "click a link and OAuth in the browser" to add a Claude
Max account. It cannot work. claude.ai's authorize endpoint **requires the claude-code
client's own handshake**; a hand-built URL opened in a normal browser is rejected with:

> Authorization failed — Invalid request format

This was already recorded in `deploy-accounts-register.ts` ("claude.ai's authorize endpoint
rejects a hand-built OAuth URL (it needs claude-code's own client handshake), so the owner
runs `claude setup-token`"). Agents keep ignoring it and rebuilding the in-app OAuth link.
**Heed it.** The working path is below.

## Proof it's not a URL-format problem

We built the in-app link three ways (console params; then the GitHub-#29983 variant
claude.ai + user:\* scopes + no code=true; then byte-for-byte the CLI's URL). The owner
clicked a URL **identical** to what `claude setup-token` generates —

```
https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
  &response_type=code&redirect_uri=https://platform.claude.com/oauth/code/callback
  &scope=user:inference&code_challenge=<S256>&code_challenge_method=S256&state=<rand>
```

— and STILL got "Invalid request format". Same params, different outcome ⇒ the difference
is not the URL; it's that the CLI performs a client handshake (session/registration) that a
standalone browser click of a copied URL does not. (How to re-capture the CLI's current URL,
should you ever need to compare: `CLAUDE_CONFIG_DIR=/tmp/x claude setup-token` — but capturing
it does NOT make it clickable-standalone.)

## The working path — `claude setup-token` (what the UI defaults to)

1. On a machine signed in as the TARGET Max account, run `claude setup-token` (it opens the
   browser, does the handshake, you approve, it prints an `sk-ant-oat…` token).
2. Paste that token (or a `.credentials.json` bundle) into Settings → Deploy Accounts →
   "+ Link Max account" → **Paste a setup-token** (the default tab), or `accounts:register`
   / `POST /api/admin/deploy-accounts/register`. credentialRef becomes `token:<path>` /
   `file:<path>`; the raw token never reaches the browser.

The in-app "Via browser (OAuth)" tab is kept but defaulted-off and labelled experimental —
it will say "Invalid request format" against live claude.ai. Don't promote it without a new
mechanism that does the claude-code handshake (not just a prettier URL).

## Where it lives

`account-link-cli.ts` now drives the working one-click OAuth flow (pty `claude setup-token`); it
replaced the removed `account-link-store.ts`, which built the non-working-standalone hand-built URL.
`deploy-accounts-register.ts` is the working paste path. Both surface in Settings → Deploy Accounts +
the /adv Accounts tab. (accounts-pool-tab-2026-06-15 D-005/D-013/D-014/D-015/D-016/D-017.)
