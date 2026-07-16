## Why

The post-merge pilot exposed two independent formatting authorities: managed
tasks and replay use the registered `workflow-format` definition, while GitHub
Actions runs the broader `prettier --check .` package script. The broader job
rejects canonical generated artifacts and pre-existing OpenSpec files that the
registered check intentionally does not own, so CI can block a valid managed
change even when workflow replay passes.

This is a CI-governance defect tracked under the workflow-assurance activation
work in `docs/issues/issues.yaml` (`ISS-003`).

## What Changes

- Add a workflow-engine command that executes one registered non-destructive
  check by ID through the same registry loader and pinned runner used by managed
  workflow evidence.
- Change the GitHub formatting job to invoke the registered `workflow-format`
  check through that command instead of maintaining its own repository-wide
  Prettier scope.
- Add contract and integration coverage proving the command rejects unknown or
  destructive checks and preserves the registered check definition as the only
  formatting authority.
- Document when agents and CI should use the single-check command.
- Preserve `workflow/checks.json` and the historical `workflow-format`
  definition byte-for-byte.

Scope is limited to CI/workflow-engine governance, tests, the GitHub formatting
workflow, and command documentation. No application, generated document,
OpenSpec schema/spec baseline, formatting output, dependency, or database state
is changed.

## Capabilities

### New Capabilities

- `ci-check-authority`: Defines how external CI invokes one registered workflow
  check without duplicating its command, runner, or path scope.

### Modified Capabilities

None.

## Impact

Affected surfaces are the workflow CLI and check runner, workflow-engine tests,
`.github/workflows/format.yml`, `AGENTS.md`, and `docs/WORKFLOW.md`. The change
adds no dependency and grants no new database or Git commit authority.
