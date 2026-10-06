-- 1377-ticket-workflow-tracker-fields.sql — linear-asana-task-sync-2026-10-05 P-001 (WI-10006361)
--
-- Extends the canonical ticket datatypes of 1332 ADDITIVELY so workflow
-- trackers (Linear, Asana) map onto them without losing their workflow shape.
-- Every new property is optional; every payload valid under 1332 stays valid.
--
--   ticket                gains statusCategory (the provider-neutral workflow
--                         column: triage|backlog|todo|in-progress|in-review|
--                         done|canceled), statusName (the provider's own label),
--                         identifier (e.g. ENG-123), priority {level,name},
--                         dueAt, parentExternalId, projects[], section,
--                         estimate and delegates[] (Linear's agent delegation;
--                         an Asana assignment to the Papercusp user maps here).
--                         `state` open|closed stays and is DERIVED from the
--                         category: done/canceled => closed, else open
--                         (packages/operator-core/lib/data-sources/ticket-vocabulary.ts).
--   ticket-status-change  gains the `moved` transition (a workflow column
--                         change that is not an open/close) with fromCategory
--                         and toCategory (+ fromStatusName/toStatusName).
--                         A `moved` row must carry toCategory.
--
-- Each property patch below is a JSON object merged into the existing
-- payload_schema->'properties' with `||`, so the merge never drops a property
-- another writer added. The two patch literals are also read by
-- packages/operator-core/lib/data-sources/ticket-vocabulary.test.ts (between the
-- PATCH markers), which validates real Linear/Asana/GitHub-shaped payloads
-- against 1332's schema plus these patches.
--
-- Registry rows exist only in papercusp-workspace (1332), so the UPDATEs are
-- scoped there; a workspace without the rows is untouched.
--
-- FORWARD-COMPAT: data-only and additive. The deployed release reads
-- payload_schema at validation time and accepts every payload it accepted
-- before; it never emits `moved`, so the widened transition enum is unused
-- until the Linear/Asana providers ship.

UPDATE harness_shared.datatype_registry
SET payload_schema = jsonb_set(
      payload_schema,
      '{properties}',
      COALESCE(payload_schema->'properties', '{}'::jsonb) ||
      -- TICKET-PATCH-BEGIN
      '{"statusCategory":{"type":"string","enum":["triage","backlog","todo","in-progress","in-review","done","canceled"]},"statusName":{"type":"string"},"identifier":{"type":"string"},"priority":{"type":"object","properties":{"level":{"type":"integer","minimum":0,"maximum":4},"name":{"type":"string"}},"additionalProperties":true},"dueAt":{"type":"string"},"parentExternalId":{"type":"string"},"projects":{"type":"array","items":{"type":"string"}},"section":{"type":"string"},"estimate":{"type":"number"},"delegates":{"type":"array","items":{"type":"string"}}}'::jsonb
      -- TICKET-PATCH-END
    ),
    description = 'Canonical provider-neutral ticket (issue, task, story) from GitHub Issues, Asana, Jira or Linear, with an optional workflow statusCategory from which open/closed state is derived. A record, never agent work.',
    updated_at = now()
WHERE workspace_id = 'papercusp-workspace'
  AND id = 'ticket';

UPDATE harness_shared.datatype_registry
SET payload_schema = jsonb_set(
      jsonb_set(
        payload_schema,
        '{properties}',
        COALESCE(payload_schema->'properties', '{}'::jsonb) ||
        -- STATUS-CHANGE-PATCH-BEGIN
        '{"transition":{"type":"string","enum":["opened","closed","reopened","moved"]},"fromCategory":{"type":"string","enum":["triage","backlog","todo","in-progress","in-review","done","canceled"]},"toCategory":{"type":"string","enum":["triage","backlog","todo","in-progress","in-review","done","canceled"]},"fromStatusName":{"type":"string"},"toStatusName":{"type":"string"}}'::jsonb
        -- STATUS-CHANGE-PATCH-END
      ),
      '{allOf}',
      -- STATUS-CHANGE-ALLOF-BEGIN
      '[{"if":{"properties":{"transition":{"const":"moved"}},"required":["transition"]},"then":{"required":["toCategory"]}}]'::jsonb
      -- STATUS-CHANGE-ALLOF-END
    ),
    description = 'Canonical provider-neutral ticket transition: opened, closed, reopened, or moved between workflow categories. An event, never agent work.',
    updated_at = now()
WHERE workspace_id = 'papercusp-workspace'
  AND id = 'ticket-status-change';
