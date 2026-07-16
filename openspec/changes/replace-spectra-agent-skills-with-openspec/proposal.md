## Why

The repository still tracks ten Spectra-generated agent skills even though
`AGENTS.md` forbids Spectra execution and the repository-owned OpenSpec workflow
is now authoritative. The maintainer approved replacing those executable agent
surfaces with the reviewed OpenSpec planning skills as part of the Roadmap's
[Finish repository workflow adoption](../../../docs/ROADMAP.md#finish-repository-workflow-adoption)
priority.

## What Changes

- Remove the ten tracked `.agents/skills/spectra-*` skill files approved by the
  maintainer.
- Add `.agents/skills/openspec-explore` and `openspec-propose` as byte-identical
  mirrors of the reviewed repository-local Codex skills.
- Replace stale Spectra skill-maintenance guidance with the OpenSpec planning
  boundary and update `AGENTS.md` and the Roadmap to describe the retained root
  Spectra configuration as historical-only, not an execution path.
- Add a repository contract that rejects tracked Spectra agent skills,
  divergent OpenSpec mirrors, nested Spectra metadata under `openspec/`, and
  contradictory agent instructions.
- Remove the two untracked nested `.spectra.yaml` files from the maintainer's
  main worktree after the managed change merges.

## Scope

This change is limited to repository agent-skill assets, their governing
documentation, and the workflow-engine repository contract test. It does not
change applications, APIs, dependencies, databases, or the workflow engine's
production lifecycle behavior.

## Non-Goals

- Deleting the tracked root `.spectra.yaml`; it remains historical
  compatibility data and grants no execution authority.
- Invoking Spectra, regenerating Spectra assets, or using Spectra lifecycle
  state.
- Changing the canonical `.codex/skills/openspec-*` sources or generated Codex
  prompt manifest.
- Archiving unrelated completed OpenSpec changes.

## Capabilities

### New Capabilities

- `agent-skill-governance`: Defines the allowed repository agent-skill surface,
  mirror integrity, and the non-executable status of retained Spectra data.

### Modified Capabilities

None.

## Impact

Tracked changes affect `.agents/skills/**`, `.agents/README.md`, `AGENTS.md`,
`docs/ROADMAP.md`, and the workflow-engine repository contract test. The
configuration/documentation portion is TDD-exempt, while the enforceable
repository invariant follows RED -> GREEN through the contract test. No
database tests are required.
