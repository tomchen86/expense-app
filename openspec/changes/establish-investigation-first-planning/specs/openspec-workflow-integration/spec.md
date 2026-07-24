## MODIFIED Requirements

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

## ADDED Requirements

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
