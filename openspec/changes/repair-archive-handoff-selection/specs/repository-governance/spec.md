## ADDED Requirements

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
