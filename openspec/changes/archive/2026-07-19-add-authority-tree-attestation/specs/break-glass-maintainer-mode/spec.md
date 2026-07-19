## MODIFIED Requirements

### Requirement: Protected audit envelope
Grant issuance SHALL create an immutable namespaced Git audit tag containing
the signed non-secret envelope, and authority CI SHALL require that exact tag
and verify it against parent/base trust material. When rebase merge changes a
grant's referenced base identity, later replay MUST accept a protected-main
equivalent only through an explicit valid authority tree attestation.

#### Scenario: Missing or different audit tag is rejected
- **WHEN** CI cannot resolve the exact grant tag or its envelope differs from the locally claimed grant
- **THEN** the authority commit fails verification

#### Scenario: Candidate key cannot validate its own envelope
- **WHEN** a candidate branch adds or changes a signer while claiming an authority grant
- **THEN** CI verifies the envelope only with signers trusted by the authority commit parent

#### Scenario: Rebased grant base is replayed
- **WHEN** a historical grant tag references an original base commit that is not on protected-main history
- **THEN** replay requires an explicit attested protected-main base with equal result and parent trees, an identical canonical managed message, and the exact grant ID binding

### Requirement: Exact authority commit isolation
`authority-commit` MUST create one signed commit with exactly the granted
authority diff and canonical mutually exclusive `Change`,
`Transition: authority-maintenance`, and `Grant` trailers. If required rebase
merge changes that commit identity, the protected-main commit SHALL derive
authority only from a valid unique tree attestation to the retained signed
original.

#### Scenario: Exact authority commit succeeds
- **WHEN** at least one granted file changed, no ungranted path changed, current evidence passes, HEAD remains the grant base, and the trusted signer signs the commit
- **THEN** the engine atomically advances the branch to one authority-maintenance commit and consumes the grant

#### Scenario: Mixed work is rejected
- **WHEN** the diff contains product code, ordinary documentation, task completion, generated files, or any path absent from the exact grant
- **THEN** the engine rejects the commit and terminally closes that grant use

#### Scenario: Managed trailer forms are mixed
- **WHEN** an authority commit also contains `Task`, `plan`, `archive`, another transition, or a non-canonical reserved trailer
- **THEN** local hooks and CI reject the commit

#### Scenario: Signed original is rebased onto protected main
- **WHEN** GitHub creates a different main commit from a signed authority original
- **THEN** later replay accepts the main commit only when the original signature, exact grant, result tree, parent tree, complete canonical message, protected-main reachability, and unique protected attestation all verify

### Requirement: Bootstrap and sealed trust phases
The trusted maintainer policy SHALL begin in bootstrap and SHALL permit only a
one-way, old-key-authorized transition to sealed mode with immutable verifier
and trust-root paths. The sealed transition MUST preserve a signer lineage that
validates every retained authority original and attestation and MUST NOT proceed
until base-owned historical replay is complete.

#### Scenario: Bootstrap grant targets eligible authority
- **WHEN** a valid bootstrap grant lists exact files under reviewed eligible authority paths and none under immutable paths
- **THEN** the authority session may modify only those exact files while preserving all checks

#### Scenario: Sealed grant targets immutable trust root
- **WHEN** a grant in sealed phase includes the verifier, trusted-key loader, policy loader, or immutable-path enforcement
- **THEN** issuance, local execution, and CI all reject it using parent/base policy

#### Scenario: Phase rollback is attempted
- **WHEN** a candidate changes policy phase from sealed to bootstrap
- **THEN** CI rejects the change regardless of grant or signer

#### Scenario: Trusted key rotates
- **WHEN** an existing trusted key authorizes an otherwise valid policy change that introduces a replacement key without weakening immutable paths or historical attestation verification
- **THEN** the replacement becomes trusted only after the authority commit merges

#### Scenario: Historical authority is not attested
- **WHEN** a candidate changes policy phase to sealed while any protected-main authority commit or grant-base identity lacks valid base-owned attestation replay
- **THEN** CI rejects the sealing transition

