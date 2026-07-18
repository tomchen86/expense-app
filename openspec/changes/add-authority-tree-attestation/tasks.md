## 1. Managed Baseline

- [x] 1.1 Refresh the generated semantic handoff for this active change and prove the managed-document baseline is clean before implementation begins.

## 2. Attestation Engine

- [x] 2.1 Follow RED → GREEN → REFACTOR to define the canonical authority-attestation envelope, exact mapping parser, schema contract, and transition-identity validation primitives.
- [x] 2.2 Follow RED → GREEN → REFACTOR to add the human-present `maintainer attest` command, distinct signature namespace, protected annotated-tag creation, and concise publication handoff.
- [x] 2.3 Follow RED → GREEN → REFACTOR to add base-owned first-parent replay, trusted original-signature verification, unique authority mapping, historical grant-base mapping, and fail-closed CI integration.

## 3. Operator Contract

- [x] 3.1 Document the attestation command, trust boundaries, migration gate, recovery behavior, and remaining environment/signer/sealing work; update contract tests and roadmap wording without claiming sealed enforcement.

## 4. Post-Merge Migration Pilot

- [ ] 4.1 After the implementation PR merges, protect `workflow-attestation/**`, create and publish the human-signed pilot attestation for the three observed original/main mappings, run base-owned replay, and record exact local and remote tag evidence.
- [ ] 4.2 After the first migration-evidence PR passes and merges, record its required-check results, merged identity, ruleset read-back, and bootstrap-only remainder before archival.
