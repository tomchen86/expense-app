## MODIFIED Requirements

### Requirement: Canonical Planning Artifacts

The repository SHALL use OpenSpec specs for normative requirements and one OpenSpec change directory for each active planning generation. Investigation-first generations SHALL keep normalized investigation, proposal, design, delta specs, task list, execution strategy, guard, and exact-plan review in that canonical change tree. The repository SHALL NOT maintain a parallel workflow planning/task tree.

Detailed runtime transcripts, leases, and mutable refs MAY remain under the Git common directory, but every semantic fact required for remote planning assurance MUST be reconstructable from Git or retained in the compact tracked artifacts.

#### Scenario: Agent locates active work

- **GIVEN** an active managed change
- **WHEN** an agent determines requirements, design, investigation evidence, review state, or remaining tasks
- **THEN** it reads the applicable `openspec/specs/` and `openspec/changes/<change-id>/` artifacts
- **AND** it does not infer task or planning truth from chat history, runtime transcript, or a second planning tree

#### Scenario: CI validates investigation-first planning

- **GIVEN** CI has Git objects and the tracked v2 planning tree but no local investigation runtime directory
- **WHEN** planning assurance runs
- **THEN** it can reconstruct every mechanical planning gate without provider credentials or raw transcripts

### Requirement: Blocking Session Preflight

The workflow engine SHALL refuse to create an active task session unless repository identity, branch, clean baseline, governing planning generation, change artifacts, a current sealed investigation or eligible structured investigation exemption, current PlanReview when applicable, task strategy, task policy, and exclusive lock invariants pass. For an investigation-first generation, the session SHALL pin `planningGenerationId`, exact investigation applicability node/digest, and exact current PlanReview node/digest.

#### Scenario: Dirty worktree is rejected

- **GIVEN** a valid change and task
- **AND** the working tree has a staged, unstaged, or untracked path
- **WHEN** session start is requested
- **THEN** the command exits with a guard failure
- **AND** it creates no active session or retained lock
- **AND** it does not stash, reset, delete, or absorb the existing work

#### Scenario: Valid investigation-first baseline creates a pinned session

- **GIVEN** a clean worktree on the exact change branch
- **AND** the latest managed plan generation, selected investigation applicability branch, proposal, design, delta specs, tasks, guard, execution strategy, and PlanReview validate
- **WHEN** session start is requested
- **THEN** one exclusive change lock is acquired
- **AND** an atomic session records repository, Git, planning generation, exact investigation applicability node/digest, exact PlanReview node/digest, artifact digest, task strategy/scope, actual orchestration and achieved independence, any grant/use/direct-human-attestation references, role constraints, and required checks

#### Scenario: Plan review belongs to an older generation

- **GIVEN** a newer managed plan generation supersedes the generation named by PlanReview
- **WHEN** task start is requested
- **THEN** session creation fails before acquiring durable execution authority

### Requirement: Immutable Evidence Chain

Each passing check, planning evidence node, PlanReview, completion projection, finish projection, and managed commit SHALL produce or reference content-addressed immutable evidence. A transition SHALL validate the applicable node/report digest, kind, direct semantic inputs, provenance parents, session or planning-generation identity, pinned contract, Git baseline/target, changed paths, working-state fingerprint, role assurance, and required check evidence before relying on it. Every task check, completion, finish, and commit report for an investigation-first session SHALL reference the session-pinned `planningGenerationId` and exact PlanReview node/digest; changing or omitting either identity makes the report unusable.

#### Scenario: Task report omits the pinned plan review

- **GIVEN** an investigation-first session pins one planning generation and exact PlanReview node
- **WHEN** check, completion, finish, or commit evidence omits or changes either identity
- **THEN** the evidence is rejected
- **AND** no later task transition relies on it

Planning evidence MUST distinguish a provenance-sensitive `nodeId` from a canonical semantic `resultDigest`; runtime-only metadata MUST NOT change semantic identity.

#### Scenario: Passing report payload is replaced

- **GIVEN** a report ID is stored on an active session
- **AND** the file content no longer hashes to that ID
- **WHEN** the next transition is requested
- **THEN** the transition fails as stale state
- **AND** no checkbox, staging, ref update, or planning authorization is granted

#### Scenario: Report omits required check evidence

- **GIVEN** a content-addressed task report matches the current diff fingerprint
- **BUT** its check evidence omits a required ID or order
- **WHEN** completion or commit validation runs
- **THEN** the report is rejected

#### Scenario: Planning node exact input changes

- **GIVEN** a planning evidence node's exact input or provenance parent changes
- **WHEN** the node is recomputed
- **THEN** it receives a new `nodeId`
- **AND** no mutable pointer is rewritten to launder the old object as current

#### Scenario: Only runtime metadata changes

- **GIVEN** only timestamp, retry, latency, process, or display metadata differs
- **WHEN** semantic planning identity is recomputed under unchanged policy
- **THEN** `nodeId` and `resultDigest` remain unchanged

### Requirement: Serialized Completion Authority

Only one state-changing operation SHALL act on a session at a time. The engine SHALL continue to support the legacy `check -> complete-task -> finish` sequence, in which completion changes only the exact unchecked checkbox and generated handoff bytes authorized by current evidence and finish reruns required checks before exact staging.

The engine SHALL additionally provide a projected single-pass path that constructs the exact implementation + checkbox + handoff prospective tree, executes every current-task required check exactly once against that complete projection, and stages only a tree proven identical to the checked prospective tree. Immediate-predecessor reconciliation MAY independently execute the predecessor's required checks and MUST keep that evidence distinct from the current task's finalization evidence. The single-pass path SHALL emit a schema-compatible check, completion, and finish evidence chain and SHALL leave managed commit as a separate transition that does not rerun required checks.

For a caught ordinary failure before successful final application, the single-pass path SHALL restore the exact pre-invocation engine-owned projection bytes and modes, leave the real index and session report pointers unchanged, remove its temporary state, and return the session to active use. It SHALL revalidate HEAD, session, contract, worktree, index, projection, runner inputs, and operation ownership before staging; a mismatch is stale state and MUST NOT cause partial staging. This substrate MUST NOT claim recovery from process death, machine loss, or mutation outside the governed projection; durable invocation recovery and commit transaction remain separate future requirements.

#### Scenario: Single-pass completion succeeds

- **GIVEN** an active task session has an allowed implementation diff, an empty index, and current pinned inputs
- **WHEN** projected single-pass finalization succeeds
- **THEN** every current-task required check executes exactly once against the implementation, checked task row, and generated handoff that will be staged
- **AND** the staged tree equals the checked prospective tree
- **AND** compatible check, completion, and finish reports bind that same tree
- **AND** the session awaits the separate managed commit transition

#### Scenario: Required check rejects the final projection

- **GIVEN** a required check would pass on the implementation-only tree but fails when the projected checkbox or handoff is present
- **WHEN** projected single-pass finalization runs
- **THEN** the command fails without staging
- **AND** the engine-owned worktree projection bytes and modes equal their pre-invocation state
- **AND** no check, completion, or finish report pointer is advanced

#### Scenario: Real state drifts before exact staging

- **GIVEN** all checks passed against one prospective tree
- **AND** HEAD, session, contract, worktree, index, projection, runner inputs, or operation ownership no longer matches the pinned inspection
- **WHEN** the engine attempts final application
- **THEN** it rejects the evidence as stale
- **AND** it creates no partial staging projection

#### Scenario: Legacy completion remains available

- **GIVEN** a caller uses the existing serialized completion commands
- **WHEN** `check`, `complete-task`, and `finish` run under their existing preconditions
- **THEN** the engine retains their existing report and recovery semantics
- **AND** introduction of the single-pass path does not silently reinterpret legacy reports

## ADDED Requirements

### Requirement: Planning Evidence Invalidation Is Dependency-Specific and Fail-Closed

Every planning evidence node SHALL declare exact direct inputs, semantic parent result digests, exact provenance parent node IDs, evaluator/schema/policy identity, and canonical output. A changed input SHALL stale only dependent descendants unless a valid compatible convergence and descendant-reuse proof path establishes unchanged semantic output.

Unknown dependencies, missing parents, ambiguous grouping coverage, incompatible versions, incomplete multi-parent proofs, or unverifiable input digests MUST remain stale.

#### Scenario: Unrelated term is added

- **GIVEN** current evidence exists for sealed terms and their descendants
- **WHEN** another independent term is sealed
- **THEN** only its scan and changed descendants are computed
- **AND** unrelated current nodes remain reusable

#### Scenario: One source blob changes

- **GIVEN** several WHY nodes depend on distinct complete source blobs
- **WHEN** one blob changes
- **THEN** only nodes depending on that blob and their semantic descendants become stale

#### Scenario: Equal compatible output converges

- **GIVEN** a changed parent recomputes under compatible evaluator, policy, and schema identities
- **AND** its canonical semantic output has the prior `resultDigest`
- **WHEN** a convergence record and every required descendant-reuse proof validate
- **THEN** an old descendant may remain current through the explicit proof path

#### Scenario: One changed parent proof is missing

- **GIVEN** a descendant depends on multiple changed parents
- **AND** at least one changed edge lacks a valid proof
- **WHEN** currentness is evaluated
- **THEN** the descendant is stale

### Requirement: Live and CI Planning Assurance Share Content-Pure Validators

Every replayable investigation or exemption, projection, planning-generation, PlanReview, actor/role result, collaboration-grant use, and evidence-DAG gate SHALL have one content-pure validator over a canonical subject, reviewed policy, immutable artifacts, and resolved Git objects. Live transitions and CI SHALL call the same validator semantics. Collaboration evidence SHALL additionally pass one aggregate validator that rejects duplicate grant/use identities across the complete replayed subject.

Provider invocation itself MUST NOT be replayed in CI. CI MUST NOT upgrade soft identity, orchestration, independence, containment, WHY truth, or reviewer judgment claims.

#### Scenario: Live and CI receive the same canonical subject

- **GIVEN** live transition and CI loaders construct the same canonical subject and immutable artifact set
- **WHEN** planning validation runs
- **THEN** both callers produce the same pass/fail result and semantic result digest

#### Scenario: CI lacks provider credentials

- **GIVEN** tracked PlanReview and investigation evidence are structurally current
- **WHEN** CI validates them without Codex, Claude, credentials, or local invocation transcripts
- **THEN** CI replays schema, digest, applicability/exemption, scan when applicable, projection, target, role-result admission, grant/use including aggregate uniqueness, and freshness gates
- **AND** it does not rerun or reinterpret AI judgment

#### Scenario: Candidate evidence requires runtime-only semantic data

- **GIVEN** a candidate planning claim cannot be reconstructed from Git and omits that semantic fact from tracked evidence
- **WHEN** CI assurance runs
- **THEN** validation fails closed

### Requirement: Assurance Claims Preserve Their Actual Hardness

Workflow artifacts and output SHALL use the stable claim-ID registry from the formal design and distinguish hard mechanical facts from soft semantic or local-identity claims. They SHALL preserve each claim's registered hardness and delivery owner; future T2 claims MUST be labeled undelivered until their owner is implemented. They SHALL distinguish self-declared, runtime-hint, adapter-assigned, provider-signed, and workload-attested identity when present, and SHALL distinguish provider independence, session independence, and no independence.

No report or documentation SHALL claim complete breadth, genuine depth, correct WHY, correct AI verdict, cryptographic local model identity, same-user adversarial confinement, or semantic closure from exact-term scans.

An investigation exemption MUST mark `C-TERM-SCAN`, `C-WHY-BINDING`, and related breadth/depth claims inapplicable for its exact scope rather than satisfied. It MUST NOT strengthen `C-TERM-COMPLETENESS`, `C-GRAPH-COMPLETENESS`, or any other soft claim.

#### Scenario: Runtime hint selects an actor

- **GIVEN** actor identity is supported only by a recognized runtime hint
- **WHEN** assurance is rendered locally or in CI
- **THEN** the identity remains labeled `runtime-hint`
- **AND** CI does not upgrade it

#### Scenario: Every sealed term was scanned

- **GIVEN** deterministic scan validation proves every effective sealed term has a current node
- **WHEN** breadth assurance is summarized
- **THEN** the report claims complete execution of the sealed term set
- **AND** it does not claim that every semantically relevant term or dependency was found

#### Scenario: WHY fields are present and blob-bound

- **GIVEN** structural WHY validation passes
- **WHEN** depth assurance is summarized
- **THEN** the report claims current exact-blob field binding
- **AND** it does not claim that the explanation is true or that cognition was proved

#### Scenario: Exempt investigation renders assurance

- **GIVEN** the current plan used an eligible structured investigation exemption
- **WHEN** local or CI assurance is rendered
- **THEN** scan and WHY claims are labeled inapplicable rather than passed
- **AND** the exemption does not imply semantic completeness or understanding

#### Scenario: Future claim is rendered before its owner is implemented

- **GIVEN** the registry assigns a claim such as exact closure or coverage composition to a future T2 change
- **WHEN** T1.5 assurance is rendered
- **THEN** the claim is labeled undelivered
- **AND** no synonym promotes it to a current hard guarantee
