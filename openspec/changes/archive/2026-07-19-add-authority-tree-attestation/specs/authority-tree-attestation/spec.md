## ADDED Requirements

### Requirement: Canonical human-present authority attestation

The workflow engine SHALL create a versioned canonical authority attestation
only from a controlling interactive terminal through a trusted human-present
SSH signer. The signed payload MUST bind the repository, protected branch,
original and protected-main authority commits, grant-base mappings, trust
material, issuance time, and signer identity.

#### Scenario: Human creates a valid attestation

- **WHEN** a clean fetched repository contains one valid signed original authority commit, its rebase-produced protected-main equivalent, every explicitly mapped grant base, and the required protected grant tags
- **THEN** `pnpm workflow maintainer attest` validates the complete mapping before requesting a human signature
- **AND** it creates one canonical local attestation tag and returns its exact publication command

#### Scenario: Non-interactive or unattended creation is attempted

- **WHEN** attestation creation lacks a controlling input or output TTY, uses an unattended signer path, or cannot verify human presence
- **THEN** the engine creates no envelope or tag

#### Scenario: Encoding is ambiguous

- **WHEN** an envelope has extra or missing fields, partial object IDs, unsorted or duplicate mappings, an invalid timestamp, a wrong signature namespace, a noncanonical serialization, or an oversized value
- **THEN** parsing and verification fail closed

### Requirement: Exact authority transition identity

An attested original commit `O` and protected-main commit `M` MUST have equal
result trees, single parents with equal parent trees, byte-identical canonical
managed messages, the same change and grant identity, and a valid original SSH
commit signature under trusted policy.

#### Scenario: Rebase preserves the authority transition

- **WHEN** `tree(O) == tree(M)`, `tree(parent(O)) == tree(parent(M))`, both messages are byte-identical canonical authority messages, `O` verifies against its exact grant and trusted signer, and `M` is on protected-main first-parent history
- **THEN** replay recognizes `M` as the unique protected-main derivative of `O`

#### Scenario: Only the result tree matches

- **WHEN** result trees are equal but parent trees, commit messages, change IDs, grant IDs, signatures, or single-parent shape differ
- **THEN** replay rejects the mapping as a different or ambiguous authority transition

#### Scenario: Candidate adds its own trust

- **WHEN** a candidate commit changes verifier code, policy, or signer material while presenting an attestation
- **THEN** verification uses only base-owned code and previously trusted signer lineage and rejects candidate-self-authorization

### Requirement: Protected retention and unique mapping

Each accepted authority attestation MUST be retained by the exact annotated tag
`refs/tags/workflow-attestation/<grant-id>` targeting the signed original
authority commit. Each original and each protected-main authority commit SHALL
participate in at most one accepted mapping.

#### Scenario: Protected tag retains the original

- **WHEN** the exact tag name, headers, target, canonical envelope, signature, and primary grant agree
- **THEN** the original signed commit remains reachable and replay may evaluate the mapping

#### Scenario: Evidence is missing or conflicting

- **WHEN** the tag is absent, lightweight, malformed, differently targeted, replaced, duplicated, or conflicts with another original-to-main mapping
- **THEN** replay fails closed without selecting a same-tree alternative

### Requirement: Explicit grant-base identity mapping

Historical grant replay SHALL map a signed grant's original `baseCommit` to a
protected-main equivalent only through an explicit attested pair whose result
trees, parent trees, and canonical managed messages match and whose sorted grant
IDs all resolve to exact protected audit tags bound to that original base.

#### Scenario: Expired historical grant is replayed

- **WHEN** a protected grant envelope is now expired but its signature and issuance bounds are valid, its `baseCommit` equals the attested original base, and any successful authority commit occurred within the signed lifetime
- **THEN** historical replay may use the explicitly attested protected-main equivalent without treating the grant as currently usable

#### Scenario: Grant mapping is inferred or incomplete

- **WHEN** replay finds only a same-tree main commit, omits a grant bound to the original base, names a grant bound to another base, or observes unequal parent trees or messages
- **THEN** replay rejects the grant-base mapping

### Requirement: Base-owned historical replay gates sealing

The base-owned workflow verifier MUST scan protected-main first-parent history
for authority transitions and fail closed unless every transition has one valid
attestation and every referenced historical grant base has a valid explicit
mapping. Sealed enforcement SHALL NOT be declared while migration, protected
tag control, environment binding, or trusted signer lineage remains unproven.

#### Scenario: Complete historical lineage is replayable

- **WHEN** every protected-main authority commit and referenced original grant base resolves through unique valid protected attestations under the trusted signer lineage
- **THEN** base-owned replay succeeds and reports the covered authority grants and mappings

#### Scenario: Historical lineage is incomplete

- **WHEN** any authority commit, original object, grant base, tag, signature, trust binding, mapping, or main reachability check is absent or invalid
- **THEN** workflow assurance fails closed and the repository remains undeclared or bootstrap-only

#### Scenario: Signer is rotated before sealing

- **WHEN** the sealed trust root would remove a signer required to validate an original authority commit or its attestation without an old-key-authorized cross-signing rule
- **THEN** the sealing transition is rejected because historical provenance would become unverifiable

