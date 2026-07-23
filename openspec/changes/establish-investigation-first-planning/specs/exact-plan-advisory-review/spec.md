## ADDED Requirements

### Requirement: Plan Review Binds an Exact Component-Typed Planning Generation

Before plan commit, the workflow engine SHALL assign the complete reviewed planning set an immutable planning generation and SHALL construct a component-typed review target.

The target MUST include applicable schema metadata, proposal, design, delta specifications, tasks, guard, execution strategy, investigation and WHY dependencies, requirement clauses, and relevant policies. It MUST exclude the review artifact itself and runtime-only invocation metadata.

Engine-owned structured components SHALL use versioned semantic canonicalization. Agent-authored Markdown SHALL use exact normalized-byte identity. Mixed documents MUST bind authored regions separately from engine-owned projections. General prose, whitespace, or model-based semantic equivalence MUST NOT be used.

#### Scenario: Authored planning prose changes

- **GIVEN** review is current for one authored Markdown region
- **WHEN** punctuation, spacing, negation, or another non-enumerated authored byte changes
- **THEN** the planning target changes
- **AND** the prior review becomes stale

#### Scenario: Structured key order changes without semantic change

- **GIVEN** an engine-owned component uses unchanged schema, canonicalizer, renderer, and policy versions
- **WHEN** only non-semantic key representation order changes
- **THEN** its canonical subject remains unchanged

#### Scenario: Task completion changes only checkbox projection

- **GIVEN** a planning generation contains unchanged task IDs, text, order, and headings
- **WHEN** managed completion changes only engine-owned checkbox bytes
- **THEN** the planning generation remains unchanged

#### Scenario: Canonicalization policy changes

- **GIVEN** review is current
- **WHEN** applicable schema, canonicalizer, renderer, or review-policy identity changes
- **THEN** the review becomes stale even if rendered bytes happen to match

### Requirement: PlanReview Currentness Follows the Governing Planning Generation

A PlanReview SHALL bind immutable planning generation, exact plan target, investigation baseline and dependencies, review policy, and required independence.

Task start and CI MUST resolve the governing plan from immutable managed Git history rather than infer it from mutable working-tree task projections. Ordinary authorized implementation descendants MUST NOT stale PlanReview. Changed or superseding planning content, investigation dependencies, reviewed contract, canonicalization policy, review policy, or required independence MUST stale it.

#### Scenario: Implementation begins under an unchanged plan

- **GIVEN** PlanReview is current for the effective planning generation
- **WHEN** an authorized task changes implementation or test paths
- **THEN** PlanReview remains current for that generation
- **AND** the new implementation bytes require their own later assurance

#### Scenario: New planning generation supersedes the reviewed plan

- **GIVEN** PlanReview is current for one generation
- **WHEN** a newer managed planning generation becomes effective
- **THEN** the old PlanReview is not current for the newer generation

#### Scenario: Reviewer invocation tree mutated during review

- **GIVEN** a reviewer was invoked against one observed repository projection
- **WHEN** governed fingerprints differ before and after invocation
- **THEN** the produced report is unusable
- **AND** later implementation currentness rules cannot rehabilitate it

### Requirement: Plan Review Performs the Evidence-Bound Scope and Depth Challenge

The exact-plan reviewer SHALL examine the complete plan and investigation subject for missing scope, missing consumers, weak WHY explanations, unsupported invariants, contradictory artifacts, task-strategy risks, and additional search terms.

Every scope challenge, including a structured no-challenge conclusion, MUST cite at least one independent survey record, investigation evidence node, or reviewer-observed repository `file:line`. A bare no-challenge attestation MUST fail. The workflow MUST NOT launch a separate duplicate scope/depth reviewer over the same canonical subject.

#### Scenario: Reviewer identifies missing scope

- **GIVEN** the reviewer observes an additional relevant consumer
- **WHEN** it returns a scope challenge
- **THEN** the challenge identifies supporting graph or repository evidence
- **AND** it requires disposition before plan commit

#### Scenario: Reviewer finds no additional scope

- **GIVEN** the reviewer concludes no additional scope was found
- **WHEN** it returns the no-challenge result
- **THEN** the result is structured and cites independent evidence
- **AND** a bare `none found` result is rejected

#### Scenario: Plan review already includes scope and depth challenge

- **GIVEN** exact-plan review is required for one canonical subject
- **WHEN** review is scheduled
- **THEN** scope and depth challenge are included in that invocation
- **AND** no second call is made solely to repeat them

### Requirement: Review Presence Is Hard and Verdict Is Advisory

Plan commit SHALL require a current immutable PlanReview bound to the exact planning generation, the required role separation or eligible degraded path, and a disposition for every structured challenge.

The workflow engine MUST NOT require the AI verdict to be `approve`. An advisory verdict MUST NOT replace validation, registered checks, Git facts, transition authority, or human merge authority. Suggestions SHALL remain visible without blocking unless policy or a human promotes them to challenges.

#### Scenario: Review artifact is absent

- **GIVEN** a planning generation has no current eligible PlanReview
- **WHEN** plan commit is requested
- **THEN** the transition fails

#### Scenario: Reviewer rejects but challenges are dispositioned

- **GIVEN** a current PlanReview has an advisory rejection verdict
- **AND** every challenge has an allowed disposition and rationale
- **WHEN** plan-commit eligibility is evaluated
- **THEN** the verdict alone does not block the transition

#### Scenario: Challenge is undispositioned

- **GIVEN** a current PlanReview contains one challenge with no current disposition
- **WHEN** plan commit is requested
- **THEN** the transition fails regardless of advisory verdict

### Requirement: Reviewer Terms Enter Only the Fixed Term Projector

`PlanReview.proposedTerms` SHALL be the only V1 review field that can mechanically introduce investigation work.

The workflow engine SHALL validate, normalize, deduplicate, preview, and either seal or request narrowing for those terms directly from the immutable review report. It MUST NOT require main-agent transcription and MUST NOT admit other semantic proposal kinds through a generic admission mechanism.

#### Scenario: Reviewer proposes a bounded term

- **GIVEN** a current PlanReview proposes a valid bounded term
- **WHEN** the review result is processed
- **THEN** the term enters the fixed preview/scan pipeline directly from the review
- **AND** affected dependencies are recomputed before plan commit

#### Scenario: Reviewer proposes an over-broad term

- **GIVEN** a reviewer term exceeds an aggregate or per-term resource bound
- **WHEN** the projector evaluates it
- **THEN** it remains unsealed or requests narrowing
- **AND** it does not create unbounded work

#### Scenario: Review proposes an unsupported semantic action

- **GIVEN** a review asks an unsupported proposal kind to mutate scope, dependencies, issues, or policy
- **WHEN** mechanical projection is requested
- **THEN** projection is rejected
- **AND** the engine does not create a generic semantic admission path

### Requirement: Review Findings Preserve Current-Change and Follow-Up Boundaries

A finding required for current-change correctness SHALL be a challenge and SHALL require disposition. A finding independent of current correctness MAY be retained as a deduplicated non-blocking intake candidate.

An AI review MUST NOT directly create, prioritize, update, or close a repository issue.

#### Scenario: Finding is required for current correctness

- **GIVEN** a finding identifies missing work required for the current change to be correct
- **WHEN** it is classified
- **THEN** it becomes a challenge
- **AND** plan commit remains blocked until disposition

#### Scenario: Finding is an independent follow-up

- **GIVEN** a valid finding is independent of current-change correctness
- **WHEN** it is classified
- **THEN** it may become a deduplicated non-blocking intake candidate
- **AND** no issue is created or prioritized automatically
