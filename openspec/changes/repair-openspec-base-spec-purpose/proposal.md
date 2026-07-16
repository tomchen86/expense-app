## Why

The post-merge archive pilot exposed three legacy normative base specs that do
not satisfy the pinned OpenSpec schema because they use `Current-State Scope`
where a `Purpose` section is required. Their baseline drift prevents every
managed change from completing the engine-owned archive transition.

This follows the active post-merge pilot item in `docs/ROADMAP.md`; the repair
is required before the completed `correct-codeowner-identity` change can be
archived.

## What Changes

- Add an executable repository contract that all normative OpenSpec base specs
  pass pinned strict validation.
- Preserve the existing scope prose while renaming the three nonconforming
  section headings to `Purpose`.
- Limit implementation scope to the validation contract and the three known
  invalid base specs.
- Do not change any requirement, scenario, product behavior, API, or retained
  legacy path.

## Capabilities

### New Capabilities

- `openspec-base-spec-validity`: Require normative base specs to retain the
  schema sections needed for pinned strict validation and archive readiness.

### Modified Capabilities

None. The existing category, collaboration, and identity requirements remain
unchanged; this repair only restores their required document structure.

## Impact

Affected paths are limited to the workflow-engine OpenSpec adapter contract
test and the `category-management`, `group-collaboration`, and
`identity-and-access` base specs. This is planning/test/documentation-only and
does not require database access. The heading repairs are exempt from
RED-GREEN-REFACTOR as documentation-only, while the repository contract itself
will be demonstrated RED before the headings are repaired and GREEN after.
