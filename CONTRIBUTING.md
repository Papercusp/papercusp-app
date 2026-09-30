# Contributing to Papercusp

Thanks for your interest. Papercusp is source-available under the
[Elastic License 2.0](LICENSE). Issues and pull requests are welcome.

## How this repository works

This repository is a **published export** of Papercusp's development tree. We work in
a private monorepo and publish public-safe snapshots here as new commits on top of
`main`. History is append-only and never force-pushed, so your fork and your pull
requests stay valid.

When we accept a pull request, we apply the change in the development tree. It then
arrives here in a later export, with you credited through a `Co-authored-by:` line on
that commit (the name and email from your pull request's commits), and the pull
request is closed with a link to it. The pull request itself is not merged directly.

Issues are tracked here, on this repository. We mirror actionable ones into our
internal tracker and close them here, with a link to the commit, when the fix ships.

## Contributor License Agreement

Before we can accept a code contribution, you need to sign our Contributor License
Agreement (CLA). A bot comments on your first pull request with a link. You sign once,
and it covers all your future contributions.

The CLA lets us keep distributing your contribution, including under licence terms
other than the Elastic License 2.0 in the future. You keep the copyright to your work.
Documentation typo fixes do not need a CLA.

## Before you open a pull request

1. For anything larger than a small fix, open an issue first so we can agree on the approach.
2. Keep each pull request focused on one change.
3. Include tests for your change in the project's test framework (Vitest for TypeScript,
   `cargo test` for Rust). This repository does not yet carry our existing test suite; we
   run the full suite on your change when we apply it, and tell you on the pull request if
   anything fails.
4. Run `npm ci` and `npm run lint:tsc` (the typecheck) before opening the pull request. CI
   runs the same two steps on every pull request.
5. Do not add dependencies whose licence is incompatible with the Elastic License 2.0.
   That rules out GPL, AGPL, SSPL and non-commercial licences.

## Reporting security issues

Please do not open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
