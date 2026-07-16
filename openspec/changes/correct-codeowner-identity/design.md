## Context

GitHub currently parses every `@htchen` entry in `.github/CODEOWNERS` as an
unknown owner. The authenticated repository administrator is `tomchen86`, who
has explicit write and admin access. The existing
`protect-main-workflow-assurance` ruleset is disabled, so the ownership repair
can land before remote enforcement is activated.

This change is the real post-merge pilot described by `docs/WORKFLOW.md`. It
must prove a planning transition, one managed task, Git-recomputed CI, archive
idempotency, remote ruleset enforcement, and an observed Codex skill-discovery
surface without relying on developer runtime reports.

## Goals / Non-Goals

**Goals:**

- Replace the invalid CODEOWNER with the verified repository administrator.
- Keep pull requests, strict `workflow-assurance`, an up-to-date base, and no
  bypass mandatory in both solo- and multi-maintainer operation.
- Avoid an impossible approval gate when the sole eligible maintainer is also
  the pull-request author.
- Preserve credential-free exact-head checkout even though the retained
  `apps/web` gitlink has no `.gitmodules` entry.
- Exercise the complete managed plan, task, archive, idempotency, and CI path.

**Non-Goals:**

- Mutating remote GitHub rules inside the task commit.
- Adding collaborators or deciding who a future second maintainer should be.
- Rewriting historical usernames or filesystem paths in retained documents.
- Changing workflow engine production code, check policy, application code, or
  databases.
- Removing the retained gitlink or assigning it a persistent guessed URL.

## Decisions

### Use the verified GitHub login as the sole current CODEOWNER

Every existing `@htchen` entry is replaced with `@tomchen86`. GitHub's API is
the external identity and permission authority; the task does not infer access
from the repository name alone. All existing ownership patterns remain intact.

The alternative of removing CODEOWNERS would avoid parse errors but discard
useful ownership routing and make future multi-maintainer enforcement harder.

### Make approval requirements depend on an independent human reviewer

The protected branch always requires a pull request, strict
`workflow-assurance`, an up-to-date base, and no bypass. Code-owner approval
and stale-review dismissal are required only when at least two independent
eligible human maintainers exist. A solo maintainer therefore uses zero
required approvals while retaining every machine-enforced gate.

The alternative of requiring the sole CODEOWNER to approve every pull request
is rejected because the author cannot provide an independent approval.

### Stage remote enforcement between the task and archive pull requests

The managed task changes only tracked repository configuration and guidance.
Its pull request runs the real GitHub Actions workflow while the ruleset
remains disabled. After that commit reaches `main`, GitHub CODEOWNERS
diagnostics must be empty before the existing ruleset is activated with zero
required approvals and code-owner review disabled.

The subsequent archive pull request then proves the remote ruleset actually
requires the strict `workflow-assurance` status check. Ruleset mutation and API
observations are recorded as pilot-review evidence, not as workflow task
evidence.

### Treat this task as exempt from TDD

This is a configuration/documentation-only correction with no production
behavior. The task therefore uses the repository's documented TDD exemption.
Verification consists of managed non-database checks, GitHub CODEOWNERS
diagnostics, the real pull-request check, archive replay, and ruleset state.

### Bootstrap checkout with transient compatibility metadata

The real pilot showed that pinned `actions/checkout` cannot remove its
temporary authentication when Git sees the retained `apps/web` gitlink without
a matching `.gitmodules` entry. The assurance workflow therefore preinitializes
the runner repository with the expected origin and a transient `.gitmodules`
entry, invokes the pinned checkout with cleaning disabled and credential
persistence still disabled, then removes the transient file before any
repository code executes.

The transient URL is never committed and the submodule is never initialized.
This preserves full-history exact-head checkout without exposing the GitHub
token to repository code or asserting that `apps/web` is a valid submodule.
Task 1.2 follows RED -> GREEN -> REFACTOR by first extending the workflow
integration contract, observing the failure, and then changing the workflow.

## Risks / Trade-offs

- **The replacement login lacks access later** -> Check GitHub CODEOWNERS
  diagnostics before ruleset activation and fail closed if any error remains.
- **Solo policy is mistaken for review bypass** -> Keep pull requests, strict
  required checks, current-base enforcement, and an empty bypass list active.
- **Rules are enabled before the repair reaches the base** -> Keep the ruleset
  disabled through the task pull request and activate it only after verifying
  the updated default branch.
- **A second maintainer is added without stronger review policy** -> The
  normative rule requires code-owner approval and stale dismissal once two
  independent eligible humans exist; that transition needs a reviewed
  governance change.
- **Transient compatibility metadata leaks into verification** -> Remove it in
  the first post-checkout step and assert both preparation and cleanup in the
  workflow integration contract.

## Migration Plan

1. Commit the complete planning tree through `pnpm workflow plan-commit`.
2. Execute Task 1.1 through the managed task lifecycle.
3. If the real check exposes the retained-gitlink checkout failure, execute the
   regression-tested Task 1.2 in the same pilot pull request.
4. Merge the task pull request after its real `workflow-assurance` run passes.
5. Verify zero CODEOWNERS errors on `main` and activate the existing solo-mode
   ruleset.
6. Archive the change twice from a fresh branch, require the second result to
   be `already-archived`, and merge the archive pull request through the active
   remote rule.

Before ruleset activation, rollback is a normal managed revert of the task
commit. After activation, rollback must itself pass the active pull-request and
status-check rules; the ruleset must not be disabled as a shortcut.

## Open Questions

None.
