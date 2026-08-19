# Workflow Engine Boundary Inventory

This document freezes the T3 extraction starting point observed at
`749616aa6e77ece5bcc3aa590a8b145d00c40e11`. It is a characterization of
landed code, not evidence that the planned package boundaries already exist.
When this inventory and the repository disagree, landed code is authoritative.

## Scanner baseline

The companion contract test parses TypeScript and JavaScript syntax rather than
counting comments. Its primary-source baseline is 125 direct
`workflow/*.json` literal occurrences in 48 files, covering 10 unique paths.
It separately records three split `path.join` sites and one dynamic enumeration
of the workflow JSON directory. The legacy signature/record namespace
`expense-app.workflow.*` occurs 25 times in 15 primary TypeScript files and 17
times in 9 generated recovery JavaScript files. JSON Schema `$id` hosts are a
separate compatibility surface: 17 `expense-app.local`, one `expense.local`,
and one `example.local`.

These numbers are scope-qualified. Generated recovery files are not counted as
additional extraction work, and JSON Schema URIs are not signature namespaces.
The 125-occurrence baseline covers source references to workflow JSON files; it
is not a count of path-bearing values inside authority policy artifacts. The
machine-readable fixture beside the module migration map contains the exact
scope, paths, and evidence strings.

## Coupling dispositions

<!-- coupling:agent-provider-identity -->

### Agent provider identity — coupled

The runtime still defines the fixed `codex | claude` identity inside the
workflow-engine package. T3.3c moves that identity behind the agent-runtime
boundary while retaining the reviewed provider profiles.

<!-- coupling:availability-pilot -->

### Availability pilot — landed

The Codex/Claude pilot and verifier already own an exact-baseline,
policy-bound availability decision. Its record is empirical read-only evidence;
it does not prove structural availability, a future SLA, or actual cost. A
generic probe may feed this verifier but must not create a second decision
authority.

<!-- coupling:central-grant-shadow-authority -->

### Central Grant shadow authority — unresolved

Central Grant is connected to the investigation v3 path, but the persisted
observation remains explicitly non-authoritative (`authorityEligible: false`).
Whether it is promoted from shadow to authoritative is an owner decision and is
outside decoupling work.

<!-- coupling:collaboration-grant -->

### Collaboration Grant — landed

The exact signed envelope, role-independence-only scope, TTL, verification, and
historical readers are production behavior. T3.3d extracts those contracts; it
does not replace them with a broader grant.

<!-- coupling:data-egress-authorization -->

### Data-egress authorization — landed

`workflow/ai-adapter-policy.json` schema v4 is the repository-owned provider
authorization surface. Extraction introduces a policy port around it without a
second authority source.

<!-- coupling:execution-substrate -->

### Execution substrate — landed

Workflow, Job, Attempt, lease, retry, and fencing are the existing execution
state machine. T3 changes interface and storage ownership, not lifecycle
semantics.

<!-- coupling:openspec-direct-dependency -->

### OpenSpec direct dependency — coupled

Application and entrypoint code still imports OpenSpec planning and archive
logic directly. T3.3a-b puts validation and projection behind the core-owned
planning-provider port.

<!-- coupling:package-topology -->

### Package topology — missing

The organized `modules/`, `runtime/`, `adapters/`, and related folders remain
one `@expense/workflow-engine` package. The planned `@jigwright/*` packages do
not exist at this baseline.

<!-- coupling:planning-provider-binding -->

### Planning-provider binding — missing

There is no committed `workflow/change-providers` binding or
`PlanningProviderPort`. T3.3a must add a versioned binding, digest contract,
archive retention, and explicit v1 migration refusal.

<!-- coupling:policy-path-literals -->

### Policy-path literals — coupled

Direct strings, split joins, and dynamic workflow-directory enumeration bind
the engine to the consumer repository layout. T3 replaces them with validated
repository configuration and keeps scanner coverage for all three forms.

<!-- coupling:provider-plane-separation -->

### Provider-plane separation — missing

Planning providers, agent runtimes, and grant verification do not yet have
separate ports. T3 must keep required planning bindings separate from optional
agent plans.

<!-- coupling:provider-runner -->

### Provider runner — partial

Provider execution already preserves executable identity, a sanitized
environment, private runtime state, bounded execution, and governed evidence.
The provider invocation path is still synchronous and remains part of T3.3c.

<!-- coupling:recovery-mirror -->

### Recovery mirror — partial

The TS-to-JS recovery closure, manifest, pin, and generator `--check` mode
already exist. T3.3d must register and preserve that drift check rather than
create a second mirror system.

<!-- coupling:role-assurance -->

### Role assurance — landed

The role scheduler and provider-independent floor are production behavior.
Their separately planned pre-anchor/session-independent migration is not part
of this inventory slice.

<!-- coupling:runtime-distribution -->

### Runtime distribution — coupled

The current package requires Node and `--experimental-strip-types`. T3 keeps
that requirement through extraction; the v1 distribution decision belongs to
the later distribution phase.

<!-- coupling:schema-signature-namespace -->

### Schema and signature namespace — coupled

Legacy consumer-specific namespaces remain in signatures, records, recovery
code, and JSON Schema URIs. Extraction adds neutral writers and allowlisted
legacy readers; historical records are never re-signed.

## Mechanical-move discipline

Each extraction batch follows the landed refactor precedent: add guardrails,
freeze an exact migration map, move one bounded ownership slice, regenerate
path-derived policy and recovery artifacts mechanically, then run targeted
contract checks. A move must not silently strengthen authority, weaken
historical verification, duplicate the execution state machine, or add new
ordinary-change governance requirements.
