-- 1332-ticket-datatypes.sql — enterprise-data-sources-2026-10-01 P-019 (WI-10005056)
--
-- One canonical ticket vocabulary shared by every ticket system (GitHub Issues
-- first per D-025, then Asana, Jira, Linear). A connector maps its provider
-- objects onto these three datatypes, each with exactly one nature (D-001):
--
--   ticket                record    the issue/task itself. Stays in work_items
--                                   tagged nature='record' (D-011), so it is
--                                   never agent work and never claimable.
--   ticket-comment        document  a comment on a ticket. Lands in the one
--                                   documents corpus (D-005), not work_items.
--   ticket-status-change  event     an open/close/reopen transition. Stays in
--                                   work_items tagged nature='event' (D-011).
--
-- ticket and ticket-status-change are generic-kind rows WITH a work_item_kind,
-- because createWorkItem only mints a non-built-in kind that has an active
-- generic-kind registry row, and nature_stamp_from_registry_trg (1322) copies
-- nature from the row whose work_item_kind matches. Without work_item_kind the
-- stamp falls back to work/agent and every ingested ticket would be claimable
-- agent work. ticket-comment has no work_item_kind: documents are not
-- work_items rows.
--
-- Rows are registered in papercusp-workspace only, like the canonical external
-- datatypes of 877. Another workspace has no generic-kind row, so
-- createWorkItem refuses the kind there (fails closed) instead of minting
-- work/agent rows.
--
-- FORWARD-COMPAT: this migration only upserts registry data; the currently
-- deployed release already reads this table and tolerates new datatype ids.

INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, created_by, nature, audience, updated_at)
VALUES
  (
    'ticket', 'papercusp-workspace', '*', 'Ticket',
    'Canonical provider-neutral ticket (issue, task, story) from GitHub Issues, Asana, Jira or Linear. A record, never agent work.',
    'generic-kind', 'ticket',
    '{"type":"object","properties":{"provider":{"type":"string","minLength":1},"externalId":{"type":"string","minLength":1},"container":{"type":"string"},"number":{"type":"integer"},"title":{"type":"string"},"body":{"type":"string"},"state":{"type":"string","enum":["open","closed"]},"stateReason":{"type":"string"},"author":{"type":"string"},"assignees":{"type":"array","items":{"type":"string"}},"labels":{"type":"array","items":{"type":"string"}},"url":{"type":"string"},"createdAt":{"type":"string"},"updatedAt":{"type":"string"},"closedAt":{"type":"string"}},"required":["provider","externalId","title","state"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','ticket'],
    'enterprise-data-sources-2026-10-01', 'record', NULL, now()
  ),
  (
    'ticket-comment', 'papercusp-workspace', 'papercusp', 'Ticket comment',
    'Canonical provider-neutral comment on a ticket. A document in the documents corpus.',
    'first-class', NULL,
    '{"type":"object","properties":{"provider":{"type":"string","minLength":1},"externalId":{"type":"string","minLength":1},"ticketExternalId":{"type":"string","minLength":1},"author":{"type":"string"},"text":{"type":"string"},"url":{"type":"string"},"occurredAt":{"type":"string"}},"required":["provider","externalId","ticketExternalId","text"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','ticket'],
    'enterprise-data-sources-2026-10-01', 'document', NULL, now()
  ),
  (
    'ticket-status-change', 'papercusp-workspace', '*', 'Ticket status change',
    'Canonical provider-neutral ticket state transition (opened, closed, reopened). An event, never agent work.',
    'generic-kind', 'ticket-status-change',
    '{"type":"object","properties":{"provider":{"type":"string","minLength":1},"externalId":{"type":"string","minLength":1},"ticketExternalId":{"type":"string","minLength":1},"ticketWorkItemId":{"type":"string"},"transition":{"type":"string","enum":["opened","closed","reopened"]},"stateReason":{"type":"string"},"actor":{"type":"string"},"occurredAt":{"type":"string"}},"required":["provider","externalId","ticketExternalId","transition"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','ticket'],
    'enterprise-data-sources-2026-10-01', 'event', NULL, now()
  )
ON CONFLICT (workspace_id, id) DO UPDATE SET
  pot_slug = EXCLUDED.pot_slug,
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  tier = EXCLUDED.tier,
  work_item_kind = EXCLUDED.work_item_kind,
  payload_schema = EXCLUDED.payload_schema,
  authoritative_writer = EXCLUDED.authoritative_writer,
  self_improvement = EXCLUDED.self_improvement,
  status = EXCLUDED.status,
  published = EXCLUDED.published,
  review_status = EXCLUDED.review_status,
  tags = EXCLUDED.tags,
  nature = EXCLUDED.nature,
  audience = EXCLUDED.audience,
  updated_at = now();
