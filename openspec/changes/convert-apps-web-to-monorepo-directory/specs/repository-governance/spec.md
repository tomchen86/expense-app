## MODIFIED Requirements

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
