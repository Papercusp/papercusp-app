# Build a throwaway isolated operator+DB stack for mutation E2E
URL: /internal/docs/agent-insights/isolated-stack-for-mutation-e2e

When a desktop E2E must CREATE state but you can't touch the live fleet, stand up a disposable operator (:3370) on a fresh cloned-schema PG DB and point a dedicated Tauri webview at it. The exact recipe + the two traps (extensions-before-restore, pg_dump-can't-lock-plugin-schemas).

## What

Driving the desktop UI for **mutation** tests (create a pot / plan / work-item,
run a worker chat, fault-inject) against the live `:3270` session operator is
risky (hits the owner's live fleet) and often blocked — MCP writes route to a
*different* operator/store than the webview reads (\[\[../testing/agent-e2e]];
see also EI-1511), so "API-create + UI-verify" doesn't close the loop, and the
fault-injection rig would inject 500s into the owner's live window.

The fix: a **disposable isolated stack** — its own operator on a spare port, its
own fresh Postgres DB, and a dedicated Tauri webview pinned to it. Create/destroy
freely; tear it all down at the end. This is the standing answer to "I need to
exercise a write path as a user without touching anything real."

## Recipe (verified 2026-06-18, round-5 E2E)

All paths relative to `papercupai-workspace/papercusp`. Namespace everything
(`e2e-r5-*`) so teardown is unambiguous.

**1. Fresh DB with a cloned schema.** The operator does NOT auto-migrate a blank
DB on boot (`42P01 relation does not exist` at `readOperatorState`). Clone the
schema from the shared DB instead of replaying 200+ migrations:

```sh
ADMIN=$(grep ^DATABASE_URL= apps/operator/.env.local | cut -d= -f2- | sed -E 's#/[^/?]+(\?|$)#/postgres\1#')
ISO=$(grep  ^DATABASE_URL= apps/operator/.env.local | cut -d= -f2- | sed -E 's#/[^/?]+(\?|$)#/papercup_e2e_r5\1#')
psql "$ADMIN" -c 'CREATE DATABASE papercup_e2e_r5'
# ⚠ TRAP 1: create extensions BEFORE restoring — pgvector needs SUPERUSER.
#   harness_admin is NOT superuser, so `sudo -u postgres` is required, and the
#   `public.vector` type must exist before the schema restore references it
#   (else ~290 dependent objects, incl. harness_brainstorm, silently drop).
sudo -u postgres psql papercup_e2e_r5 -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
# ⚠ TRAP 2: a whole-DB pg_dump FAILS — harness_admin can't LOCK plugin-owned
#   schemas (plugin_jira_sync, zero_*). Dump only the core schemas:
SRC=$(grep ^DATABASE_URL= apps/operator/.env.local | cut -d= -f2-)
pg_dump --schema-only --no-owner --no-privileges \
  -n harness_shared -n public -n papercup_shared -n papercusp_auth -n audit -n dbos \
  "$SRC" > /tmp/e2e-schema.sql
psql "$ISO" -v ON_ERROR_STOP=0 -q -f /tmp/e2e-schema.sql   # extensions-first ⇒ 0 real errors
```

**2. Disposable operator** on a spare port, background machinery OFF, fault rig ON:

```sh
cd apps/operator
setsid bash -c '
  set -a; . ./.env.local; set +a
  exec env PAPERCUSP_HONO_PORT=3370 PAPERCUSP_PTY_WS_PORT=3374 \
    PAPERCUSP_BACKGROUND_WORKERS=0 PAPERCUSP_DBOS_ENABLE=0 PAPERCUSP_DBOS_ROUTINES=0 \
    PAPERCUSP_DBOS_AUTOLOOP=0 PAPERCUSP_DBOS_TIMERS=0 PAPERCUSP_DBOS_PLAN_RENDER=0 \
    PAPERCUSP_FAULT_INJECTION=1 \
    DATABASE_URL="'"$ISO"'" HARNESS_DATABASE_URL="'"$ISO"'" HARNESS_ADMIN_DATABASE_URL="'"$ISO"'" \
    PAPERCUSP_WORKSPACE_ID=default DBOS__VMID=e2e-iso \
    npx tsx bin/hono-host.ts' > /tmp/e2e-iso-operator.log 2>&1 < /dev/null &
# healthy in ~25-35s: curl :3370/healthz → 200; grep the log for 0 `42P01`.
```

**3. Dedicated Tauri webview** pinned to it (the \[\[../testing/agent-e2e]] §15.4
Xvfb+VirtualGL recipe + the `PAPERCUSP_DEV_API_TARGET` escape hatch, which pins
content+`/api` and is never persisted to the shared profile):

```sh
cd papercusp-desktop
env -u WAYLAND_DISPLAY GDK_BACKEND=x11 DISPLAY=:95 PAPERCUSP_DEV_API_TARGET=3370 \
  vglrun -d egl0 npm run tauri -- dev --config '{"build":{"devUrl":"http://127.0.0.1:3370","beforeDevCommand":""}}' &
```

A fresh DB lands the webview on **`/setup`** — drive the onboarding wizard
("Start setup" → most steps auto-✓ from the inherited `.env.local` → "Finish
setup"), then hard-nav to `/adv` (the done-flag sticks). Bonus: this is the only
way to E2E the onboarding flow at all.

## What works / what doesn't on this stack

* **Works end-to-end:** onboarding wizard; pot create (UI "Add a Pot → New
  local directory" → DB `pots` row + git-init'd folder + "✓ Pot created");
  API-fault error-state (`POST /api/admin/fault-injection {pathPrefix,method,status,times}`
  → UI degrades without crashing → `DELETE` to clear). Verify every mutation by
  querying the iso DB directly (`SELECT count(*) FROM harness_shared.pots`).
* **Still blocked even here:** a real **worker-chat dispatch** (needs a
  pipeline-generated work-item + the agent-spawn machinery this minimal operator
  runs with OFF); **plan create** (the "New plan" button doesn't activate via
  synthetic click — EI-1531); form **saves** that autosave/`onChange` rather than
  a clickable Save (the React-controlled-input wall, agent-e2e §15.5).
* **Driving:** set React-19 controlled `<input>` values with the native-setter +
  `input`/`change` events (the `__reactProps$.onChange({target:{value}})` path
  did NOT stick for the pot form). Synthetic Radix pointer sequences activate
  *most* buttons (pot Create) but not all (New plan).

## Teardown (leave nothing)

```sh
fuser -k 3370/tcp                                  # operator
kill -TERM -- -<tauri-pgid>; kill <Xvfb :95 pid>   # webview + display
psql "$ADMIN" -c 'DROP DATABASE IF EXISTS papercup_e2e_r5 WITH (FORCE)'
rm -rf /tmp/e2e-*                                   # logs, schema dump, pot folders
```

Target temp infra by **recorded PID / process-group**, never `pkill -f <pattern>`
whose own command text self-matches (EI-606). The owner's live `:3270` window
shares the webview profile — never `localStorage.clear()`.
