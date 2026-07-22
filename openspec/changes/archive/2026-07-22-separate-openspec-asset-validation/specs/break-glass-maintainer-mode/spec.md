## MODIFIED Requirements

### Requirement: Authority commits carry check-definition transitions

CI replay SHALL treat a validated authority commit whose grant covers `workflow/checks.json` as the authoritative source of required-check definitions from its own tree, superseding earlier recorded definitions in the range. A definition added by that commit but absent from the parent policy and guards MUST remain unexecuted until a later validated guard requires it. All other definition drift MUST still fail closed.

#### Scenario: Authority commit changes a required definition

- **WHEN** a fully validated authority commit edits a required check's definition and the head registry matches that edit
- **THEN** replay succeeds and reports the new definition

#### Scenario: Authority commit also adds an unused definition

- **WHEN** the same fully validated authority commit adds a structurally valid check ID that no parent policy or guard requires
- **THEN** the signed tree and complete registry remain validated
- **AND** replay does not report or execute the added definition as required-check evidence

#### Scenario: Later task activates the added definition

- **WHEN** a later planning transition validates an incomplete task guard that references the added check ID
- **AND** that task is executed against the post-authority registry
- **THEN** the engine pins and runs the registered definition
- **AND** CI records it as required evidence from that task onward

#### Scenario: Definition drifts without an authority transition

- **WHEN** required-check definitions differ across a range with no validated authority commit carrying the change
- **THEN** replay fails closed with the existing definition-drift error
