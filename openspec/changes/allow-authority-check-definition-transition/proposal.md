## Why

The first real check-definition change through break-glass (PR #68,
`retire-bootstrap-format-scope`) failed CI with
`CI_CHECK_DEFINITION_CHANGED`: replay records an authority commit's check
definitions from its parent tree, and the current-registry comparison then
rejects any definition the authority commit itself changed. The bootstrap
pilot never changed a definition, so the gap stayed invisible. As written,
the engine forbids the exact operation break-glass exists to govern.

## What Changes

- A validated authority commit whose grant covers `workflow/checks.json`
  contributes its check definitions from its own tree, superseding earlier
  recorded definitions in the pull-request range.
- Task commits keep their existing parent-pinned definition evidence; the
  supersede applies only through the validated authority path.
- The current-registry comparison is unchanged: it now succeeds because the
  superseded map already reflects the sanctioned transition.

Non-goals: changing authority scope validation, grant validation, policy
transitions, or how ordinary task commits record definitions.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `break-glass-maintainer-mode`: Authority commits are the sanctioned
  transition for required-check definitions, and CI replay recognizes the
  transition instead of rejecting it.

## Impact

- Engine source: `ci-authority.ts`, `ci-sequence.ts`.
- Tests: `maintainer-mode.integration.test.ts`.
- Unblocks redoing `retire-bootstrap-format-scope` with a fresh grant.
