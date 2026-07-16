## ADDED Requirements

### Requirement: Authority maintenance is a fourth managed commit kind
Repository governance SHALL recognize task, plan, archive, and
authority-maintenance as the complete mutually exclusive managed commit kinds.

#### Scenario: Authority trailers are canonical
- **WHEN** the workflow engine creates an authority-maintenance commit
- **THEN** its final trailer block contains exactly `Change`, `Transition: authority-maintenance`, and `Grant` in canonical order

#### Scenario: Ordinary managed semantics remain unchanged
- **WHEN** CI validates task, plan, or archive commits after authority-maintenance support is installed
- **THEN** their existing trailer, scope, ordering, completion, and replay semantics remain unchanged

### Requirement: Authority verification is base-owned
The required workflow-assurance job MUST execute authority verification code and
load signer, policy, phase, and immutable-path trust from the exact pull-request
base or authority commit parent rather than the candidate branch.

#### Scenario: Candidate modifies its verifier
- **WHEN** a candidate authority commit changes verifier or trust-loading code
- **THEN** the base-owned verifier applies the previous trusted rules to that commit before the candidate code can become authoritative

#### Scenario: All normal checks remain required
- **WHEN** an authority-maintenance commit is otherwise valid
- **THEN** workflow-assurance still runs the complete check set required by trusted policy and the active change

### Requirement: Authority audit prerequisites remain maintainer-owned
Repository documentation SHALL distinguish checked-in enforcement from GitHub
tag protection, protected-environment approval, required-check configuration,
and repository-administrator recovery that only a maintainer can prove.

#### Scenario: Repository files are merged before remote controls
- **WHEN** the implementation is present but tag protection or the sealed approval environment has not been independently verified
- **THEN** project status describes maintainer mode as bootstrap-only and does not claim sealed enforcement
