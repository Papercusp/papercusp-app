-- 1383-relationship-graph-datatypes.sql — crm-agent-sales-onboarding-apps-2026-10-06
-- P-002 (WI-10006430), decisions D-001 and D-011.
--
-- The platform relationship graph: one record per real person and organization
-- across every app, fed by connector sources. Per D-011 there is NO new table.
-- Instances are work_items rows written by the datatype destination sink
-- (packages/operator-core/lib/data-sources/datatype-destination-sink.ts):
--
--   person        record    one per (source, native id) as a DSR- row; the
--                           identity resolver (lib/relationship-graph) merges
--                           the rows of one human by email and phone into a
--                           canonical PER- row with per-field provenance.
--   organization  record    the same, merged by domain into a canonical ORG- row.
--   commitment    record    a promise made in an interaction. Never agent work;
--                           it becomes work only through work_items:admit and
--                           admission rules (enterprise-data-sources D-004/D-030).
--   call          document  a phone call (Phone app). An interaction, like
--                           email-message and calendar-event; it lands in the
--                           documents corpus and links to a person by
--                           personExternalId, never in an interactions table.
--
-- person, organization and commitment are generic-kind rows WITH a
-- work_item_kind, for the reason 1332 gives for `ticket`: createWorkItem mints a
-- non-built-in kind only when an active generic-kind registry row exists, and
-- nature_stamp_from_registry_trg (1322) copies nature from the row whose
-- work_item_kind matches. Without it every ingested person would be stamped
-- work/agent and become claimable. call has no work_item_kind: documents are
-- not work_items rows.
--
-- The existing `contact` datatype (877, first-class) is left as is. It has no
-- work_item_kind, so the record sink refuses it; `person` is its graph
-- counterpart and keeps contact's field names (displayName, emails, phones).
--
-- Rows are registered in papercusp-workspace only, like 877 and 1332; another
-- workspace has no generic-kind row, so createWorkItem refuses the kind there
-- (fails closed) instead of minting work/agent rows.
--
-- FORWARD-COMPAT: this migration only upserts registry data; the currently
-- deployed release already reads this table and tolerates new datatype ids.

INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, created_by, nature, audience, updated_at)
VALUES
  (
    'person', 'papercusp-workspace', '*', 'Person',
    'One human in the platform relationship graph. Per-source rows are merged by email and phone into one canonical person with per-field provenance. A record, never agent work.',
    'generic-kind', 'person',
    '{"type":"object","properties":{"provider":{"type":"string"},"externalId":{"type":"string","minLength":1},"displayName":{"type":"string"},"givenName":{"type":"string"},"familyName":{"type":"string"},"emails":{"type":"array","items":{"type":"string"}},"phones":{"type":"array","items":{"type":"string"}},"title":{"type":"string"},"organizationName":{"type":"string"},"organizationExternalId":{"type":"string"},"organizationDomain":{"type":"string"},"location":{"type":"string"},"url":{"type":"string"},"observedAt":{"type":"string"},"updatedAt":{"type":"string"}},"required":["externalId"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','relationship-graph'],
    'crm-agent-sales-onboarding-apps-2026-10-06', 'record', NULL, now()
  ),
  (
    'organization', 'papercusp-workspace', '*', 'Organization',
    'One company or organization in the platform relationship graph. Per-source rows are merged by domain into one canonical organization with per-field provenance. A record, never agent work.',
    'generic-kind', 'organization',
    '{"type":"object","properties":{"provider":{"type":"string"},"externalId":{"type":"string","minLength":1},"name":{"type":"string"},"domains":{"type":"array","items":{"type":"string"}},"website":{"type":"string"},"phones":{"type":"array","items":{"type":"string"}},"industry":{"type":"string"},"size":{"type":"string"},"location":{"type":"string"},"observedAt":{"type":"string"},"updatedAt":{"type":"string"}},"required":["externalId"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','relationship-graph'],
    'crm-agent-sales-onboarding-apps-2026-10-06', 'record', NULL, now()
  ),
  (
    'commitment', 'papercusp-workspace', '*', 'Commitment',
    'A promise made in an interaction (by an agent or a person), with its due date and status. A record: it becomes work only through an admission.',
    'generic-kind', 'commitment',
    '{"type":"object","properties":{"provider":{"type":"string"},"externalId":{"type":"string","minLength":1},"text":{"type":"string","minLength":1},"promisedBy":{"type":"string"},"promisedTo":{"type":"string"},"personExternalId":{"type":"string"},"dueAt":{"type":"string"},"status":{"type":"string","enum":["open","kept","broken","cancelled"]},"interactionDatatype":{"type":"string"},"interactionExternalId":{"type":"string"},"observedAt":{"type":"string"}},"required":["externalId","text","status"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','relationship-graph'],
    'crm-agent-sales-onboarding-apps-2026-10-06', 'record', NULL, now()
  ),
  (
    'call', 'papercusp-workspace', 'papercusp', 'Phone call',
    'Canonical provider-neutral phone call with its participants and transcript. An interaction document in the documents corpus.',
    'first-class', NULL,
    '{"type":"object","properties":{"provider":{"type":"string"},"externalId":{"type":"string","minLength":1},"direction":{"type":"string","enum":["inbound","outbound"]},"from":{"type":"string"},"to":{"type":"array","items":{"type":"string"}},"participants":{"type":"array","items":{"type":"string"}},"personExternalId":{"type":"string"},"title":{"type":"string"},"text":{"type":"string"},"summary":{"type":"string"},"startedAt":{"type":"string"},"endedAt":{"type":"string"},"durationSeconds":{"type":"number"},"recordingUrl":{"type":"string"},"occurredAt":{"type":"string"}},"required":["externalId"],"additionalProperties":true}'::jsonb,
    'papercusp', '{"improvements":["invalid-payload"],"scorecard":["validation-success-rate"],"gym":{"signals":["schema-rejection"],"rubric":"canonical-shape-fidelity"}}'::jsonb,
    'active', TRUE, 'approved', ARRAY['external-data','canonical','first-party','relationship-graph'],
    'crm-agent-sales-onboarding-apps-2026-10-06', 'document', NULL, now()
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
