import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

export default defineVitestConfig({
  layer: 'unit',
  include: [
    'src/**/*.test.ts',
    // EI-21113741017731833: the mobile templates' fixture suites are the
    // in-repo FALSIFIABILITY harness for their contracts, and nothing was
    // executing them — they skipIf(materialized) inside a materialized app,
    // and no vitest config owned them in the repo. They run HERE because
    // scripts/affected-tests.mjs already routes `templates/` to this
    // workspace, so a change to a template contract selects the suite that
    // guards it. (The non-fixture `composition-integrity.test.ts` siblings
    // are deliberately NOT included: those are the checks a MATERIALIZED app
    // runs against its own checks-config.json, which the repo does not have.)
    '../../../templates/*/checks/*.fixture.test.ts',
    // papercusp-app's composition-integrity is the ONE exception to the
    // parenthetical above, because that rationale does not hold for it: it
    // validates the TEMPLATE SET (the composition plan), not a built app, and
    // its own header states it runs UNCONFIGURED against the sibling template
    // dirs — TEMPLATE_CHECKS_CONFIG is optional for it and required for the
    // others. It was carrying 14 passing assertions that NOTHING executed,
    // including the mechanical proofs behind three of the template's `musts`
    // (thin-app-template, answer-target-first, agents-are-explicit — each
    // declaring enforcedBy: "composition-integrity") and the P-005 dual-target
    // cost pin. A MUST whose enforcing check never runs is prose wearing a
    // mechanism's name. (plan unified-app-template-2026-08-23, P-005.)
    '../../../templates/papercusp-app/checks/composition-integrity.test.ts',
  ],
});
