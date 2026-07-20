## ADDED Requirements

### Requirement: Archive evidence honors the canonical-evidence epoch

Archive eligibility and CI archive replay SHALL exempt a completed task from
the exactly-one-canonical-commit requirement only when that task was already
completed in the before tree of the change's earliest canonical plan commit.
Tasks completed under the canonical regime MUST keep the unmodified
requirement, and exempt tasks with exactly one canonical commit MUST keep
full recording and reachability verification.

#### Scenario: Bootstrap-era completions are exempt

- **WHEN** a change's earliest canonical plan commit has a before tree whose
  tasks are already completed and some of those tasks have zero or several
  canonical commits
- **THEN** the archive proceeds, recording task commits only where exactly
  one exists

#### Scenario: Canonical-era completions stay enforced

- **WHEN** a task was completed after the change's earliest canonical plan
  commit and lacks exactly one canonical commit
- **THEN** the archive fails closed

#### Scenario: Ordinary changes gain no exemption

- **WHEN** a change was introduced through a canonical plan introduction
- **THEN** its exempt set is empty because introductions must contain only
  unchecked tasks

#### Scenario: Live and replay agree

- **WHEN** an archive commit reaches CI archive replay
- **THEN** replay derives the identical exempt set from the archive parent
  and accepts exactly the archives live eligibility accepts
