## ADDED Requirements

### Requirement: CI plan replay rejects duplicate planning-tree entries

CI plan replay SHALL fail closed when a planning tree's recursive listing
contains the same normalized path more than once, and MUST leave trees with
unique paths unaffected.

#### Scenario: Crafted duplicate entry

- **WHEN** a planning commit's tree carries two entries with the same path
  inside the named change's tree
- **THEN** CI plan replay fails closed before any structural assertion
  consumes the listing

#### Scenario: Unique trees are unaffected

- **WHEN** a planning commit's trees contain only unique paths
- **THEN** validation behaves exactly as before
