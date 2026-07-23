## Why

Git legitimately reports an ignored nested repository as a directory record such as `memo/`, but the workflow engine currently sends that transport-level marker directly to the strict repository-path normalizer and cannot fingerprint or validate the worktree. This small prerequisite unblocks the [repository workflow adoption](../../../docs/ROADMAP.md#finish-repository-workflow-adoption) plan without moving maintainer-local Git metadata or weakening the shared path contract.

## What Changes

- Decode one trailing Git directory marker only at the ignored-path adapter boundary, then pass the resulting path through the existing strict `normalizeChangedPath` validation.
- Add RED-first coverage proving that an ignored nested repository can be fingerprinted and validated, while direct `normalizeChangedPath('memo/')` input remains invalid.
- Prove that removing or renaming the ignored nested directory changes the working-state fingerprint so the adapter does not hide repository state.
- Keep the change scoped to ignored Git records, workflow-engine tests, and the corresponding workflow-assurance requirement.
- Non-goals: changing `/memo/` ignore policy, accepting trailing slashes globally, moving or editing `memo/.git`, recursively fingerprinting a nested repository's private contents, or changing unrelated Git path adapters.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-assurance`: Require canonical, fail-closed handling of Git's ignored-directory records while preserving ignored-directory identity in working-state fingerprints.

## Impact

- Affected code: `packages/workflow-engine/src/git.ts`.
- Affected tests: workflow-engine path-contract and ignored-state integration coverage.
- Affected planning contract: `openspec/specs/workflow-assurance/spec.md` through this change's delta specification.
- No API, mobile, database, dependency, `.gitignore`, or maintainer-local `memo/` changes.
