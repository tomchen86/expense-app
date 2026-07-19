## Why

The real bootstrap pilot proved that GitHub's required rebase merge preserves an
authority commit's tree while replacing its human-signed commit identity with an
unsigned main commit. Before maintainer mode can be sealed, the repository needs
a fail-closed, base-owned way to prove that each protected-main authority
transition derives from a retained human-signed original without weakening the
rebase-only ruleset.

This change implements the durable authority-commit merge semantics prioritized
in `docs/ROADMAP.md` under **Finish repository workflow adoption**.

## What Changes

- Add a versioned, human-signed authority tree-attestation envelope retained by
  a protected `workflow-attestation/**` Git tag.
- Add a human-present `pnpm workflow maintainer attest` command that binds one
  original signed authority commit to its rebase-produced protected-main commit
  and emits an exact tag publication command.
- Add base-owned replay verification that requires matching result trees,
  matching parent trees, canonical authority identity/trailers, protected-main
  reachability, trusted original signatures, and a unique original-to-main
  mapping.
- Apply the same explicit tree-identity mapping to grant `baseCommit` references
  so the bootstrap pilot's original and rebased commit lineage remains
  verifiable.
- Fail closed on missing, conflicting, candidate-self-authorized, malformed, or
  unverifiable attestations. Bootstrap may expose migration status, but sealing
  cannot succeed until every historical authority transition is covered.
- Record a post-merge migration pilot for the existing bootstrap authority
  lineage before this change is archived.

Scope is limited to the repository workflow engine, its tests and schemas,
managed workflow documentation, roadmap wording, and the pilot evidence. This
change does not enable the `workflow-sealing` environment, change the protected
branch's rebase-only policy, rotate the signer, transition the maintainer policy
to `sealed`, or alter product/API behavior.

## Capabilities

### New Capabilities

- `authority-tree-attestation`: Defines the signed original-to-main
  tree-identity statement, protected audit retention, deterministic verification,
  uniqueness, and historical grant-base mapping requirements.

### Modified Capabilities

- `break-glass-maintainer-mode`: Extends authority history and grant replay to
  survive rebase-produced commit identity changes without accepting a different
  transition.
- `repository-governance`: Makes authority attestation replay base-owned and a
  prerequisite for declaring sealed enforcement while preserving strict
  rebase-only branch governance.

## Impact

- Workflow engine CLI, Git/signature utilities, authority CI replay, contracts,
  and integration tests under `packages/workflow-engine/`.
- Versioned schema and policy data needed to parse and verify attestation tags.
- `docs/WORKFLOW.md`, `docs/ROADMAP.md`, generated semantic handoff, and a new
  retained pilot-evidence document.
- Remote follow-up requires maintainer publication of protected attestation tags;
  environment binding, hardware-signer confirmation, and sealing remain separate
  governed work.
