## 1. Grant Contract and Issuance

- [x] 1.1 Add the trusted maintainer policy, canonical grant model, exact-path validation, and maintainer-mode coverage under the existing workflow-test authority.
- [x] 1.2 Add the human-present SSH signer, interactive grant command, and signed audit-tag creation.

## 2. Local Grant and Session State

- [x] 2.1 Add Git-common-directory grant storage, atomic reservation, inspection, idempotent revocation, and cross-worktree exclusion.
- [ ] 2.2 Add authority session start/check transitions, pinned normal-check evidence, and terminal failure cleanup.

## 3. Commit and Recovery

- [ ] 3.1 Add signed authority commit isolation, canonical trailers, durable transaction journaling, and fail-closed crash recovery.

## 4. Independent Assurance

- [ ] 4.1 Add parent-policy authority replay, audit-tag and commit-signature verification, unique-use enforcement, and sealed trust-root rules.
- [ ] 4.2 Run workflow assurance from the pull-request base and cover candidate-verifier, phase, rotation, expiry, and replay attacks.

## 5. Operator Contract

- [ ] 5.1 Document every maintainer command, bootstrap/pilot/sealing procedure, recovery boundary, and maintainer-owned remote prerequisite.
