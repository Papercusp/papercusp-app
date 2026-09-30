-- 009-resource-waiters.sql — named-resource waiter ledger
-- (handoff-coordination-dx-followups-2026-06-04 §A4).
--
-- Records agents who were REFUSED a resource acquire because another owner
-- holds/pends the exclusive (exclusive_pending / held_exclusive). On release
-- the "resource back up" broadcast targets just these waiters instead of
-- ['*'] — only they care that the resource is free again. A waiter row is
-- cleared when its owner successfully acquires, when the resource frees (all
-- waiters notified at once), or when it TTL-expires (an agent that gave up).
CREATE TABLE IF NOT EXISTS agent_resource_waiters (
  coordination_domain text        NOT NULL,
  resource            text        NOT NULL,
  owner               text        NOT NULL,
  owner_label         text,
  queued_ts           timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_ts          timestamptz NOT NULL,
  PRIMARY KEY (coordination_domain, resource, owner)
);

CREATE INDEX IF NOT EXISTS agent_resource_waiters_resource_idx
  ON agent_resource_waiters (coordination_domain, resource);
