-- Grant DELETE on audit tables so the prune script can run as harness_app.
-- Without this, scripts/prune-audit-tables.mjs fails with "permission
-- denied" and the tables grow unbounded.
GRANT DELETE ON harness_shared.agent_actions    TO harness_app;
GRANT DELETE ON harness_shared.agent_queries    TO harness_app;
GRANT DELETE ON harness_shared.voice_utterances TO harness_app;
-- el_conv_calls is intentionally not pruned; no DELETE grant.
