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

### Convert the tree and workflow in one managed task

Removing only the shim would break checkout while the gitlink remains.
Converting only the gitlink would leave unnecessary runner mutation and dead
security-sensitive code. One narrowly scoped task makes the repository tree,
workflow, and registered contract change atomically.

Planning has its own workflow-owned commit. Task scope names the gitlink path,
its future descendants, the assurance workflow, and the single registered
contract file. The workflow report is the authority for allowed paths and
non-database checks; Markdown completion is not evidence.

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
- **The tree conversion is partially applied** -> Workflow path checks and the
  task commit bind the index, README, workflow, and contract as one transition.

## Migration Plan

1. Commit this complete planning tree with `workflow plan-commit`.
2. Start Task 1.1 and change only the registered contract to record the RED
   failure against the retained gitlink and workaround.
3. Remove the gitlink, add the placeholder README, and remove only the three
   transient compatibility phases plus `clean: false` from assurance checkout.
4. Run the targeted contract, structural Git checks, frozen install, and the
   authoritative task check before complete-task, finish, and workflow commit.
5. Push and rebase-merge only after the active ruleset's real
   `workflow-assurance` check passes.
6. From an updated default branch, run workflow archive twice, verify
   idempotency, and merge the archive pull request through the same rule.

Rollback before merge is a correction on the managed branch. Rollback after
merge is another managed ordinary-directory change; recreating the malformed
gitlink or restoring the transient shim is not an acceptable shortcut.

## Open Questions

None.
