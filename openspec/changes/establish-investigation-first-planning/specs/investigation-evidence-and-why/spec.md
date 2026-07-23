## ADDED Requirements

### Requirement: Every Investigation Hit Has Exactly One Effective Disposition

The workflow engine SHALL organize current search hits into semantic evidence groups and SHALL require every current hit to be covered by exactly one effective disposition.

Each disposition MUST identify its covered hits, complete source blobs, classification, rationale, selector evidence, and explicit exceptions. Ambiguous, missing, or overlapping effective coverage MUST fail closed.

#### Scenario: One group covers related hits

- **GIVEN** several current hits belong to one reviewed semantic evidence group
- **WHEN** the group receives an effective disposition
- **THEN** each hit is covered through that group without a duplicate semantic answer
- **AND** the group records the exact covered hit identities

#### Scenario: One hit has overlapping dispositions

- **GIVEN** a current hit is covered by more than one effective disposition
- **WHEN** coverage is validated
- **THEN** validation fails
- **AND** investigation cannot be sealed

#### Scenario: One hit has no disposition

- **GIVEN** a current hit has no effective disposition
- **WHEN** coverage is validated
- **THEN** validation fails
- **AND** investigation cannot be sealed

### Requirement: Load-Bearing Evidence Requires a Full-Blob WHY Ledger

For every file represented by a load-bearing evidence group, the workflow engine SHALL require a ledger row bound to the complete pinned source blob.

The row MUST identify path, blob digest and size, relevant element or location, covered hits, relationship to the change, WHY explanation, protected invariant, sharp reviewer question, answer, and semantic-author provenance. The complete pinned file MUST be available to the assigned actor when semantic fields are produced.

#### Scenario: Load-bearing row is complete and current

- **GIVEN** a load-bearing file has every required field and is bound to the current complete source blob
- **WHEN** WHY-ledger validation runs
- **THEN** the row is accepted

#### Scenario: Load-bearing row uses a stale blob

- **GIVEN** a load-bearing row is bound to an older source-blob digest
- **WHEN** WHY-ledger validation runs
- **THEN** the row is rejected as stale

#### Scenario: Semantic field is absent or a placeholder

- **GIVEN** a load-bearing row lacks WHY, invariant, reviewer question, or answer
- **OR** a required field contains an unfilled template placeholder
- **WHEN** WHY-ledger validation runs
- **THEN** the row is rejected
- **AND** investigation cannot be sealed

#### Scenario: Engine reports a completed semantic row

- **GIVEN** an actor supplied a structurally complete WHY row
- **WHEN** the engine stores or renders it
- **THEN** it preserves the actor as semantic author
- **AND** it does not claim that the engine proved the WHY true or proved that the actor understood the file

### Requirement: Non-Load-Bearing Evidence Remains Explicit

A non-load-bearing group MUST have an explicit classification and concrete rationale. It MUST NOT require a full WHY row unless policy or review promotes the group or one of its exceptions to load-bearing.

#### Scenario: Incidental group has a concrete rationale

- **GIVEN** a group is classified as incidental or irrelevant with a concrete reason
- **WHEN** investigation evidence is validated
- **THEN** the group may pass without a full WHY row

#### Scenario: Reviewer promotes an exception to load-bearing

- **GIVEN** a reviewer identifies one exception inside a non-load-bearing group
- **WHEN** that exception is accepted as load-bearing
- **THEN** it requires current full-blob WHY coverage
- **AND** the remaining group retains only its effective covered hits

### Requirement: Design Ledger Is an Engine-Managed Projection

The workflow engine SHALL render one marked investigation-ledger region of the authoritative design from structured investigation evidence. The engine SHALL own the markers, objective fields, and all projection bytes inside that region.

Semantic WHY, invariant, question, and answer fields MUST retain actor provenance and MUST be represented as reviewed claims rather than engine-authored or engine-verified understanding.

#### Scenario: Managed ledger matches structured evidence

- **GIVEN** current structured evidence and WHY rows
- **WHEN** the design ledger is rendered
- **THEN** its paths, locations, digests, groups, terms, and semantic fields match the structured source exactly

#### Scenario: Managed ledger is edited manually

- **GIVEN** the rendered design ledger differs from its current structured source
- **WHEN** planning validation runs
- **THEN** validation fails
- **AND** the manual projection does not become evidence

#### Scenario: Managed markers are ambiguous

- **GIVEN** design contains missing, duplicate, nested, or malformed ledger markers
- **WHEN** planning validation runs
- **THEN** validation fails without guessing an authored/managed boundary

### Requirement: Investigation Evidence Uses Provenance and Semantic Digests

Every investigation evidence node SHALL have a provenance-sensitive `nodeId` and a semantic `resultDigest`. Runtime-only timestamps, retry counts, latency, process IDs, mutable ref names, and UI metadata MUST NOT enter either digest unless reviewed policy explicitly makes them semantic.

An exact input or provenance-parent change MUST produce a new `nodeId`. Invalidation MAY stop at equal semantic output only when evaluator, policy, node schema, and output schema are compatible and a current convergence record proves the shared `resultDigest`.

#### Scenario: Input changes but semantic output converges

- **GIVEN** a recomputed node has a changed exact input or provenance parent
- **AND** compatible evaluation produces the same canonical semantic output
- **WHEN** node identity is calculated
- **THEN** the new `nodeId` differs from the old one
- **AND** the `resultDigest` is equal
- **AND** propagation stops only through a valid convergence record

#### Scenario: Runtime metadata changes

- **GIVEN** only timestamp, retry, latency, process, or display metadata changes
- **WHEN** semantic node identity is evaluated
- **THEN** the semantic `nodeId` and `resultDigest` remain unchanged

#### Scenario: Policy changes with equal output bytes

- **GIVEN** a node is recomputed under an incompatible evaluator, policy, node schema, or output schema
- **WHEN** output bytes happen to match
- **THEN** the old and new parent edges do not converge

### Requirement: Descendant Reuse Preserves Original Provenance

An existing descendant MAY remain current across a converged parent only when its current evidence path contains a valid reuse proof for every changed parent edge. The descendant's immutable object and original parent provenance MUST NOT be rewritten.

#### Scenario: Every changed parent has a valid reuse proof

- **GIVEN** an existing descendant semantically depends on converged parent outputs
- **AND** each changed parent edge has a proof naming the descendant, old and new parents, convergence record, shared result digest, and validator version
- **WHEN** currentness is evaluated
- **THEN** the original descendant may be reused through that complete proof path

#### Scenario: One changed parent lacks proof

- **GIVEN** a descendant has multiple changed parent edges
- **AND** at least one edge lacks a current compatible proof
- **WHEN** currentness is evaluated
- **THEN** the descendant is stale

#### Scenario: Reuse attempts to rewrite descendant provenance

- **GIVEN** an old descendant names an old immutable parent
- **WHEN** reuse is recorded
- **THEN** the engine retains the original descendant object and parent link
- **AND** it records the new evidence path in separate immutable proof objects
