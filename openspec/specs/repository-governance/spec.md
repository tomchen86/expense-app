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
full reachable history without persisting repository credentials. The
repository MUST represent `apps/web` only with ordinary tracked files and
directories, MUST NOT retain a gitlink at or below that path, and MUST NOT
create transient `.gitmodules` compatibility metadata during assurance
checkout.

#### Scenario: Ordinary web directory checkout

- **GIVEN** `apps/web` contains only ordinary tracked files and directories
- **AND** no `.gitmodules` entry is required for that path
- **WHEN** the pull-request assurance job checks out the event head
- **THEN** the pinned checkout completes without persisting credentials
- **AND** the workflow verifies the exact event head with full reachable
  history
- **AND** no transient submodule compatibility step runs before or after
  repository-controlled commands

#### Scenario: Retained gitlink has no configured submodule URL

- **GIVEN** a proposed repository tree retains the `apps/web` gitlink
- **AND** no persistent `.gitmodules` entry assigns that gitlink a URL
- **WHEN** the registered repository-governance contract runs
- **THEN** workflow assurance rejects the gitlink regression before merge
- **AND** no transient compatibility metadata is synthesized to mask the
  invalid tree

#### Scenario: Gitlink regression under the web path

- **GIVEN** Git records `apps/web` or one of its descendants with mode
  `160000`
- **WHEN** the registered repository-governance contract runs
- **THEN** workflow assurance fails before the change can be completed or
  merged

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

### Requirement: Archive-Stable Semantic Handoff

The generated semantic handoff SHALL preserve an explicitly selected completed
change when its tracked OpenSpec contract moves from the active change root to
the immutable archive, and normal hooks SHALL validate the same semantic
projection without local runtime evidence.

#### Scenario: Selected completed change is archived among multiple active changes

- **WHEN** the selected completed change has exactly one valid tracked archive
  contract and two or more unrelated active changes remain
- **THEN** handoff rendering and validation preserve the selected semantic
  change without choosing an unrelated active change
- **AND** the completed focus and references remain valid before and after the
  archive move

#### Scenario: New managed change takes ownership

- **WHEN** the selected change is archived and the current named branch exactly
  matches a valid active `work/<change-id>` change
- **THEN** the handoff selects that branch-bound active change through the
  normal generated-document transition

#### Scenario: Archived selection is unsafe or ambiguous

- **WHEN** the selected archived change is missing, duplicated, symlinked,
  malformed, or contains an incomplete task
- **THEN** handoff rendering and validation fail closed without selecting an
  arbitrary active change

### Requirement: Archive base resolves from the protected remote-tracking ref

Archive eligibility SHALL resolve its verification base from the first
protected branch's remote-tracking ref (`refs/remotes/origin/<branch>`),
using the same protected-base ref spelling as maintainer attestation.
Resolution MUST remain fail-closed, and CI archive replay — which binds to
the archive parent — MUST be unaffected.

#### Scenario: Stale local branch no longer blocks archive

- GIVEN the local protected branch is behind the remote-tracking ref
- AND every canonical task commit is reachable from the remote-tracking ref
- WHEN archive eligibility runs
- THEN the base resolves from the remote-tracking ref
- AND the archive is not blocked by the stale local branch

#### Scenario: Unresolvable base fails closed

- GIVEN the protected branch's remote-tracking ref does not resolve to a
  commit
- WHEN archive eligibility runs
- THEN it fails with the archive base resolution error

#### Scenario: Task commit off the base is still rejected

- GIVEN a canonical task commit is not reachable from the protected
  remote-tracking ref
- WHEN archive eligibility runs
- THEN it fails closed on unreachable task evidence

#### Scenario: One shared spelling across authority paths

- GIVEN maintainer attestation and archive eligibility both resolve the
  protected base
- WHEN either resolves the protected branch ref
- THEN both use the identical `refs/remotes/origin/<branch>` spelling from a
  single shared definition

