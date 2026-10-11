# Pull requests and releases

Every change starts on a branch and enters `main` through a pull request.
`CI gate` succeeds only when every test/build job and container integration job
succeeds. A failure, cancellation, or skipped prerequisite fails the gate.
Pull requests never publish images and receive no deployment credentials.

## One-time repository settings

The workflow files do not enable repository protection by themselves.
A repository administrator must import `.github/main-ruleset.json` under
**Settings > Rules > Rulesets > Import a ruleset**, after `CI gate` has run.
The rule requires an up-to-date PR and passing `CI gate`, resolves review
conversations, blocks force pushes and branch deletion, and has no bypass list.
It uses zero mandatory approvals for this solo-owned repository; require an
independent approval when a second maintainer is available. Do not claim a
review happened unless a real person reviewed the PR.

Create the `release` environment, restrict it to `main`, and add required
reviewers if an independent release approver is available. Merely naming an
environment in YAML does not configure approval rules.

## Ship a version

1. Open a PR with the change, tests, and any relevant version/changelog updates.
2. Wait for the latest `CI gate` and review the diff and actual test results.
3. Squash-merge or merge-commit the PR. The release validator requires the exact
   selected commit to be the merge commit of a merged PR into `main`.
4. Run **Actions > Release > Run workflow** on `main` with a new stable tag,
   such as `v0.2.0`. Existing tags, invalid versions, other branches, and commits
   without a merged PR fail validation.
5. Release runs the complete CI suite again for that exact commit, builds and
   smoke-tests the containers, and saves the images as a checksummed artifact.
   Only then can the publish job run. It loads those same images without a
   rebuild, publishes version and commit tags to GHCR, and creates a GitHub
   release containing the registry digests.

Workflow actions are pinned to full commit SHAs and Dependabot proposes their
updates. Tests use disposable databases and test-only credentials.

## Production deployment

This repository has no configured production hosting destination. Publishing
a GHCR image is a release artifact, **not a production deployment**. No cloud
credentials, deploy hook, or production URL is guessed by these workflows.
Once a host is chosen, deploy the recorded image digest behind a protected
`production` environment after the release checks. Disable any host-level
deploy-on-push setting that could bypass the checks. Add a post-deployment
health check and retain the previous image digest for rollback. Database
changes need a separate compatible migration/rollback plan.

## CI verification scope

Container integration uses `.github/compose.ci.yml`, never the developer's
normal Compose volumes. It checks the served frontend and API, with actual
PostgreSQL for the Java and SupportDesk applications. These checks are
targeted integration tests, not browser end-to-end or production load tests.
