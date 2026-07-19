# repository-knowledge-governance Specification

## Purpose
TBD - created by archiving change refresh-agent-document-governance-v2. Update Purpose after archive.
## Requirements
### Requirement: Agent Guide Uses Supported Planning Entry Points

The repository agent guide SHALL identify `openspec-explore` as the read-only
thinking and investigation skill and `openspec-propose` as the planning-artifact
creation skill. It MUST NOT advertise guessed aliases or retired execution
systems, and it SHALL route implementation authority to the workflow engine.

#### Scenario: Agent needs to clarify a change

- **WHEN** a request needs investigation or clarification before implementation
- **THEN** the guide directs the agent to `openspec-explore`
- **THEN** exploration does not authorize implementation

#### Scenario: Agent needs a complete managed plan

- **WHEN** requirements are clear enough for proposal, design, specs, tasks, and guard artifacts
- **THEN** the guide directs the agent to `openspec-propose`
- **THEN** implementation begins only after a workflow plan commit and task start

### Requirement: Agent Guide Explains Every Workflow Command

The repository agent guide SHALL state when to use every public command and
subcommand exposed by the workflow CLI. It SHALL distinguish diagnostics,
planning, execution, recovery, archive, document, issue, asset, handoff, hook,
adapter, and CI responsibilities without treating prose as authority.

#### Scenario: Agent selects a workflow transition

- **WHEN** an agent needs to diagnose, plan, execute, recover, archive, or verify a managed change
- **THEN** the guide provides the relevant command and its permitted use
- **THEN** detailed procedures remain linked to `docs/WORKFLOW.md`

#### Scenario: CLI surface changes

- **WHEN** public CLI usage no longer matches the documented command table
- **THEN** the governance contract fails until they are reconciled

### Requirement: Source Size Does Not Authorize Churn

The repository SHALL prefer focused TypeScript modules and MAY use 500 lines as
a maintainability review signal. Agents MUST NOT edit, split, or refactor source
solely because a file exceeds 500 lines; source changes require a concrete scoped
objective and normal verification.

#### Scenario: Large source file has no scoped defect

- **WHEN** a source file exceeds 500 lines but no behavior or maintainability objective is in scope
- **THEN** the source file remains unchanged

### Requirement: Documentation Entry Point Is a Project Overview

`docs/README.md` SHALL orient a new reader to the application's purpose,
implemented surfaces, current maturity, capabilities, local setup, test safety,
and canonical next links. It MUST NOT duplicate the canonical tree, mutation
policy, or placement guide owned by `docs/DOCUMENT_STRUCTURE_GUIDE.md`.

#### Scenario: New contributor opens the entry point

- **WHEN** a reader opens `docs/README.md` without prior context
- **THEN** they can identify the product and roles of mobile, API, and web surfaces
- **THEN** they can locate setup, priorities, workflow, architecture, and document governance

### Requirement: Canonical Inventory Excludes Legacy Live Trees

The document structure guide and repository contracts SHALL define the current
canonical inventory. The CI-anchored document policy SHALL remain byte-identical
to the merge base and continue to classify `docs/archive/**` as immutable.
Approved root notes and `docs/planning/`, `docs/status/`, `docs/logs/`, and
`docs/template/` MUST NOT remain in the live document system after migration.

#### Scenario: Legacy documents are archived

- **WHEN** the migration is complete
- **THEN** every approved source exists at `docs/archive/legacy/<relative-path>` with preserved content
- **THEN** no approved source remains at its former live path

#### Scenario: Canonical document is considered

- **WHEN** a file belongs to the final canonical inventory
- **THEN** this migration leaves it outside the archive

### Requirement: Local Memo Board Is Ignored by Git and Workflow

The repository `.gitignore` SHALL contain root-anchored `/memo/` so the
maintainer may add or remove local memo content without changing Git status or
workflow controlled-untracked state.

#### Scenario: Local memo exists

- **WHEN** an untracked file exists below repository-root `memo/`
- **THEN** Git classifies it as repository-ignored
- **THEN** workflow does not report it as a controlled untracked path

#### Scenario: Untracked file exists elsewhere

- **WHEN** an untracked file exists outside repository ignore rules
- **THEN** workflow continues to fail closed

