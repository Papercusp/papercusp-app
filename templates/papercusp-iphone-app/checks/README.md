# papercusp-iphone-app — check contract

## `composition-integrity`

`composition-integrity.test.ts` reads the root plus its two pinned dependency
manifests and verifies:

- the exact IDs, scopes, categories, versions, and hard requirements;
- catalog and template-set validity with one app-scope root;
- a successful `composeTemplates` result whose check union retains every root,
  shared-base, and iPhone-shell check; and
- for a configured materialized app, one non-empty tagged answer for every
  decision point in the exact dependency closure, with no unknown answer keys.

Without `TEMPLATE_CHECKS_CONFIG`, the repo entrypoint reads the three sibling
canonical manifests and skips only the materialized answer-record leg. The
fixture suite still validates the committed neutral answer record and proves
missing/unknown answers fail.

With `TEMPLATE_CHECKS_CONFIG`, provide:

```json
{
  "app": { "name": "your-app", "root": "." },
  "composition": {
    "templateYamls": [
      "template.yaml",
      "template-manifests/papercusp-mobile-base.yaml",
      "template-manifests/papercusp-iphone-shell.yaml"
    ],
    "decisionPointAnswers": {
      "papercusp-iphone-app:iphone-app-purpose": "..."
    }
  }
}
```

The actual map must contain all twelve keys listed in `GUIDE.md`.
