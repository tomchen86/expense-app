## Why

`apps/web` is recorded as an unconfigured gitlink whose referenced commit is
unavailable, so fresh clones have no usable web source and ordinary submodule
inspection fails. `workflow-assurance` currently carries runner-only
compatibility metadata solely to tolerate this malformed tree state; `ISS-205`
requires the repository to recover a valid web source before making web
capability claims.

## What Changes

- Replace the malformed `apps/web` gitlink with an ordinary tracked monorepo
  directory.
- Use an honest `apps/web/README.md` placeholder because the source-recovery
  decision gate found no recoverable web repository or commit.
- Remove the transient `.gitmodules` preparation, removal, and restoration
  steps from `workflow-assurance`.
- Replace the retained-gitlink regression contract with a permanent contract
  that rejects gitlinks under `apps/web`, rejects the retired workaround, and
  preserves pinned credential-free exact-head checkout with full history.
- Prove ordinary Git and submodule inspection, frozen dependency installation,
  and managed workflow checks without inventing a submodule URL.

## Scope

The managed tasks are limited to `apps/web`,
`.github/workflows/workflow-assurance.yml`, and
`packages/workflow-engine/test/contracts.test.ts`. Planning artifacts record
the selected source strategy, the Git transition boundary, and managed
evidence.

## Non-Goals

- Reconstructing or fabricating a Next.js application without recovered
  source.
- Adding a persistent `.gitmodules` entry or guessing an external repository
  URL.
- Claiming that the placeholder implements a web capability.
- Changing API, mobile, database, dependency, workspace, ruleset, or workflow
  engine production behavior.
- Mixing unrelated formatting, API timing, archival, or legacy-document work
  into this structural correction.

## Decision Gate Result

The gitlink references `4126efb678c2e692d82862b6366a0405573d2922`,
which is absent from the parent object database and every local or remote ref.
No usable source was found in existing repository worktrees, the maintainer's
Codespace and common local backup locations, or the maintainer's visible GitHub
repositories. The mutually exclusive placeholder strategy is therefore
selected. The future scaffolding task must start from explicit requirements or
recovered provenance rather than treating this README as application source.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `repository-governance`: Replace retained-gitlink checkout compatibility
  requirements with a permanent ordinary-directory and credential-free
  checkout invariant.

## Impact

Git changes the `apps/web` tree entry from mode `160000` to ordinary tracked
files. GitHub Actions loses the transient compatibility steps but retains the
pinned checkout action, exact pull-request head selection, full reachable
history, and `persist-credentials: false`. No runtime application, API,
database, dependency, or public interface changes.
