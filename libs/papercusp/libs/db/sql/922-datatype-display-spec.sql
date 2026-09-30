-- 922-datatype-display-spec.sql — work-on-everything goal P-024 / D-005
--
-- Datatypes describe their editor and compact rendering declaratively. The
-- operator owns the fixed widget vocabulary and validates this JSON at the
-- meta:define-datatype boundary; registry rows never carry executable renderers.
--
-- EXPAND-only and forward compatible: the deployed release selects explicit
-- columns and ignores this nullable addition until the matching code ships.

ALTER TABLE harness_shared.datatype_registry
  ADD COLUMN IF NOT EXISTS display JSONB;

COMMENT ON COLUMN harness_shared.datatype_registry.display IS
  'Declarative {widget,params?,summary} display contract; validated by datatypeDisplaySchema; never executable code.';
