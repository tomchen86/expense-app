## Context

The repository already has a versioned check registry at `workflow/checks.json`.
Managed task evidence and historical CI replay resolve check IDs through that
registry, pin the runner closure, apply database policy, execute the registered
command, and reject checkout mutation. The `workflow-format` entry deliberately
owns a reviewed subset of repository paths.

The GitHub formatting workflow instead calls `pnpm run format:check`, whose
current script executes `prettier --check .`. That second scope includes
workflow-generated documents and pre-existing OpenSpec assets outside
`workflow-format`. PR #48 therefore passed managed replay but failed the GitHub
formatting job. Formatting the reported files would rewrite canonical generated
output and conceal the authority split.

## Goals / Non-Goals

**Goals:**

- Make `workflow/checks.json` the only source of the formatting check command,
  runner, database classification, and path scope.
- Give GitHub Actions and local verification a supported way to execute one
  registered check by ID.
- Reuse the existing runner pinning, environment, mutation detection, and
  repository validation boundaries.
- Preserve the current `workflow-format` definition byte-for-byte so historical
  task evidence and replay remain valid.

**Non-Goals:**

- Formatting, ignoring, or otherwise editing the eight files reported by the
  repository-wide Prettier invocation.
- Changing generated-document canonical output, OpenSpec schemas/base specs,
  check scope, dependencies, product code, or database policy.
- Allowing standalone execution of destructive database checks.

## Decisions

### 1. Add `workflow run-check <check-id>`

The CLI will expose a narrow command that resolves exactly one check from the
current registry and executes it through the existing pinned check runner. It
will require a clean checkout, bind execution to the current HEAD, reject an
unknown check ID, reject any check marked `destructiveDatabase`, reject worktree
mutation, validate repository state, and return structured check evidence.

Reusing the existing runner is preferred to reading JSON and spawning a command
inside GitHub YAML because a YAML implementation would duplicate runner
resolution and security policy while treating only the command array as shared.

### 2. Route the existing package verification script through the engine

`format:check` will call `pnpm workflow run-check workflow-format --json`.
GitHub Actions already calls `pnpm run format:check`, so the workflow file does
not need its own check ID, path list, or command. Local verification, the GitHub
job, managed task checks, and replay will all resolve the unchanged registry
entry.

Keeping the package script as a small adapter preserves the familiar developer
entry point without granting it independent formatting authority. The mutating
`format` convenience script is not evidence and remains unchanged.

### 3. Prove routing and failure boundaries with existing registered checks

Integration coverage will establish RED evidence for successful registered
execution, unknown-check rejection, destructive-check rejection, dirty-checkout
rejection, and mutation detection. Repository contracts will assert that the
package script delegates to the workflow command and that `workflow-format` is
unchanged from the planning base.

## Risks / Trade-offs

- **The standalone command could become a general bypass around task policy.**
  → It produces check evidence only, grants no task/completion/commit authority,
  requires a clean checkout, and refuses destructive checks.
- **Changing the package script could accidentally recurse into itself.**
  → The registered `workflow-format` command invokes the pinned Prettier binary
  directly, never the package script.
- **A future CI job could again duplicate a registry command.**
  → Contracts pin the adapter form and documentation names the registry as the
  authority.
- **PR #48 remains red until the repair reaches `main`.**
  → Merge this independent change first, then re-trigger PR #48 against the new
  base without modifying or formatting its eight reported files.

## Migration Plan

1. Commit this planning-only change through `workflow plan-commit`.
2. Add failing command/adapter contracts, implement the runner-backed command,
   and update command documentation.
3. Complete and commit the task through the managed lifecycle; prove the
   historical `workflow-format` JSON subtree is unchanged and run full branch
   CI.
4. Push and merge the independent repair PR.
5. Re-trigger PR #48 against updated `main`; do not rewrite generated artifacts.
6. Archive this change only after its merge is proven on the default branch.

Rollback is a separately reviewed logical revert of the adapter and command.
The registry definition requires no rollback because it never changes.

## Open Questions

None. The pilot failure and the existing runner boundaries determine the repair.
