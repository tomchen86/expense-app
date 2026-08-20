# Workflow Engine Boundary Inventory

The extraction anchor is
`749616aa6e77ece5bcc3aa590a8b145d00c40e11`. This document now also records
the bounded T3 slices present in the current checkpoint; the anchor is not a
claim that those later slices existed in that commit. The companion fixture
freezes exact current-tree identities. When this inventory and the repository
disagree, code is authoritative.

## Scanner baseline

The companion contract test parses TypeScript and JavaScript syntax rather than
counting comments. Its primary-source baseline is 154 direct
`workflow/*.json` literal occurrences in 49 files, covering 10 unique paths.
AST provenance separately freezes three split `path.join`/`path.resolve` sites
and one workflow-root directory enumeration. Bootstrap TypeScript contributes
nine direct references in three files, and root tooling scripts contribute one.
The generated recovery projection contains 29 direct references in 11 files
and three split path joins in three files; these are pinned separately from the
primary extraction workload.

The legacy signature/record namespace `expense-app.workflow.*` occurs 24 times
in 15 primary TypeScript files, once in bootstrap TypeScript, 16 times in 9
generated recovery JavaScript files, and three times in three workflow JSON
artifacts. JSON Schema `$id` values are a separate compatibility surface: 17
`expense-app.local`, one `expense.local`, and one `example.local`; the complete
URI identities, not only host counts, are frozen.

Top-level workflow artifacts contain a different path surface. Across
`workflow/*.json`, 1,090 string leaves in seven files are equal to
`packages/workflow-engine` or begin with that package prefix. This scope
includes authority-sensitive policies and generated test shards; it does not
label every value as authority. Their file, JSON Pointer, and raw value
identities are frozen for mechanical remapping.

These numbers are scope-qualified. Generated recovery files are not counted as
additional extraction work, JSON Schema URIs are not signature namespaces, and
source references to workflow JSON files are not conflated with path-bearing
values inside workflow artifacts. The machine-readable fixture beside the
module migration map contains the exact scopes and identity digests.

## Coupling dispositions

<!-- coupling:agent-provider-identity -->

### Agent provider identity — coupled

The bounded process/protocol slice of `@jigwright/agent-runtime` now exists,
but the runtime still defines the fixed `codex | claude` identity and
provider-specific policy inside the workflow-engine package. Later T3.3c work
must move that ownership behind the package boundary while retaining the
reviewed provider profiles.

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

### Collaboration Grant — partial

The generic exact-envelope verifier, exact historical/current envelope reader,
and one-use reserve/consume/expire/revoke lifecycle reducer are extracted to
`@jigwright/grants` and are used by Collaboration Grant. The exact
role-independence-only scope, TTL, durable bytes, and error mapping remain
intact. Expense-specific payload semantics, locking, durable schema, and
storage remain in the engine; no broader blanket grant was introduced.

<!-- coupling:data-egress-authorization -->

### Data-egress authorization — landed

`workflow/ai-adapter-policy.json` schema v4 remains the repository-owned
provider authorization surface. A strict-v4 current-policy port now fronts it;
the v3 parser is replay-only and cannot become a second live authority source.

<!-- coupling:execution-substrate -->

### Execution substrate — partial

`@jigwright/core` now owns the exact Job/Attempt status vocabulary and the
AttemptResult acceptance-binding codec. Workflow, Job, Attempt, lease, retry,
and fencing in `execution-store` remain the existing sole aggregate and
transition authority. Broader Git/session/check/record ownership has not yet
moved, and no second lifecycle reducer was introduced.

<!-- coupling:openspec-direct-dependency -->

### OpenSpec direct dependency — coupled

Planning inspection now crosses `PlanningProviderPort`, but propose, archive,
and several CI paths still import the in-engine OpenSpec adapter directly. The
remaining coupling is the standalone adapter extraction and those direct
archive/propose seams, not absence of the planning port.

The planning seam retains all eight planning-provider responsibilities:
provider provenance, artifact inventory, task/source anchors, readiness
diagnostics, spec and archive targets, archive projection, error normalization,
and historical replay. Agent-runtime extraction does not absorb or weaken any
of them.

<!-- coupling:package-topology -->

### Package topology — partial

`@jigwright/core`, `@jigwright/grants`, `@jigwright/fixture-adapter`, and a
bounded `@jigwright/agent-runtime` process/protocol slice now exist, and the
workflow engine declares its runtime workspace dependencies. The fixture
adapter consumes public CheckRegistry, repository-path, and tracked-object
reader contracts. Only the standalone `@jigwright/openspec-adapter` package
remains absent; its absence is checked independently by path and symbol scans.

<!-- coupling:planning-provider-binding -->

### Planning-provider binding — partial

The v1 binding contract, digest, current and pinned readers, history check,
composition wiring, archive retention, and explicit migration refusal are
landed. No tracked per-change `workflow/change-providers` document has yet
activated that path; path absence and workflow-document content are checked
independently.

<!-- coupling:policy-path-literals -->

### Policy-path literals — coupled

Direct strings, split joins, and dynamic workflow-directory enumeration bind
the engine to the consumer repository layout. Path-bearing values in checks,
maintainer policy/profiles, path roles, protected capabilities, CI policy, and
test shards form a second remap surface. T3 replaces these with validated
repository configuration and keeps identity coverage for both surfaces.

<!-- coupling:provider-plane-separation -->

### Provider-plane separation — partial

Planning providers, agent runtimes, and grant verification have distinct engine
contracts. Required planning-binding paths and optional agent-role-plan paths
also have separate readers; an absent optional agent plan does not weaken or
replace the required planning contract. Core ownership of these ports and
direct adoption of a public `@jigwright/agent-runtime` execution port remain
incomplete.

<!-- coupling:provider-runner -->

### Provider runner — partial

The bounded async process primitive and strict JSONL wrapper protocol are now
owned by `@jigwright/agent-runtime` and consumed through engine compatibility
facades. Provider execution still preserves executable identity, a sanitized
environment, private runtime state, bounded execution, and governed evidence.
Reviewed provider identity and policy binding, synchronous compatibility,
non-resumable sessions, and the documented containment residuals remain in the
engine.

<!-- coupling:recovery-mirror -->

### Recovery mirror — partial

The recovery generator now compiles the reachable workspace source closure and
projects dependency packages into path-stable runtime locations while
retaining exact `--check`/`--write` tree comparison. The generated recovery
bytes are intentionally deferred to the final one-shot regeneration, so this
surface remains partial rather than claimed complete.

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

### Schema and signature namespace — partial

`@jigwright/grants` now performs exact version dispatch between the historical
V1 Collaboration Grant namespace and the neutral current V2 namespace, with no
namespace retry or fallback. Other consumer-specific namespaces remain in
signatures, records, recovery code, and JSON Schema URIs. Historical records
are never re-signed.

## Mechanical-move discipline

Each extraction batch follows the landed refactor precedent: add guardrails,
freeze an exact migration map, move one bounded ownership slice, regenerate
path-derived policy and recovery artifacts mechanically, then run targeted
contract checks. `mechanical-move` applies only where exact remap and blob
identity prove a byte-identical move. Import or content edits remain a separate
semantic commit with normal review. Each phase regenerates its authority remap
and projections once; identity or role-continuity failure keeps the ordinary
risk floor in force, and required-check migration is a definition transition,
never a suspension. A move must not silently strengthen authority, weaken
historical verification, duplicate the execution state machine, or add new
ordinary-change governance requirements.
