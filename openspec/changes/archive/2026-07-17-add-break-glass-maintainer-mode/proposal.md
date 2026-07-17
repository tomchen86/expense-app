## Why

The repository workflow currently fails closed when established authority files
must change, but it has no governed recovery path other than repository-admin
intervention. The roadmap's "Finish repository workflow adoption" work needs a
human-only, auditable break-glass transition before the workflow can be piloted
and sealed without introducing an AI-accessible bypass.

## What Changes

- Add a closed-by-default maintainer grant model bound to the repository,
  exact base commit, OpenSpec change, exact eligible paths, expiry, use count,
  reason, signer, and canonical signature.
- Add interactive SSH-backed grant issuance plus inspect and revoke operations;
  keep grants, reservations, and recovery journals in the Git common directory.
- Add isolated `authority-start`, `authority-check`, and `authority-commit`
  transitions that preserve every ordinary safety check and emit one signed
  `authority-maintenance` commit.
- Extend managed-trailer and CI replay contracts so authority commits are
  independently validated against trust material loaded from the merge-base,
  never from candidate policy.
- Add bootstrap and sealed phases, including immutable trust-root paths and
  old-key-authorized key rotation.
- Document operator use, recovery, CI audit-envelope handling, and the explicit
  one-way sealing transition.
- Exclude product behavior, database operations, ordinary task bypasses,
  unattended grant issuance, broad path globs, and any environment-variable or
  repository-controlled force switch.

## Capabilities

### New Capabilities

- `break-glass-maintainer-mode`: Human-interactive grant issuance, authority
  session isolation, signed commit creation, independent CI verification,
  revocation, replay resistance, recovery, and trust-root sealing.

### Modified Capabilities

- `repository-governance`: Add the fourth managed commit kind and require
  trusted-base validation for break-glass changes without weakening normal
  checks or branch assurance.

## Impact

The change affects the TypeScript workflow engine and its integration tests,
workflow schemas and trust policy, GitHub workflow-assurance execution,
managed trailer parsing, repository documentation, and agent command routing.
It adds no product API, mobile, web, database, or runtime dependency behavior.
