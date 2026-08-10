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

Every managed change SHALL declare a reviewed project-local schema. The repository SHALL retain legacy `expense-app` only for immutable planning generations proven to predate the first investigation-planning activation anchor and SHALL use `expense-app-v2` for every later planning introduction or revision.

Activation SHALL be derived monotonically from commit ancestry and the configured protected-base lineage. Current file absence MUST NOT erase a reachable activation anchor. A stale branch, marker deletion/rename, missing protected-base context, or ambiguous ancestry MUST NOT make a post-activation candidate eligible for legacy validation.

The v2 apply graph MUST require engine-owned `investigation.json`, authored proposal and delta specs, mixed authored/managed design, tasks, task-only `guard.json`, engine-validated `execution.json`, and exact-target `plan-review.json`. The investigation artifact MUST select exactly one current `sealed-investigation` or eligible structured `investigation-exemption` branch. Repository execution readiness requires tasks, guard, the selected investigation applicability branch, execution, and plan review.

#### Scenario: Investigation-first managed change contains all required artifacts

- **GIVEN** a post-activation change declares `schema: expense-app-v2`
- **AND** its current investigation, proposal, delta specs, design, tasks, guard, execution, and plan review exist
- **WHEN** OpenSpec and repository validation compute readiness
- **THEN** the required planning graph is complete only when every engine-owned artifact also passes its workflow validator

#### Scenario: Eligible investigation exemption is selected

- **GIVEN** a post-activation change declares `expense-app-v2`
- **AND** `investigation.json` selects a current eligible structured exemption
- **WHEN** OpenSpec and repository validation compute readiness
- **THEN** the artifact graph is complete without sealed scan/disposition/WHY nodes
- **AND** exact-plan review and every other v2 gate remain required

#### Scenario: Empty investigation masquerades as exemption

- **GIVEN** a v2 investigation artifact contains empty scan or WHY collections but no eligible typed exemption
- **WHEN** readiness is evaluated
- **THEN** the change is not ready

#### Scenario: Execution-policy artifact is absent

- **GIVEN** a managed change has tasks but no `guard.json`
- **WHEN** readiness is evaluated
- **THEN** the change is not ready for workflow execution

#### Scenario: Investigation-first artifact is absent

- **GIVEN** a v2 change lacks investigation, execution, or plan-review artifact
- **WHEN** readiness is evaluated
- **THEN** the change is not ready for planning transition or execution

#### Scenario: Pre-activation governing plan uses legacy schema

- **GIVEN** an immutable governing plan commit is proven to predate the first activation anchor in its replayed lineage
- **AND** that generation declares the legacy `expense-app` schema
- **WHEN** historical or current replay validates that governing generation
- **THEN** the legacy artifact graph remains valid without pretending it completed investigation-first planning

#### Scenario: Post-activation plan selects legacy schema

- **GIVEN** activation is reachable from the candidate parent or configured protected-base baseline
- **WHEN** the candidate selects `expense-app` or omits v2 artifacts
- **THEN** planning validation fails as a downgrade attempt

#### Scenario: First plan for a new change is introduced after activation

- **GIVEN** no prior plan commit exists for the new change
- **AND** activation is reachable from the candidate parent or configured protected-base baseline
- **WHEN** planning introduction is validated
- **THEN** selection is computed directly from those baselines
- **AND** `expense-app-v2` plus every v2 gate is required

#### Scenario: Marker is deleted after activation

- **GIVEN** the activation anchor remains reachable in applicable history
- **AND** the candidate tree deletes, renames, or omits the marker file
- **WHEN** planning, task, CI, or archive validation runs
- **THEN** validation fails closed
- **AND** legacy schema eligibility is not restored

#### Scenario: Stale pre-activation branch proposes legacy after protected-base activation

- **GIVEN** the candidate parent predates activation
- **AND** the configured protected-base baseline contains the activation anchor
- **WHEN** a planning introduction or revision selects legacy
- **THEN** validation fails as a downgrade attempt

#### Scenario: Schema source is shadowed

- **GIVEN** `spec-driven` does not resolve from the pinned package or either project schema does not resolve from its canonical reviewed path
- **WHEN** schema diagnostics or change validation runs
- **THEN** the operation fails even if a same-named user schema is valid

#### Scenario: Managed change contains all required artifacts

- **GIVEN** a change declares `schema: expense-app`
- **AND** its proposal, delta specs, design, tasks, and `guard.json` exist
- **WHEN** OpenSpec computes artifact readiness
- **THEN** the required planning graph is complete

### Requirement: Combined Change Readiness

The workflow engine SHALL report an investigation-first change ready only when strict OpenSpec validation and repository investigation applicability, the selected sealed-investigation evidence and managed projection when applicable, exact-plan review, task, guard, execution strategy, check, path, metadata, content, and digest validation all succeed against the same planning generation.

Legacy generations SHALL retain their original readiness contract without being upgraded to an investigation claim.

#### Scenario: Valid delta has unsafe guard policy

- **GIVEN** OpenSpec accepts a change's delta specifications
- **AND** its guard contains an unknown check, missing task, or unsafe path
- **WHEN** workflow change validation runs
- **THEN** validation fails
- **AND** no task session can start

#### Scenario: OpenSpec reports an engine-owned artifact as done

- **GIVEN** OpenSpec readiness reports an investigation, execution, or plan-review artifact exists
- **AND** repository validation finds it malformed, unbound, stale, incomplete, or manually divergent
- **WHEN** workflow change validation runs
- **THEN** validation fails despite OpenSpec status

#### Scenario: OpenSpec reports an authored artifact as done

- **GIVEN** OpenSpec readiness reports an authored artifact exists
- **AND** repository semantic validation finds it empty or malformed
- **WHEN** workflow change validation runs
- **THEN** validation fails despite OpenSpec status

#### Scenario: Planning artifacts drift after validation

- **GIVEN** a planning generation previously passed combined validation
- **WHEN** any semantic tracked change, schema, workflow policy, investigation dependency, role requirement, or check-registry input changes
- **THEN** dependent validation and review become stale
- **AND** the workflow requires current evidence for the resulting generation

#### Scenario: OpenSpec reports an empty artifact as done

- **GIVEN** OpenSpec readiness reports an artifact exists
- **AND** repository semantic validation finds it empty or malformed
- **WHEN** workflow change validation runs
- **THEN** validation fails despite the OpenSpec status

### Requirement: Authorized Planning Transition

Except for named historical bootstraps, a planning introduction or revision SHALL be commit-authorized only by a current workflow plan-transition report whose exact diff is confined to the named change's permitted schema-specific planning paths.

An investigation-first transition MUST also have a current sealed investigation or eligible structured investigation exemption, the exact managed design projection when applicable, valid execution strategies, immutable planning generation, current exact-target PlanReview, achieved required role separation or an eligible signed degraded result whose exact content admission and use validate, and current dispositions for every challenge. Grant presence alone and the advisory verdict itself MUST NOT be commit authority.

#### Scenario: New investigation-first planning baseline is authorized

- **GIVEN** a v2 change passes combined validation and exact-plan review
- **AND** all newly introduced task checkboxes are unchecked
- **WHEN** the planning transition is requested
- **THEN** only its authorized planning paths are staged
- **AND** the commit uses `Change: <change-id>` and `Transition: plan`
- **AND** the planning report binds the exact planning generation

#### Scenario: Advisory verdict rejects an otherwise dispositioned plan

- **GIVEN** a current exact-target PlanReview has an advisory rejection verdict
- **AND** every structured challenge has a valid current disposition
- **WHEN** planning authorization runs
- **THEN** the verdict alone does not grant or deny commit authority
- **AND** all executable planning gates still apply

#### Scenario: Planning transition contains non-planning mutation

- **GIVEN** a proposed planning transition changes implementation code, base specs, archives, task checkbox state outside an authorized projection, or another change
- **WHEN** planning authorization runs
- **THEN** the transition is rejected without staging or committing

#### Scenario: Planning revision occurs after execution begins

- **GIVEN** implementation evidence exists for a change
- **WHEN** an authorized planning revision changes the contract
- **THEN** the revision requires no active task session under the current lifecycle
- **AND** dependent task evidence is invalidated before another task can rely on the changed contract

#### Scenario: New planning baseline is authorized

- **GIVEN** a new OpenSpec change passes combined validation
- **AND** all of its task checkboxes are unchecked
- **WHEN** the planning transition is requested
- **THEN** only its authorized planning paths are staged
- **AND** the commit uses `Change: <change-id>` and `Transition: plan`

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

### Requirement: Governing Planning Generation Is Resolved From Managed Git History

Task start, CI, and archive replay SHALL resolve a change's effective planning generation from its latest reachable managed plan transition and SHALL reconstruct that immutable plan's schema-selection parent, component manifest, and planning-generation ID.

They MUST NOT infer the governing generation from a branch name, current working-tree prose, or engine-owned completion checkbox bytes.

#### Scenario: Task checkboxes change after plan commit

- **GIVEN** a managed task completion changes only authorized checkbox projections
- **WHEN** a later task or CI resolves the governing plan
- **THEN** it resolves the immutable managed plan commit and unchanged authored task contract
- **AND** checkbox projection changes do not create a new planning generation

#### Scenario: A later plan revision exists

- **GIVEN** a reachable newer managed plan commit supersedes an older generation
- **WHEN** task start resolves planning authority
- **THEN** it selects and pins the newer generation
- **AND** stale review for the older generation cannot authorize the task

### Requirement: Engine-Owned Planning Artifacts Cannot Be Prompt-Authored Authority

OpenSpec MAY represent investigation, execution, and plan-review files in its artifact graph, but only workflow transitions SHALL create or authorize their objective fields, digests, current refs, managed projections, and review bindings.

Prompt-authored or manually edited engine fields MUST fail repository validation even when OpenSpec reports the file present.

#### Scenario: User invokes artifact instructions for an engine-owned artifact

- **WHEN** an engine-owned v2 artifact becomes ready in the OpenSpec graph
- **THEN** its reviewed instruction routes creation through `workflow propose`
- **AND** free-form authored content cannot satisfy workflow validation

#### Scenario: Engine-owned JSON is edited after projection

- **GIVEN** an investigation, execution, or plan-review projection was current
- **WHEN** its objective binding or managed bytes are edited outside the engine transition
- **THEN** combined validation fails

