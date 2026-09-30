# Project History check

`project-history-artifact.test.ts` reads the configured generated JSON or
TypeScript artifact and pins schema version, project identity, harness, generator,
and basic plan structure. It skips when `TEMPLATE_CHECKS_CONFIG` has no
`projectHistory` section.
