# openspec-base-spec-validity Specification

## Purpose
TBD - created by archiving change repair-openspec-base-spec-purpose. Update Purpose after archive.
## Requirements
### Requirement: Normative Base Specs Pass Pinned Strict Validation

The repository SHALL keep every normative OpenSpec base specification
compatible with the repository-pinned strict validator. Each base
specification MUST contain the required `Purpose` and `Requirements` sections,
and validation failure MUST block managed archive readiness rather than being
ignored or bypassed.

#### Scenario: Repository baseline is valid

- **WHEN** the registered repository contract validates all normative base
  specifications with the pinned OpenSpec adapter
- **THEN** strict validation succeeds for the complete base-spec set
- **THEN** the result is eligible to serve as evidence for a later
  engine-owned archive transition

#### Scenario: A base spec loses required structure

- **WHEN** any normative base specification lacks a schema-required section
- **THEN** the registered repository contract fails
- **THEN** the workflow engine continues to reject archive readiness until a
  managed repair restores validity

### Requirement: Structural Repairs Preserve Requirement Semantics

A repair for legacy base-spec structure SHALL preserve the existing purpose
prose, requirements, and scenarios unless a separate delta explicitly changes
their semantics. A documentation-only repair MUST remain limited to the exact
invalid structural elements.

#### Scenario: Legacy scope heading is repaired

- **WHEN** an existing scope paragraph already states a specification's
  purpose but uses a nonconforming section heading
- **THEN** the repair renames that heading to `Purpose`
- **THEN** all requirement and scenario content remains unchanged

