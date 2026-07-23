## ADDED Requirements

### Requirement: Provider Execution Uses a Reviewed Built-In Registry

The workflow engine SHALL select AI providers only from a reviewed built-in provider registry. The initial registry MUST provide Codex and Claude adapters with declared capabilities.

Repository configuration MAY enable or disable a built-in provider and lower bounded resource policy. It MUST NOT supply a provider ID, executable path, shell fragment, dynamic module path, command template, prompt implementation, or result parser.

#### Scenario: Enabled built-in provider is selected

- **GIVEN** a registered provider is enabled and supports the required capability
- **WHEN** the scheduler assigns that capability
- **THEN** the engine uses the reviewed built-in adapter

#### Scenario: Repository config supplies a provider command

- **GIVEN** repository configuration contains an executable, shell string, module path, or command template
- **WHEN** provider configuration is validated
- **THEN** validation fails
- **AND** the supplied value cannot become executable authority

#### Scenario: Unknown provider is requested

- **GIVEN** a provider ID is absent from the reviewed registry
- **WHEN** an invocation or role assignment requests it
- **THEN** the request fails before process launch

### Requirement: Built-In Adapters Resolve Only Reviewed Executable Candidates

Each built-in adapter SHALL resolve its provider from code-reviewed platform candidates, canonicalize and inspect the resulting executable, and verify the required version/capability surface. It MUST NOT search caller-controlled `PATH` or accept a repository-provided executable.

#### Scenario: Compatible reviewed candidate exists

- **GIVEN** one reviewed candidate resolves to a compatible canonical executable
- **WHEN** provider preflight runs
- **THEN** the adapter records the real executable identity and version
- **AND** the provider may be reported available for its reviewed capabilities

#### Scenario: PATH contains a fake provider executable

- **GIVEN** caller `PATH` contains a fake executable named `codex` or `claude`
- **WHEN** provider preflight runs
- **THEN** the fake PATH entry is not selected

#### Scenario: No compatible candidate exists

- **GIVEN** no reviewed candidate is present and compatible
- **WHEN** provider preflight runs
- **THEN** the provider is reported unavailable
- **AND** no arbitrary fallback is launched

### Requirement: Actor Identity Is Resolved Once and Reported Honestly

At each investigation or task-session boundary, the workflow engine SHALL collect explicit actor selection and recognized runtime hints, resolve the selected actor, record all observed signals and assurance levels, and pin the result for that session. Runtime hints or explicit claims MUST NOT be represented as cryptographic provider identity.

Contradictory recognized signals MUST pause or fail actor resolution rather than being used to manufacture role independence.

#### Scenario: Runtime hint identifies the caller

- **GIVEN** no explicit actor was supplied and one recognized runtime hint identifies a provider
- **WHEN** the session opens
- **THEN** that provider is recorded as actor
- **AND** its assurance is recorded as `runtime-hint`

#### Scenario: Explicit actor is supplied without stronger proof

- **GIVEN** a valid explicit actor selection with no contradictory signal
- **WHEN** the session opens
- **THEN** the provider is pinned as actor
- **AND** its assurance is no stronger than self-declared

#### Scenario: Actor signals conflict

- **GIVEN** explicit selection and recognized runtime evidence name different providers
- **WHEN** actor resolution runs
- **THEN** the transition enters an actor-resolution-required outcome or fails with the conflict
- **AND** the disputed identity cannot satisfy provider-independence policy

#### Scenario: Routine transition follows session creation

- **GIVEN** actor identity is already pinned for a session
- **WHEN** a routine sub-transition runs
- **THEN** the engine does not ask for actor identity again
- **AND** the stored actor does not change implicitly

### Requirement: Independence Is Enforced Relative to Roles

The workflow engine SHALL express every role-separation requirement at an explicit dimension, including principal independence, provider independence, session independence, or no independence. Ordinary blind-survey and PlanReview assignments SHALL require provider independence relative to the author being challenged; repository or caller policy MUST NOT lower either ordinary requirement. The scheduler MUST satisfy the required dimension, or pause for an eligible exact collaboration grant whose result remains visibly degraded.

Provider inequality and session inequality MUST NOT be treated as interchangeable.

#### Scenario: Plan reviewer requires provider independence

- **GIVEN** provider A authored the plan and review policy requires provider independence
- **WHEN** the scheduler assigns a reviewer
- **THEN** it selects an eligible provider other than A
- **OR** the transition pauses for an eligible collaboration continuation grant

#### Scenario: Blind surveyor requires provider independence

- **GIVEN** provider A is the investigation author
- **WHEN** the scheduler assigns the ordinary blind-survey role
- **THEN** it selects an eligible provider other than A
- **OR** the transition pauses for an eligible collaboration continuation grant

#### Scenario: Repository attempts to lower an ordinary role

- **GIVEN** repository or caller configuration requests session-only or no independence for blind survey or PlanReview
- **WHEN** role policy is validated
- **THEN** validation fails
- **AND** the ordinary provider-independence requirement remains effective

#### Scenario: Same provider uses a fresh authorized session

- **GIVEN** degraded policy permits the same provider in a fresh session
- **WHEN** the assignment is recorded
- **THEN** it is labeled session-independent
- **AND** it is not labeled provider-independent

#### Scenario: Caller supplies work without a provider session

- **GIVEN** an exact human grant permits caller-supplied degraded work because no adapter is callable
- **WHEN** the role result is recorded
- **THEN** it is labeled with no provider or session independence
- **AND** no engine-spawned provider claim is recorded

### Requirement: Every Provider Call Uses a Bound Typed Invocation

Every provider call SHALL use a typed request and result contract bound to invocation identity, nonce, purpose, provider assignment, capability profile, repository, baseline, target, input manifest, output schema, evaluator/policy versions, and resource limits.

A malformed result, mismatched binding, excessive output, timeout, signal, spawn failure, or non-zero exit MUST NOT produce successful evidence.

#### Scenario: Provider returns a mismatched nonce

- **GIVEN** an invocation request contains one nonce
- **WHEN** the provider result contains another nonce
- **THEN** the result is rejected
- **AND** no successful lifecycle evidence is created

#### Scenario: Provider returns the wrong target

- **GIVEN** an invocation is bound to one target and manifest
- **WHEN** the result names a different target or manifest
- **THEN** the result is rejected as unbound output

#### Scenario: Provider process fails

- **GIVEN** a process times out, is signaled, exceeds output limits, or exits non-zero
- **WHEN** invocation completion is evaluated
- **THEN** no successful report is created
- **AND** the lifecycle exposes a durable retry, correction, or waiting outcome

### Requirement: Read-Only Provider Results Require an Unchanged Governed Projection

Survey and plan-review providers SHALL receive the reviewed repository-read-only capability profile. The engine SHALL compare the governed repository and runtime projection before and after invocation, including HEAD/ref/tree, refs, index, tracked/untracked/ignored worktree manifests, planning artifacts, and governed runtime inputs.

Any observed drift outside the exact engine-owned invocation output MUST make the result unusable. The resulting claim MUST be limited to observed projection equality and MUST NOT be described as adversarial same-user containment.

#### Scenario: Read-only invocation preserves governed state

- **GIVEN** a read-only provider invocation
- **WHEN** before and after governed fingerprints are identical and typed output is valid
- **THEN** the invocation may produce an immutable successful report

#### Scenario: Read-only invocation changes a governed path or ref

- **GIVEN** a read-only provider invocation
- **WHEN** worktree, index, refs, planning artifacts, or governed runtime inputs drift
- **THEN** the result is rejected
- **AND** it cannot become review or investigation evidence

#### Scenario: Assurance is displayed

- **GIVEN** a read-only invocation passed observed fingerprint checks
- **WHEN** its assurance is rendered
- **THEN** it reports unchanged governed projection
- **AND** it does not claim proof that the same OS user could not perform unobserved writes
