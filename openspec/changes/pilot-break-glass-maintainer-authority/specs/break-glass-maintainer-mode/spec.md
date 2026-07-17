## ADDED Requirements

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
