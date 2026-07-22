# openspec-workflow-integration Specification

## Purpose
TBD - created by archiving change integrate-openspec-with-workflow. Update Purpose after archive.
## Requirements
### Requirement: Exact Project-Local OpenSpec Surface

The repository SHALL execute every managed OpenSpec planning operation through
the exact project-local version declared in the root manifest, with no fallback
to a global, floating, vendored, or user-selected OpenSpec source. Its optional
postinstall script MUST remain denied by repository supply-chain policy.

#### Scenario: Pinned planning command runs

- **GIVEN** the manifest, lockfile, build policy, and installed package resolve
  to the same exact version
- **WHEN** a managed planning or validation operation runs
- **THEN** it uses that project-local CLI without running the optional
  postinstall
- **AND** it reports the canonical repository as its planning root

#### Scenario: OpenSpec resolution drifts

- **GIVEN** the installed version, resolved schema source, build policy, or
  returned planning root differs from repository policy
- **WHEN** a managed OpenSpec operation is requested
- **THEN** the operation fails before creating a session or mutating Git state

### Requirement: Typed and Isolated OpenSpec Adapter

Every workflow-owned OpenSpec subprocess SHALL use an operation-specific argv
contract, isolated machine state, bounded execution, and validated JSON output.
The adapter MUST NOT expose a generic command pass-through.

#### Scenario: Machine response matches its operation contract

- **GIVEN** the pinned CLI returns one valid JSON document with the expected
  payload, root, paths, version, exit status, and allowlisted diagnostics
- **WHEN** the typed adapter processes the operation
- **THEN** it returns validated typed data to the workflow consumer

#### Scenario: Machine response is ambiguous or unsafe

- **GIVEN** the process times out, exceeds its output limit, returns mixed
  prose/JSON, unexpected stderr, a malformed payload, or an external root/path
- **WHEN** the typed adapter processes the operation
- **THEN** it fails closed without accepting partial output or mutating Git

### Requirement: Project-Local Managed Change Schema

Every managed change SHALL declare the project-local `expense-app` schema,
whose apply graph requires a repository execution-policy artifact after its task
artifact.

#### Scenario: Managed change contains all required artifacts

- **GIVEN** a change declares `schema: expense-app`
- **AND** its proposal, delta specs, design, tasks, and `guard.json` exist
- **WHEN** OpenSpec computes artifact readiness
- **THEN** the required planning graph is complete

#### Scenario: Execution-policy artifact is absent

- **GIVEN** a managed change has tasks but no `guard.json`
- **WHEN** readiness is evaluated
- **THEN** the change is not ready for workflow execution

#### Scenario: Schema source is shadowed

- **GIVEN** `spec-driven` does not resolve from the pinned package or
  `expense-app` does not resolve from the canonical project path
- **WHEN** schema diagnostics or change validation runs
- **THEN** the operation fails even if a same-named user schema is valid

### Requirement: Combined Change Readiness

The workflow engine SHALL report a change ready only when strict OpenSpec
validation and repository task, guard, check, path, metadata, content, and
digest validation all succeed against the same change tree.

#### Scenario: Valid delta has unsafe guard policy

- **GIVEN** OpenSpec accepts a change's delta specifications
- **AND** its guard contains an unknown check, missing task, or unsafe path
- **WHEN** workflow change validation runs
- **THEN** validation fails
- **AND** no task session can start

#### Scenario: OpenSpec reports an empty artifact as done

- **GIVEN** OpenSpec readiness reports an artifact exists
- **AND** repository semantic validation finds it empty or malformed
- **WHEN** workflow change validation runs
- **THEN** validation fails despite the OpenSpec status

#### Scenario: Planning artifacts drift after validation

- **GIVEN** a change previously passed combined validation
- **WHEN** any tracked change, schema, workflow-policy, or check-registry input
  changes
- **THEN** the prior validation result is stale
- **AND** the workflow requires a new validation result

### Requirement: Authorized Planning Transition

Except for the named integration bootstrap, a planning introduction or revision
SHALL be commit-authorized only by a current workflow plan-transition report
whose exact diff is confined to the named change's permitted planning paths.

#### Scenario: New planning baseline is authorized

- **GIVEN** a new OpenSpec change passes combined validation
- **AND** all of its task checkboxes are unchecked
- **WHEN** the planning transition is requested
- **THEN** only its authorized planning paths are staged
- **AND** the commit uses `Change: <change-id>` and `Transition: plan`

#### Scenario: Planning transition contains non-planning mutation

- **GIVEN** a proposed planning transition changes implementation code, base
  specs, archives, task checkbox state, or another change
- **WHEN** planning authorization runs
- **THEN** the transition is rejected without staging or committing

#### Scenario: Planning revision occurs after execution begins

- **GIVEN** implementation evidence exists for a change
- **WHEN** an authorized planning revision changes the contract
- **THEN** the revision requires no active session
- **AND** prior task evidence is invalidated before another task can start

### Requirement: Single Integration Bootstrap Exception

The assurance verifier SHALL treat only the first exact
`integrate-openspec-with-workflow` dependency-and-planning baseline as valid
without a planning report.

#### Scenario: Exact bootstrap baseline is inspected

- **GIVEN** the transition has `Change: integrate-openspec-with-workflow` and
  `Transition: plan`
- **AND** its diff contains only the exact OpenSpec dependency pin, lockfile
  resolution, denied optional build script, and unchecked named planning tree
- **WHEN** bootstrap verification runs
- **THEN** the baseline is accepted without a planning report

#### Scenario: Bootstrap exception is widened or replayed

- **GIVEN** a candidate changes another dependency, script, workspace policy,
  code path, base spec, archive, document, or checkbox
- **OR** the named exception has already been consumed
- **WHEN** bootstrap verification runs
- **THEN** the candidate is rejected

### Requirement: Workflow-Owned Archive Authorization

The repository SHALL authorize an OpenSpec archive only through a current
workflow archive transition after completion, reachability, session, worktree,
artifact, and lock preconditions pass.

#### Scenario: Completed change is eligible for archive

- **GIVEN** every task has current workflow completion evidence
- **AND** its task commits are reachable from the configured base
- **AND** no session, drift, dirty target, destination collision, or conflicting
  archive lock exists
- **WHEN** workflow archive is requested
- **THEN** the archive transformation may proceed

#### Scenario: Raw archive diff lacks workflow evidence

- **GIVEN** an archive-shaped diff was produced outside the workflow transition
- **WHEN** commit or CI verification runs
- **THEN** the diff is rejected even if OpenSpec considers the archive valid

### Requirement: Isolated Archive Transformation

An authorized archive SHALL mutate only a detached temporary worktree until an
exact OpenSpec result and path-constrained patch have been validated for
application to the real worktree.

#### Scenario: Archive transformation succeeds

- **GIVEN** archive preconditions pass
- **WHEN** the pinned OpenSpec archive mechanism completes in the temporary
  worktree
- **THEN** the verified result contains only the active-change removal, one
  exact dated archive addition, and permitted base-spec promotions
- **AND** only the verified patch is offered to archive staging

#### Scenario: Temporary archive fails after partial mutation

- **GIVEN** OpenSpec writes a partial result, times out, encounters a collision,
  or fails while moving files in the temporary worktree
- **WHEN** archive execution terminates
- **THEN** the real worktree and index remain unchanged
- **AND** no archive transition is authorized

#### Scenario: Archive patch escapes its permitted targets

- **GIVEN** the temporary result contains an unexpected, external, symlinked,
  silently ignored, or digest-mismatched path or delta
- **WHEN** archive verification runs
- **THEN** the patch is rejected before real-worktree mutation

### Requirement: Stable Archive Identity

Archive verification SHALL bind the logical change identity to archived-tree
and promoted-spec digests while normalizing only the valid UTC date prefix
generated by OpenSpec.

#### Scenario: CI replays archive on a later UTC date

- **GIVEN** CI reproduces the same logical archive and content on a different
  UTC date
- **WHEN** it compares the proposed archive with the replay
- **THEN** one valid date prefix is normalized
- **AND** the change suffix and content digests still match exactly

#### Scenario: Verified archive is requested again

- **GIVEN** exactly one previously verified archive matches the logical change
  and content identity
- **WHEN** workflow archive is requested again
- **THEN** it reports an already-archived result without mutation

### Requirement: Recomputed Transition Assurance

Managed task, plan, and archive commits SHALL use mutually exclusive
trailer-and-evidence contracts whose exact changed paths and current validity
are recomputed from Git by CI.

#### Scenario: Local hook is bypassed

- **GIVEN** a commit reaches CI without local workflow verification
- **WHEN** CI recomputes its transition kind, trailers, changed paths, and
  required evidence
- **THEN** an invalid task, plan, or archive transition is rejected

#### Scenario: Commit mixes transition forms

- **GIVEN** a commit contains both a `Task:` trailer and a `Transition:` trailer
- **OR** its evidence kind does not match its diff
- **WHEN** managed-commit verification runs
- **THEN** the commit is rejected

### Requirement: Workflow Test Entrypoint Portability

The workflow test entrypoints MUST resolve repository fixtures and source paths
independently of the caller's current working directory.

#### Scenario: Root workflow tests run

- **WHEN** the repository-owned workflow test command runs from the repository
  root
- **THEN** all configured workflow tests resolve the canonical repository files

#### Scenario: Package-filtered workflow tests run

- **WHEN** the workflow package test command runs with the package directory as
  its current working directory
- **THEN** it resolves the same repository fixtures and source modules
- **AND** it produces the same passing test set as the root command

### Requirement: OpenSpec Change Root Compatibility

The workflow MUST distinguish active change directories from OpenSpec's
reserved archive container and MUST NOT parse the container itself as a change.

#### Scenario: Empty archive container exists

- **GIVEN** OpenSpec has created `openspec/changes/archive/` with no archived
  changes
- **WHEN** the workflow enumerates active changes for validation or handoff
- **THEN** it ignores the reserved container
- **AND** it continues to select only valid active change directories

#### Scenario: Archived changes exist

- **GIVEN** dated change directories exist under `openspec/changes/archive/`
- **WHEN** the workflow enumerates active changes
- **THEN** neither the archive container nor its children are treated as active

### Requirement: Planning-Only OpenSpec Asset Interface

Repository-delivered OpenSpec assets SHALL expose only exploration and proposal behavior across Codex, Claude Code, `.agents`, and reviewed Codex prompt targets, and MUST hand implementation authority to the repository workflow. Asset validity MUST be established by the versioned asset contract rather than by a formatting check.

#### Scenario: Tool-plural planning assets are regenerated

- **GIVEN** a clean temporary project and isolated home, XDG, Codex, and temporary directories
- **WHEN** the pinned generator selects Codex and Claude with the reviewed custom workflow allowlist
- **THEN** one upstream run produces the expected Codex and Claude source closures
- **AND** the repository receives only reviewed explore and propose skills, `.agents` mirrors, and Codex prompts
- **AND** no real user Codex or Claude state is modified

#### Scenario: Claude commands or lifecycle skills are generated upstream

- **WHEN** the isolated upstream run emits its expected Claude command files or any source outside the reviewed closures
- **THEN** expected Claude commands are discarded rather than delivered
- **AND** any unexpected source causes generation to fail before repository files are written

#### Scenario: Asset stages are validated

- **WHEN** generated-asset verification runs
- **THEN** it verifies exact generator policy plus raw-source, reviewed-overlay, and delivered-final digests for every target
- **AND** it verifies canonical paths, exact target closure, mirror equality, and final reviewed content

#### Scenario: Asset check runs without the formatter

- **WHEN** the registered OpenSpec asset check validates a generated repository tree
- **THEN** it succeeds without resolving or invoking Prettier
- **AND** it does not rewrite the manifest or any delivered file

#### Scenario: Manifest or delivery state is missing or drifted

- **WHEN** the manifest is missing, renamed, malformed, stale, or inconsistent with any required target, digest, path, mirror, or closure
- **THEN** hook validation and pull-request regeneration fail closed

#### Scenario: Generated asset exposes forbidden authority

- **GIVEN** any delivered asset invokes OpenSpec apply, update, sync, archive, bulk-archive, or store behavior, whether bare or executable-prefixed
- **OR** it invokes an external store, Spectra, an unreviewed slash command, a tool-wide OpenSpec permission, or an incompatible tool primitive
- **WHEN** generated-asset verification runs
- **THEN** verification fails for that delivery target
- **AND** the asset cannot satisfy repository CI

#### Scenario: Generated final is formatted after delivery

- **WHEN** any tool rewrites a delivered generated file after generation
- **THEN** its final-byte digest no longer matches the reviewed manifest
- **AND** the read-only asset check fails rather than accepting or repairing it

