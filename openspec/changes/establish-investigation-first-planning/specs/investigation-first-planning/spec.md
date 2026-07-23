## ADDED Requirements

### Requirement: Sealed Investigation Gates Authoritative Planning

The workflow engine SHALL bind each investigation to a structured change intent and pinned repository baseline. It MUST NOT authorize or materialize the authoritative design or planning transition until the current investigation is sealed.

Non-authoritative scratch material MUST NOT be adopted automatically as authoritative planning input.

#### Scenario: Design is requested before investigation seal

- **GIVEN** a change has no current sealed investigation
- **WHEN** authoritative design materialization is requested
- **THEN** the operation fails without authorizing a design or planning transition
- **AND** any scratch or unmanaged design remains non-authoritative and unmodified

#### Scenario: Investigation inputs drift after sealing

- **GIVEN** an investigation was sealed for one intent and repository baseline
- **WHEN** the material intent or pinned baseline changes
- **THEN** the prior investigation becomes stale
- **AND** planning remains blocked until the changed investigation is sealed

#### Scenario: Pre-cutover plan is migrated

- **GIVEN** an immutable legacy planning generation predates investigation-first activation
- **WHEN** its eligible managed migration runs
- **THEN** the migration records that investigation did not precede the legacy plan's cognition
- **AND** the resulting planning revision MUST satisfy every current investigation and review gate

### Requirement: Investigation Uses Three Term Sources With a Blind Independent Pass

The workflow engine SHALL derive a non-removable engine search floor, accept a typed main-agent term contribution, and on the ordinary path obtain a provider-independent blind survey contribution before sealing the effective term union. The survey provider MUST differ from the investigation author's provider; only an eligible exact collaboration grant may replace that ordinary contribution with a visibly degraded alternative.

The floor SHALL deterministically include every valid term derivable from available machine-readable facts: explicit paths, symbols, and configuration keys in normalized intent; both old and new identifiers for rename, removal, or transformation intent; renamed or removed path basenames and stems available from a pinned diff; and reviewed generated or mirror counterparts of a derived subject. Every floor term SHALL retain the source fact and derivation rule. If any qualifying fact exists, the engine MUST NOT emit an empty or incomplete floor.

If no qualifying fact exists, the engine SHALL record a typed `noDerivableFloorFacts` result naming every checked category. That result MUST NOT be represented as a breadth contribution, and sealing SHALL still require non-empty main and ordinary provider-independent survey term contributions.

The blind request MUST contain the normalized intent, pinned repository baseline, read-only repository access, and a structured architecture-level survey question. It MUST be sealed before the engine reads the main contribution and MUST NOT contain the engine floor, main-agent terms, prior hit lists, or prior conclusions.

#### Scenario: Blind survey input is constructed

- **GIVEN** a normalized intent and pinned baseline
- **WHEN** the blind survey manifest is sealed
- **THEN** it contains the intent, baseline, read-only capability, and survey schema
- **AND** it does not contain the engine floor, main terms, prior hits, or prior conclusions

#### Scenario: Effective term union is sealed

- **GIVEN** current engine, main-agent, and blind-survey contributions
- **WHEN** the investigation term union is sealed
- **THEN** every accepted term from each source appears in the effective union
- **AND** every term retains all source provenance

#### Scenario: Qualifying floor facts exist

- **GIVEN** normalized intent or pinned diff contains an explicit path, symbol, configuration key, rename/removal identifier, or reviewed generated/mirror counterpart
- **WHEN** the engine derives the search floor
- **THEN** every qualifying fact maps to its required typed term with provenance
- **AND** an empty or incomplete floor fails validation

#### Scenario: No floor fact is derivable

- **GIVEN** every reviewed machine-readable derivation category is empty
- **WHEN** the engine derives the search floor
- **THEN** it records `noDerivableFloorFacts` with the checked categories
- **AND** investigation cannot seal without non-empty main and ordinary provider-independent survey contributions

#### Scenario: Independent provider is unavailable under an eligible grant

- **GIVEN** the workflow has paused because no alternate provider can perform the blind pass
- **WHEN** an exact human continuation grant authorizes a degraded survey contribution
- **THEN** the degraded contribution replaces rather than satisfies the ordinary provider-independent blind contribution
- **AND** its actual independence level remains explicit
- **AND** the engine does not describe the degraded contribution as blind or provider-independent when it was not

### Requirement: Search Terms Have a Bounded Governed Lifecycle

The workflow engine SHALL accept only fixed typed term kinds with deterministic matching semantics. It SHALL normalize and deduplicate terms and MUST preview per-term and aggregate resource cost before sealing them.

An engine-floor term MUST NOT be removed or superseded by an agent. An agent-contributed term MAY leave the effective set only through an explicit, reasoned, audit-visible investigation revision.

#### Scenario: Proposed term exceeds a resource bound

- **GIVEN** a term exceeds an applicable term, hit, classification-work, time, compute, or scanned-byte bound
- **WHEN** term sealing is requested
- **THEN** the term remains unsealed
- **AND** the result requires rejection or a narrower proposal without creating unbounded work

#### Scenario: Agent attempts to remove an engine-floor term

- **GIVEN** an engine-floor term is effective
- **WHEN** an agent contribution or revision attempts to remove it
- **THEN** the operation fails
- **AND** the engine-floor term remains effective

#### Scenario: Agent term is superseded through revision

- **GIVEN** an agent-contributed term is mistaken or operationally unusable
- **WHEN** an authorized revision supplies a reasoned supersession
- **THEN** the term may leave the effective set
- **AND** its original value, provenance, and supersession reason remain auditable

### Requirement: Every Sealed Term Is Scanned Across the Governed Tracked Tree

The workflow engine SHALL deterministically scan every effective sealed term against the pinned Git-tracked tree. The scan SHALL include tracked paths and text blobs across source, tests, documentation, configuration, hooks, mirrors, generated contracts, and every governed mutation class.

The scan MUST NOT use task `allowedPaths` as a breadth boundary and MUST NOT read untracked files, ignored files, repository-external paths, environment files, or credentials. Every effective sealed term MUST have a current scan result before investigation can be sealed.

#### Scenario: Relevant hit is outside planned task paths

- **GIVEN** a sealed term matches a tracked file outside planned task paths
- **WHEN** the governed scan runs
- **THEN** the hit is recorded
- **AND** task `allowedPaths` do not hide it

#### Scenario: Untracked or ignored file contains a term

- **GIVEN** a sealed term occurs only in an untracked or ignored file
- **WHEN** the governed scan runs
- **THEN** that file content is not read or reported as a tracked-tree hit

#### Scenario: Sealed term has no current scan

- **GIVEN** an effective sealed term lacks a scan bound to the current tree and scan policy
- **WHEN** investigation sealing is requested
- **THEN** sealing fails

#### Scenario: Sealed term has zero hits

- **GIVEN** a sealed term was scanned against the complete governed tracked tree and has no hits
- **WHEN** currentness is evaluated
- **THEN** the zero-hit scan is accepted as a current result

#### Scenario: Blob cannot be scanned as governed text

- **GIVEN** a tracked object is binary, invalid UTF-8, oversized, or otherwise unsupported by the governed text policy
- **WHEN** the scanner encounters it
- **THEN** the scanner records the exact object and skip reason
- **AND** it does not silently claim that the object's content was scanned

### Requirement: Propose Is a Durable Resumable Planning Wrapper

The routine `workflow propose` surface SHALL persist investigation state, start the blind work before main-agent semantic input is consumed, emit typed caller work envelopes, and resume from the last durable checkpoint. It MUST NOT require one long-lived process or an interactive TTY questionnaire for routine agent input.

The wrapper SHALL assemble existing planning and plan-commit prerequisites without replacing their authority or exposing a separate routine review journey.

#### Scenario: Caller must provide main terms

- **GIVEN** an investigation has started and its blind request is sealed
- **WHEN** the wrapper needs the caller's term contribution
- **THEN** it returns an `awaiting-main-terms` state and a typed input schema
- **AND** the blind provider work may proceed independently

#### Scenario: Process exits while provider work is pending

- **GIVEN** a durable investigation has pending provider work
- **WHEN** the initiating CLI process exits or is interrupted
- **THEN** status and resume preserve every current completed node
- **AND** the caller is not required to restart investigation from the beginning

#### Scenario: Planning prerequisites become current

- **GIVEN** investigation, planning materialization, PlanReview, and challenge dispositions are current
- **WHEN** the propose wrapper reaches its terminal planning step
- **THEN** it invokes the existing managed plan transition
- **AND** it does not hand-author a commit or bypass plan-transition validation
