/**
 * Integration-layer setup for @papercusp/db — pin the connection layer DIRECT.
 *
 * These tests provision their OWN fresh testcontainer Postgres, but the
 * connection layer's `pgbouncerEnabled()` defaults TRUE on a 'server'-class
 * host (the shared dev box / checkpoint runner), which reroutes org-pool URLs
 * through the BOX-WIDE PgBouncer on :6432 — a pooler fronting the box's shared
 * NATIVE PG, not the test's private container. That mis-route is exactly the
 * WI-1666 class: 'password authentication failed' (the container role isn't in
 * the box userlist), silent wrong-database reads, and LISTEN/NOTIFY dropped by
 * transaction pooling (broke connection-concurrency / harness-schema /
 * workspace-context / coord-links-blocks-notify on the 2026-07-05 green gate —
 * first exposed when migrations 495–503 tripped the db/** full-integration run
 * after the PgBouncer cutover).
 *
 * `PAPERCUSP_PGBOUNCER=0` is the connection layer's explicit kill-switch:
 * every test in this package talks straight to the DSN it was given.
 */
process.env.PAPERCUSP_PGBOUNCER = '0';
