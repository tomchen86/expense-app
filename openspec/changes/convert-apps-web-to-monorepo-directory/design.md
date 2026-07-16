## Context

The parent repository has always recorded `apps/web` as gitlink mode `160000`
at commit `4126efb678c2e692d82862b6366a0405573d2922`, but that object is unavailable
and no `.gitmodules` mapping identifies a source. Fresh worktrees therefore
contain an empty path, and Git's submodule commands fail before application
tooling is involved.

The protected `workflow-assurance` job currently synthesizes `.gitmodules`
metadata around pinned checkout so `actions/checkout` can remove credentials.
That runner-only bridge was appropriate for the post-merge pilot, but it is not
a valid permanent repository model. The active ruleset requires the real
workflow-assurance result, so the conversion and removal must land together in
one managed task and be proven on GitHub.

## Goals / Non-Goals

**Goals:**

- Replace the gitlink with an ordinary tracked directory without inventing
  source provenance.
- Remove all checkout steps and assertions that exist only for the malformed
  gitlink.
- Preserve exact pull-request head checkout, full reachable history, a pinned
  checkout action, and `persist-credentials: false`.
- Make ordinary submodule inspection succeed and reject future gitlinks under
  `apps/web` through a registered RED -> GREEN contract.
- Complete the task, protected merge, archive, and idempotent replay through
  repository workflow authority.

**Non-Goals:**

- Implementing or scaffolding a Next.js application.
- Recovering source by guessing a submodule URL or treating the parent
  repository as its own submodule.
- Changing workspace dependencies, package manifests, rulesets, applications,
  databases, or workflow-engine production code.
- Reformatting unrelated files or resolving existing non-required CI baselines.

## Decisions

### Select the placeholder path after an explicit source-recovery gate

The task creates only `apps/web/README.md`. The decision gate checked the
parent object database, all refs and worktrees, local Codespace and common
backup locations, and the maintainer's visible GitHub repositories. None
contained the referenced commit or a verifiable expense web repository.

Importing an unrelated project or generating a framework skeleton is rejected
because either would manufacture provenance and imply unsupported web
behavior. The README instead states the intended surface, its placeholder
status, and the conditions for a future managed scaffolding or recovery task.

### Treat the Git index as the structural authority

The regression contract invokes Git against the repository root and rejects
any `160000` entry at or below `apps/web`. A filesystem-only assertion is
insufficient because an empty directory can coexist with a gitlink index entry.
The same contract verifies that the workflow no longer contains preparation,
removal, restoration, `.gitmodules`, or `clean: false` compatibility markers.

The contract continues to assert the permanent security properties of pinned
checkout, exact event-head selection, `fetch-depth: 0`, and
`persist-credentials: false`. A failure is hard and blocks the registered
`workflow-tests` check; there is no compatibility fallback.

### Cross the Git file-to-directory boundary in two managed task commits

Git cannot represent deletion of an indexed gitlink and untracked descendants
below the same path as one unstaged worktree projection. The workflow engine
correctly reserves staging for `finish`, so manually removing the gitlink from
the index before finish is forbidden.

Task 1.1 therefore adds a RED -> GREEN transition contract and removes only the
gitlink. Its committed baseline has no entry at `apps/web` while the checkout
shim remains. Task 1.2 then adds the ordinary README, replaces the transitional
contract with the permanent index/workflow contract, and removes the shim.
Both commits land in one protected pull request, so the default branch observes
only the final coherent directory state.

Removing the shim in Task 1.1 is rejected because checkout still needs it for
the pull-request head until the final tree exists. Adding the README before the
gitlink deletion is rejected because Git hides descendants beneath the indexed
gitlink from the engine's unstaged change inspection.

Planning has its own workflow-owned revision commit. Each task has exact path
scope and the same four registered non-database checks. The workflow report is
the authority for allowed paths and completion; Markdown state is not evidence.

### Repair the post-merge archive delta without weakening the invariant

Pinned OpenSpec 1.6 refuses to archive a `MODIFIED` requirement when its delta
omits a scenario already present in the base requirement. The first archive
attempt therefore failed closed before changing files because the delta
replaced the retained-gitlink scenario with new ordinary-directory scenarios.

A planning-only revision preserves the exact historical scenario heading but
rewrites its body as a negative regression case: an unconfigured retained
gitlink is rejected by the registered contract and cannot merge. This satisfies
OpenSpec's no-silent-scenario-loss rule while keeping the permanent ordinary-
directory invariant; it does not restore checkout compatibility metadata or
permit a gitlink.

No implementation task is created because delta specs are planning authority
and task commits are forbidden from mutating them. The repair is exempt from
RED -> GREEN TDD; its evidence is strict OpenSpec validation, local and remote
PR assurance, and a successful idempotent archive replay.

## Trust Boundaries and Evidence

- The committed Git index, not the working-directory shape, proves that
  `apps/web` is ordinary tracked content.
- The registered contract and workflow source prove permanent checkout
  invariants before GitHub executes repository-controlled package commands.
- `git submodule status --recursive` proves no unconfigured submodule mapping
  remains.
- The task workflow report proves exact path scope and the four registered
  workflow-engine checks.
- GitHub's required `workflow-assurance` check recomputes the plan/task commit
  evidence from the pull-request head without a ruleset bypass.

## Risks / Trade-offs

- **Recovered source appears later** -> Import it only through a new managed
  change with recorded URL, revision, secret audit, and appropriate web checks.
- **The placeholder is mistaken for a web application** -> State explicitly
  that it contains no runtime and supports no capability claim.
- **A future gitlink reappears below `apps/web`** -> Fail the registered
  Git-index contract on any mode `160000` entry.
- **Checkout security is weakened while removing the shim** -> Preserve and
  assert the pinned action, exact event head, full history, and disabled
  credential persistence.
- **The first task commit lacks a web path** -> Keep it only as an intermediate
  commit in the protected branch; Task 2 supplies the final ordinary directory
  before the pull request may merge.

## Migration Plan

1. Commit this complete planning tree with `workflow plan-commit`.
2. Start Task 1.1, add a transitional contract that fails while the `apps/web`
   worktree path exists, remove the empty gitlink path without staging it, and
   let workflow finish stage and commit the deletion.
3. Start Task 1.2 and replace the transitional contract with the permanent
   Git-index and checkout contract, observe RED against the absent placeholder
   and retained shim, then add `apps/web/README.md` and remove only the three
   transient compatibility phases plus `clean: false`.
4. For each task, run the targeted contract and authoritative checks before
   complete-task, finish, and workflow commit. After Task 1.2, additionally run
   structural Git checks and frozen install.
5. Push and rebase-merge both task commits only after the active ruleset's real
   `workflow-assurance` check passes.
6. If archive detects scenario-loss incompatibility, submit a planning-only
   revision that retains the historical scenario as an explicit gitlink-
   regression case, and merge the repair through the same protected workflow.
7. From an updated default branch, run workflow archive twice, verify
   idempotency, and merge the archive pull request through the same rule.

Rollback before merge completes Task 1.2 or corrects the managed branch; the
intermediate deletion commit must not merge alone. Rollback after merge is
another managed ordinary-directory change; recreating the malformed gitlink or
restoring the transient shim is not an acceptable shortcut.

## Open Questions

None.
