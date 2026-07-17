# break-glass-maintainer-mode Specification

## Purpose
TBD - created by archiving change add-break-glass-maintainer-mode. Update Purpose after archive.
## Requirements
### Requirement: Human-present grant issuance
The workflow engine SHALL keep maintainer mode closed by default and SHALL
issue a grant only from a controlling interactive terminal through a trusted
SSH signer that requires human presence.

#### Scenario: Non-interactive issuance is rejected
- **WHEN** grant issuance lacks a controlling input or output TTY
- **THEN** the engine rejects the request before signing or writing grant state

#### Scenario: Unattended signer is rejected
- **WHEN** the configured software key can sign without an interactive secret or the request attempts to use an SSH agent, askpass program, environment bypass, or force option
- **THEN** the engine rejects the request and creates no grant

#### Scenario: Human-present issuance succeeds
- **WHEN** a trusted encrypted SSH key or human-presence hardware key signs a valid canonical grant from an interactive terminal
- **THEN** the engine stores one local available token and creates one signed non-secret audit envelope

### Requirement: Canonical single-purpose grant
Every grant SHALL use a versioned canonical signed payload bound to the trusted
policy, stable repository identity, canonical origin, full base commit, OpenSpec
change, sorted unique exact paths, issue and expiry times, one use, reason, and
trusted signer identity.

#### Scenario: Default grant bounds are narrow
- **WHEN** a maintainer omits TTL and use-count options
- **THEN** the engine issues a grant valid for no more than 30 minutes and exactly one use

#### Scenario: Altered authorization is rejected
- **WHEN** any signed authorization field, schema version, policy blob, signature, repository, base, change, path, time, reason, use count, or signer differs from the trusted canonical payload
- **THEN** the engine rejects the grant

#### Scenario: Unsafe grant path is rejected
- **WHEN** a path is absolute, traversing, globbed, a directory, missing, untracked, symlinked, case-ambiguous, non-exact-case, or outside bootstrap eligibility
- **THEN** the engine refuses to issue or reserve the grant

### Requirement: Git-common-directory grant state
The engine MUST keep available tokens, reservations, terminal records, and
recovery journals in the Git common directory with restrictive permissions and
atomic persistence shared by all linked worktrees.

#### Scenario: Concurrent worktrees compete for one grant
- **WHEN** two worktrees attempt to reserve the same available grant
- **THEN** exactly one reservation succeeds and the other fails without obtaining authority

#### Scenario: Worktree contains no bearer token
- **WHEN** a grant is issued, reserved, consumed, revoked, or recovered
- **THEN** no reusable grant or reservation token is written to or committed from the worktree

### Requirement: Protected audit envelope
Grant issuance SHALL create an immutable namespaced Git audit tag containing
the signed non-secret envelope, and authority CI SHALL require that exact tag
and verify it against parent/base trust material.

#### Scenario: Missing or different audit tag is rejected
- **WHEN** CI cannot resolve the exact grant tag or its envelope differs from the locally claimed grant
- **THEN** the authority commit fails verification

#### Scenario: Candidate key cannot validate its own envelope
- **WHEN** a candidate branch adds or changes a signer while claiming an authority grant
- **THEN** CI verifies the envelope only with signers trusted by the authority commit parent

### Requirement: Isolated authority session
The engine SHALL expose `authority-start`, `authority-check`, and
`authority-commit` as a state machine separate from ordinary task, plan, and
archive transitions.

#### Scenario: Start reserves a valid grant
- **WHEN** a clean eligible branch at the exact grant base starts the matching change with the matching audit envelope and no lifecycle conflict
- **THEN** the engine atomically reserves the grant and pins the repository, policy, contract, paths, signer, and checks in an authority session

#### Scenario: Authority check preserves normal checks
- **WHEN** an active authority session has changes only to exact granted paths
- **THEN** the engine runs every normally required schema, lint, test, document, secret, safety, and non-destructive database-policy check and records content-addressed evidence

#### Scenario: Failed operation closes authority
- **WHEN** start after reservation, check, commit, cancellation, expiry, signature validation, base validation, path validation, or lock validation fails
- **THEN** the session closes, the reservation becomes terminally revoked or consumed, and the grant cannot become available again

### Requirement: Exact authority commit isolation
`authority-commit` MUST create one signed commit with exactly the granted
authority diff and canonical mutually exclusive `Change`,
`Transition: authority-maintenance`, and `Grant` trailers.

#### Scenario: Exact authority commit succeeds
- **WHEN** at least one granted file changed, no ungranted path changed, current evidence passes, HEAD remains the grant base, and the trusted signer signs the commit
- **THEN** the engine atomically advances the branch to one authority-maintenance commit and consumes the grant

#### Scenario: Mixed work is rejected
- **WHEN** the diff contains product code, ordinary documentation, task completion, generated files, or any path absent from the exact grant
- **THEN** the engine rejects the commit and terminally closes that grant use

#### Scenario: Managed trailer forms are mixed
- **WHEN** an authority commit also contains `Task`, `plan`, `archive`, another transition, or a non-canonical reserved trailer
- **THEN** local hooks and CI reject the commit

### Requirement: Fail-closed commit recovery
Authority commit creation and grant consumption MUST be one recoverable logical
operation with durable journal states and exact compare-and-swap ref updates.

#### Scenario: Crash occurs after commit object creation
- **WHEN** recovery finds a valid signed commit object journaled for the still-exact base but the branch ref was not updated
- **THEN** recovery may perform the one pending exact-old-OID ref update and then consume the grant

#### Scenario: Crash occurs after ref update
- **WHEN** recovery proves the branch points to the exact journaled valid commit
- **THEN** recovery idempotently records consumption and never reactivates the grant

#### Scenario: Recovery state is ambiguous
- **WHEN** the journal, branch, commit, signature, tree, base, or reservation does not match exactly
- **THEN** recovery revokes the use and refuses to create or accept another commit

### Requirement: Revocation and replay resistance
The engine SHALL provide read-only inspection and idempotent explicit
revocation, and SHALL reject expired, revoked, consumed, reserved-by-other,
previously committed, or duplicate grants.

#### Scenario: Revoke is repeated
- **WHEN** the maintainer revokes the same available, reserved, revoked, or consumed grant more than once
- **THEN** cleanup remains safe and the grant never returns to available state

#### Scenario: Grant is claimed twice
- **WHEN** local state or a pull-request range claims one grant for more than one session or commit
- **THEN** the engine rejects every duplicate use

### Requirement: Bootstrap and sealed trust phases
The trusted maintainer policy SHALL begin in bootstrap and SHALL permit only a
one-way, old-key-authorized transition to sealed mode with immutable verifier
and trust-root paths.

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
- **WHEN** an existing trusted key authorizes an otherwise valid policy change that introduces a replacement key without weakening immutable paths
- **THEN** the replacement becomes trusted only after the authority commit merges

### Requirement: Real Bootstrap Pilot Evidence

Before break-glass maintainer mode can be described as remotely proven, the
repository SHALL retain evidence from a real maintainer-owned, non-database
bootstrap pilot under the configured protected branch, audit-tag, signer, and
base-owned CI boundaries.

#### Scenario: Negative grant lifecycle is terminal

- **WHEN** separate real grants are explicitly revoked twice, expire after one minute, or fail a harmless pre-commit check
- **THEN** every use reaches a terminal non-reusable state and its protected signed audit tag remains available for investigation

#### Scenario: Successful authority transition is independently verified

- **WHEN** the active pilot's semantic handoff is first refreshed through its scoped ordinary task and a fresh human-signed grant then authorizes one exact harmless authority file
- **AND** all pinned checks pass, the signed authority commit is created, and recovery is called again
- **THEN** the grant is consumed exactly once, recovery returns the same commit identity, and no ordinary or product path is included
- **AND** the pull request passes the strict base-owned `workflow-assurance` check without a ruleset exception

#### Scenario: Evidence closes only after merge

- **WHEN** local pilot evidence exists but the protected pull request has not yet passed and merged
- **THEN** the post-merge evidence task and archive remain incomplete
- **AND** the repository remains explicitly in bootstrap phase

