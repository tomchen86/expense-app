# repository-governance Specification

## Purpose
TBD - created by archiving change correct-codeowner-identity. Update Purpose after archive.
## Requirements
### Requirement: Valid Repository Code Ownership

Every CODEOWNER assigned to a protected repository path SHALL resolve to an
existing GitHub user or team with explicit write access to the repository. The
repository MUST retain an ownership rule for the CODEOWNERS file itself.

#### Scenario: Configured owner is eligible

- **GIVEN** the repository ownership file assigns a protected path to an owner
- **WHEN** GitHub validates the CODEOWNERS file on the default branch
- **THEN** the owner resolves without a CODEOWNERS diagnostic
- **AND** the owner has explicit write access to the repository

#### Scenario: Configured owner is unknown or ineligible

- **GIVEN** an ownership entry names a missing user, hidden team, or identity
  without explicit write access
- **WHEN** repository governance is reviewed for activation
- **THEN** remote enforcement remains inactive
- **AND** the invalid ownership entry is corrected through a managed change

### Requirement: Maintainer-Aware Pull Request Enforcement

The protected default branch SHALL require pull requests, the strict
`workflow-assurance` status check against an up-to-date base, and no bypass.
Code-owner approval with stale-review dismissal SHALL additionally be required
only when at least two independent eligible human maintainers exist.

#### Scenario: Repository has one eligible human maintainer

- **GIVEN** the pull-request author is the repository's only eligible human
  maintainer
- **WHEN** protected-branch rules are configured
- **THEN** zero approving reviews are required
- **AND** code-owner review and stale-review dismissal are disabled
- **AND** pull-request, strict status-check, current-base, and no-bypass rules
  remain enforced

#### Scenario: Repository has an independent eligible reviewer

- **GIVEN** at least two independent eligible human maintainers exist
- **WHEN** protected-branch rules are configured
- **THEN** a code-owner approval from an eligible human other than the author
  is required
- **AND** new reviewable pushes dismiss stale approval

### Requirement: Staged Governance Activation

Remote merge enforcement SHALL be activated only after the corrected
CODEOWNERS file is present on the default branch and GitHub reports no
CODEOWNERS diagnostics. Activation evidence MUST include the effective ruleset
state and a pull request whose required `workflow-assurance` check is enforced.

#### Scenario: Correct ownership reaches the base

- **GIVEN** the ownership correction has merged into the default branch
- **AND** GitHub reports no CODEOWNERS errors for that branch
- **WHEN** the maintainer activates the repository ruleset
- **THEN** the configured solo- or multi-maintainer review policy becomes
  effective
- **AND** an archive pull request proves the required status check before
  workflow support is declared

### Requirement: Credential-Free Assurance Checkout Compatibility

The pull-request assurance workflow SHALL check out the exact event head with
full reachable history without persisting repository credentials. A retained
unconfigured gitlink SHALL NOT prevent checkout, and any runner-only
compatibility metadata SHALL be removed before repository-controlled commands
execute.

#### Scenario: Retained gitlink has no configured submodule URL

- **GIVEN** the repository tree contains the retained `apps/web` gitlink
- **AND** no persistent `.gitmodules` entry assigns that gitlink a URL
- **WHEN** the pull-request assurance job checks out the event head
- **THEN** the pinned checkout completes without persisting credentials
- **AND** the workflow verifies the exact event head with full reachable
  history
- **AND** transient compatibility metadata is absent before dependency
  installation or workflow-engine execution

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

