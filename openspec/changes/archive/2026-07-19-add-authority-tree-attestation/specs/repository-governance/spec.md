## MODIFIED Requirements

### Requirement: Authority verification is base-owned
The required workflow-assurance job MUST execute authority and attestation
verification code and load signer, policy, phase, immutable-path trust, and
historical replay rules from the exact pull-request base or authority commit
parent rather than the candidate branch. The base-owned verifier MUST reject a
protected-main authority commit that lacks a unique valid retained signed
original and explicit grant-base mappings.

#### Scenario: Candidate modifies its verifier
- **WHEN** a candidate authority commit changes verifier or trust-loading code
- **THEN** the base-owned verifier applies the previous trusted rules to that commit before the candidate code can become authoritative

#### Scenario: All normal checks remain required
- **WHEN** an authority-maintenance commit is otherwise valid
- **THEN** workflow-assurance still runs the complete check set required by trusted policy and the active change

#### Scenario: Historical main authority is replayed
- **WHEN** workflow-assurance evaluates a pull request whose base first-parent history contains a rebase-produced authority commit
- **THEN** base-owned code verifies the protected attestation, retained signed original, exact transition identity, grant lineage, and protected-main reachability before evaluating candidate commits

#### Scenario: Candidate supplies missing history evidence
- **WHEN** an attestation, signer, original object, or mapping is available only from candidate-controlled history or trust material
- **THEN** workflow-assurance rejects it as candidate-self-authorized evidence

### Requirement: Authority audit prerequisites remain maintainer-owned
Repository documentation SHALL distinguish checked-in enforcement from GitHub
grant-tag and attestation-tag protection, protected-environment approval,
required-check configuration, human-present signing, and
repository-administrator recovery that only a maintainer can prove. Sealed
support MUST remain undeclared until those remote controls and complete
historical attestation replay are independently evidenced.

#### Scenario: Repository files are merged before remote controls
- **WHEN** the implementation is present but grant-tag protection, attestation-tag protection, historical migration, or the sealed approval environment has not been independently verified
- **THEN** project status describes maintainer mode as bootstrap-only and does not claim sealed enforcement

#### Scenario: Attestation migration is remotely proven
- **WHEN** the maintainer protects and publishes the migration tag and a later pull request passes the base-owned historical replay without bypass
- **THEN** retained evidence may mark authority tree attestation proven while environment, signer, and sealed-transition gates remain separate
