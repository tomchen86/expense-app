## ADDED Requirements

### Requirement: Formatting and Generated Asset Validation Have Disjoint Scope

The registered `workflow-format` check SHALL own workflow-engine sources and explicitly listed human-maintained policy, schema, package, and governance documents. It MUST exclude the generated OpenSpec asset home. The registered `openspec-assets` check SHALL be the task-level validity authority for that generated asset home and every delivered target.

#### Scenario: Human-maintained workflow files are formatted

- **WHEN** `workflow-format` executes after the authority transition
- **THEN** it checks each declared human-maintained workflow policy and schema path
- **AND** it does not traverse `workflow/openspec-assets/`

#### Scenario: Generated assets are validated

- **WHEN** a task guard requires `openspec-assets`
- **THEN** the workflow runner executes the registered read-only asset check
- **AND** managed evidence and CI use that same registered definition without an alternate formatter scope

#### Scenario: Ordinary task changes required check ownership

- **WHEN** an ordinary task edits a check definition required by its policy or guard
- **THEN** task authorization and CI replay fail closed

## MODIFIED Requirements

### Requirement: Registered Checks Are the Sole CI Command Authority

External CI and local verification SHALL resolve a named check through the versioned workflow check registry and execute it through the repository-owned workflow runner. An adapter command or CI workflow MUST NOT maintain a second command, runner, or path-scope definition for that check.

#### Scenario: GitHub runs the formatting check

- **WHEN** the GitHub formatting job invokes its local verification entry point
- **THEN** the workflow engine resolves `workflow-format` from `workflow/checks.json`
- **THEN** the registered command and path scope are executed

#### Scenario: Task runs generated-asset validation

- **WHEN** a managed task or CI evidence set requires `openspec-assets`
- **THEN** the workflow engine resolves it from `workflow/checks.json`
- **THEN** the registered command is the only task-level OpenSpec asset validation command executed

#### Scenario: Historical definition is replayed

- **WHEN** historical task evidence references `workflow-format` or `openspec-assets`
- **THEN** replay continues to use the definition committed with that evidence
- **THEN** the CI adapter introduces no alternate formatting or asset-validation scope

## REMOVED Requirements

### Requirement: Formatting Scope Remains Historically Stable

**Reason**: The completed authority-unification migration no longer justifies freezing the broad format definition; that broad scope conflicts with the new generated-asset trust boundary.

**Migration**: A signed authority commit replaces only the registered format scope and adds the independent asset check, while historical task evidence continues to replay its committed definition.
