## Why

The default branch currently assigns every protected path to `@htchen`, which
GitHub reports as an unknown owner without repository write access. The
repository also requires code-owner approval unconditionally even though its
single eligible maintainer cannot approve their own pull requests, so the
documented policy would deadlock once remote enforcement is activated under
`ISS-003`.

## What Changes

- Replace every invalid `@htchen` CODEOWNER assignment with the verified
  repository administrator `@tomchen86`.
- Require pull requests, the strict `workflow-assurance` check, an up-to-date
  base, and no bypass for protected changes.
- Require code-owner approval with stale-review dismissal only when at least
  two independent eligible human maintainers exist.
- Keep the pinned, credential-free `workflow-assurance` checkout executable in
  the presence of the repository's retained unconfigured `apps/web` gitlink.
- Record this configuration/documentation-only change as exempt from
  RED -> GREEN -> REFACTOR because it changes no application behavior.

## Scope

The governance correction is limited to `.github/CODEOWNERS`,
`docs/ROADMAP.md`, and `docs/WORKFLOW.md`. A pilot-discovered CI bootstrap task
is additionally limited to `.github/workflows/workflow-assurance.yml` and the
registered workflow-engine contract test. Validation uses the repository
workflow plus GitHub's CODEOWNERS diagnostics and remote ruleset state.

## Non-Goals

- Enabling or changing the remote ruleset inside the managed task commit.
- Rewriting historical `/Users/htchen/...` paths in retained legacy material.
- Changing application, API, mobile, web, database, workflow-engine production
  code, or check registry behavior.
- Removing the retained `apps/web` gitlink or inventing a persistent submodule
  URL for it.
- Adding another maintainer or weakening enforcement for multi-maintainer
  repositories.

## Capabilities

### New Capabilities

- `repository-governance`: Defines valid CODEOWNER identity and review
  requirements for solo- and multi-maintainer repository operation.

### Modified Capabilities

None.

## Impact

The repository ownership map, its maintainer-facing governance guidance, and
the workflow-assurance checkout bootstrap change. Product runtime behavior,
dependencies, databases, and workflow engine production code are unaffected.
This directly prepares the disabled `protect-main-workflow-assurance` ruleset
for safe activation under `ISS-003`.
