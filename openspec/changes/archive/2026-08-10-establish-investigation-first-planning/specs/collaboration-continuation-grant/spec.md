## ADDED Requirements

### Requirement: Provider Shortage Pauses Without Partial Transition

When policy requires an alternate provider and no eligible alternate is available, the workflow engine SHALL enter a resumable `waiting-for-provider` state. The target transition MUST remain unapplied, and the engine MUST NOT silently reuse the current provider.

Retry, provider selection, and later resume SHALL preserve otherwise-current evidence.

#### Scenario: Required alternate provider is unavailable

- **GIVEN** a transition requires provider-independent assignment and no alternate is available
- **WHEN** assignment is requested
- **THEN** the workflow enters `waiting-for-provider`
- **AND** the target transition is not partially applied
- **AND** the current provider is not silently reused

#### Scenario: Alternate provider later becomes available

- **GIVEN** a transition is waiting and prior evidence remains current
- **WHEN** an eligible provider becomes available and the workflow resumes
- **THEN** it continues from the last durable state
- **AND** current evidence is not recreated solely because of the wait

### Requirement: Collaboration Grants Are Human-Issued and Exactly Bound

A collaboration continuation grant SHALL be distinct from an authority-maintenance grant. It SHALL require an eligible human issuer at the controlling TTY and MUST bind repository, canonical origin, change, optional task, baseline or target, lifecycle phase, conflicting role pair, available provider or caller, degraded form, reason, expiry, and allowed-use count.

An agent MUST NOT issue, sign, approve, or satisfy controlling-TTY requirements for its own collaboration grant.

#### Scenario: Eligible maintainer issues an exact grant

- **GIVEN** a transition is waiting for provider-independent assignment
- **WHEN** an eligible human at the controlling TTY issues a grant for the exact facts
- **THEN** the signed grant records its expiry, one use, role conflict, and degraded form
- **AND** it may be considered only for those facts

#### Scenario: Agent attempts to issue its own grant

- **GIVEN** an agent would benefit from degraded independence
- **WHEN** it attempts issuance without the eligible controlling-TTY human
- **THEN** issuance fails
- **AND** the workflow remains paused

#### Scenario: Grant binding differs from transition

- **GIVEN** a grant binds one repository, change, target, phase, or role pair
- **WHEN** it is presented for different facts
- **THEN** it is rejected

### Requirement: Collaboration Grants Authorize Only Visible Independence Degradation

A grant MAY authorize reuse of the only callable provider in a fresh session for one exact role conflict. It MAY instead authorize a typed caller-supplied or direct-human contribution when no provider adapter is callable and policy permits that exact degraded form.

The actual achieved independence and orchestration MUST be recorded. A grant MUST NOT create a false claim that the engine launched an independent agent, and it MUST NOT bypass the search floor, term contributions, union scan, hit dispositions, WHY ledger, required structured review content, challenge disposition, checks, scope, freshness, or managed transition authority.

#### Scenario: Same provider continues in a fresh session

- **GIVEN** a valid grant authorizes one provider-independence conflict
- **WHEN** the only callable provider runs in a fresh session
- **THEN** the assignment is recorded as degraded and session-independent
- **AND** it is not recorded as provider-independent

#### Scenario: No provider adapter is callable

- **GIVEN** a valid grant authorizes caller-supplied or direct-human contribution for an exact transition
- **WHEN** the structured contribution is admitted
- **THEN** it is recorded with no provider or session independence unless independently established
- **AND** the engine does not claim a provider invocation occurred

#### Scenario: Grant is used to omit required review content

- **GIVEN** plan commit requires a current structured PlanReview
- **AND** a grant authorizes reduced independence
- **WHEN** plan commit is requested without the required review content or eligible direct-human review
- **THEN** plan commit fails
- **AND** the grant does not satisfy review presence by itself

#### Scenario: Grant is used to suppress investigation evidence

- **GIVEN** a grant is valid for one role conflict
- **WHEN** a transition lacks a current scan, disposition, WHY row, or challenge disposition
- **THEN** the transition fails
- **AND** the grant does not suppress the missing assurance

### Requirement: Granted Role Results Have Exact Distinct Content Forms

The workflow SHALL represent ordinary engine-spawned provider results, granted same-provider engine-spawned results, granted caller-supplied typed results, and direct-human signed attestations as a closed discriminated union. Only the two provider forms MAY create or satisfy a provider invocation request. Caller-supplied or direct-human work MUST NOT fabricate an executable identity, provider session, invocation, or unchanged-provider-projection claim.

Every form MUST bind semantic author, participants, actual orchestration, required and achieved independence, exact transition and target, content parent, output schema/evaluator/policy identities, canonical content digest, and any grant/use. A direct-human attestation MUST additionally carry a separate eligible signature bound to the exact transition, target, result/node identity, and content digest.

#### Scenario: Caller-supplied survey is admitted under a grant

- **GIVEN** an exact grant permits caller-supplied survey content because no provider is callable
- **WHEN** the typed result is validated
- **THEN** its structured content may become the survey evidence parent
- **AND** orchestration records caller-supplied with no provider or session independence
- **AND** no provider invocation is recorded

#### Scenario: Direct human reviews an exact plan

- **GIVEN** policy and an exact grant permit direct-human review content
- **WHEN** an eligible human signs the complete bound attestation
- **THEN** the structured PlanReview content may be admitted for that exact target
- **AND** the separate signature, semantic author, transition, target, node/result identity, and content digest remain replayable

#### Scenario: Result form and orchestration conflict

- **GIVEN** a caller-supplied or direct-human result claims an engine-spawned provider invocation
- **WHEN** result admission runs
- **THEN** the result is rejected

### Requirement: Grant Use Is Atomic, Bounded, and Replay-Resistant

The workflow engine SHALL reserve and record a grant use atomically at the exact conflicting transition. Reservation authorizes only an attempt. The use SHALL be consumed only after the exact result form and independently derived semantic content pass the shared pure admission validator and match the reserved transition; invalid content SHALL fail the reservation without publishing successful evidence. Expired, revoked, exhausted, consumed, mismatched, failed, or duplicate uses MUST NOT authorize another transition.

Repeated cleanup or inspection MAY be idempotent, but authorization MUST remain bounded by the signed grant.

#### Scenario: Valid grant use is reserved

- **GIVEN** an unexpired grant has one use for the exact transition
- **WHEN** the conflicting assignment begins
- **THEN** the use is atomically reserved and recorded
- **AND** concurrent transitions cannot claim it

#### Scenario: Grant is replayed after consumption

- **GIVEN** a grant use was consumed
- **WHEN** another transition presents the grant
- **THEN** authorization fails

#### Scenario: Reserved result fails content admission

- **GIVEN** a use is reserved for one exact degraded transition
- **WHEN** the submitted result has invalid structure, content binding, signature, target, orchestration, or achieved independence
- **THEN** no successful role evidence is published
- **AND** the reservation becomes terminally failed rather than consumed as success

#### Scenario: One grant use appears twice in replayed evidence

- **GIVEN** two tracked evidence records claim the same signed grant and use identity
- **WHEN** aggregate use-set validation runs
- **THEN** validation fails even if each record is individually well formed

#### Scenario: Grant expires or is revoked while unused

- **GIVEN** a grant expired or was revoked
- **WHEN** a transition attempts reservation
- **THEN** authorization fails
- **AND** the transition remains paused or requires an eligible provider

### Requirement: Degraded Independence Remains Verifiable Downstream

Every tracked artifact, report, and assurance summary derived from a collaboration-granted transition SHALL identify the signed grant, exact use, admitted result form, actual orchestration, and achieved independence. Plan, task, CI, merge, and archive validation MUST NOT relabel a granted same-provider, caller-supplied, or direct-human result as provider-independent or engine-spawned.

Policy MAY require direct human review for a trust-critical transition even when a grant is otherwise valid.

#### Scenario: Degraded plan reaches CI

- **GIVEN** planning continued under a valid collaboration grant
- **WHEN** local or CI assurance is rendered
- **THEN** the signed grant reference and degraded independence remain visible
- **AND** CI does not upgrade identity, orchestration, or independence claims

#### Scenario: Trust-critical policy requires human review

- **GIVEN** a grant authorizes degraded continuation and policy independently requires direct human review
- **WHEN** eligibility is evaluated without that human review
- **THEN** the transition remains blocked
- **AND** the grant is not treated as a substitute
