## Why

The repository currently borrows OpenSpec's directory conventions without
pinning or executing upstream OpenSpec, so planning validation, agent guidance,
and archival are not connected to the executable workflow authority. The
`docs/ROADMAP.md#finish-repository-workflow-adoption` priority now requires one
reproducible path from OpenSpec planning through workflow-controlled evidence,
Git transitions, and archive.

## What Changes

- Pin `@fission-ai/openspec@1.6.0`, deny its optional postinstall script, and
  route machine calls through a typed, fail-closed workflow adapter.
- Add a project-local `expense-app` OpenSpec schema whose artifact graph
  requires repository-validated `guard.json` policy.
- Extend change validation to combine OpenSpec artifact/delta validation with
  task, check-registry, path, and digest validation.
- Add a workflow-owned planning commit transition so new and revised planning
  artifacts no longer require an out-of-band Git path.
- Generate only reviewed planning-oriented Codex assets in isolated temporary
  homes; do not expose OpenSpec apply, sync, or archive lifecycle actions.
- Add a workflow-owned archive transition that runs the pinned OpenSpec CLI in
  a temporary worktree, verifies the exact transformation, and lets hooks and
  CI recompute plan/task/archive evidence.
- Make workflow tests independent of the caller's package working directory
  before extending the engine.

## Capabilities

### New Capabilities

- `openspec-workflow-integration`: Defines the pinned OpenSpec planning
  boundary, project schema, planning-only agent surface, workflow-controlled
  plan and archive transitions, and reproducible verification contract.

### Modified Capabilities

- None. The existing workflow engine remains the assurance authority; this
  change adds an integration boundary without rewriting application capability
  requirements.

## Scope and Non-Goals

- The change affects repository tooling, planning artifacts, hooks, CI, and
  developer documentation only; it does not change API, mobile, or web product
  behavior.
- Spectra remains installed for compatibility and history but is never invoked.
- `OpenSpec-main/` is inspection material only and is not vendored, executed,
  staged, or rewritten.
- The workflow engine will not duplicate OpenSpec proposals, task definitions,
  templates, or artifact graph state.

## Impact

- Root dependency and lockfile metadata gain the exact OpenSpec package; the
  existing workspace supply-chain policy explicitly rejects its optional
  postinstall script.
- `openspec/`, `packages/workflow-engine/`, `workflow/`, `.codex/`, Git hooks,
  CI configuration, and workflow documentation gain integration code and
  verification fixtures.
- Managed commits gain mutually exclusive task, plan, and archive transition
  forms. No remote push or GitHub settings change is part of this change.
