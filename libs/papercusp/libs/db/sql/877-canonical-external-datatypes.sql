-- 877-canonical-external-datatypes.sql — external-triggers P-002 / D-004
--
-- First-party curated vocabulary shared by provider trigger payloads, Personal
-- Vault documents, and Papercusp app blueprint dependencies. These are global-
-- catalog entries owned by the platform workspace; other workspaces install the
-- approved definitions through the existing datatypes:catalog/install rail.
--
-- FORWARD-COMPAT: this migration only upserts registry data; the currently
-- deployed release already reads this table and tolerates new datatype ids.

INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, created_by, updated_at)
VALUES
  (
    'email-message', 'papercusp-workspace', 'papercusp', 'Email message',
    'Canonical provider-neutral email message payload.', 'first-class', NULL,
    '{"type":"object","properties":{"id":{"type":"string","minLength":1},"threadId":{"type":"string"},"from":{"type":"string"},"to":{"type":"array","items":{"type":"string"}},"cc":{"type":"array","items":{"type":"string"}},"bcc":{"type":"array","items":{"type":"string"}},"subject":{"type":"string"},"text":{"type":"string"},"html":{"type":"string"},"snippet":{"type":"string"},"occurredAt":{"type":"string"},"labels":{"type":"array","items":{"type":"string"}}},"required":["id"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','email'],
    'external-triggers-gmail-slack-2026-08-22', now()
  ),
  (
    'calendar-event', 'papercusp-workspace', 'papercusp', 'Calendar event',
    'Canonical provider-neutral calendar event payload.', 'first-class', NULL,
    '{"type":"object","properties":{"id":{"type":"string","minLength":1},"summary":{"type":"string"},"description":{"type":"string"},"organizer":{"type":"string"},"attendees":{"type":"array","items":{"oneOf":[{"type":"string"},{"type":"object","properties":{"email":{"type":"string"},"displayName":{"type":"string"}},"additionalProperties":true}]}},"start":{"type":"string"},"end":{"type":"string"},"location":{"type":"string"},"status":{"type":"string"}},"required":["id"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','calendar'],
    'external-triggers-gmail-slack-2026-08-22', now()
  ),
  (
    'chat-message', 'papercusp-workspace', 'papercusp', 'Chat message',
    'Canonical provider-neutral channel, DM, or thread message payload.', 'first-class', NULL,
    '{"type":"object","properties":{"id":{"type":"string","minLength":1},"channelId":{"type":"string"},"threadId":{"type":"string"},"sender":{"type":"string"},"text":{"type":"string"},"occurredAt":{"type":"string"},"mentions":{"type":"array","items":{"type":"string"}},"attachments":{"type":"array","items":{"type":"object"}}},"required":["id","text"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','chat'],
    'external-triggers-gmail-slack-2026-08-22', now()
  ),
  (
    'social-post', 'papercusp-workspace', 'papercusp', 'Social post',
    'Canonical provider-neutral social-network post payload.', 'first-class', NULL,
    '{"type":"object","properties":{"id":{"type":"string","minLength":1},"author":{"type":"string"},"text":{"type":"string"},"url":{"type":"string"},"occurredAt":{"type":"string"},"media":{"type":"array","items":{"type":"object"}},"replyToId":{"type":"string"}},"required":["id","text"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','social'],
    'external-triggers-gmail-slack-2026-08-22', now()
  ),
  (
    'contact', 'papercusp-workspace', 'papercusp', 'Contact',
    'Canonical provider-neutral person/contact payload.', 'first-class', NULL,
    '{"type":"object","properties":{"id":{"type":"string","minLength":1},"displayName":{"type":"string"},"emails":{"type":"array","items":{"type":"string"}},"phones":{"type":"array","items":{"type":"string"}},"organizations":{"type":"array","items":{"type":"string"}},"source":{"type":"string"}},"required":["id"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','contact'],
    'external-triggers-gmail-slack-2026-08-22', now()
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
  updated_at = now();
