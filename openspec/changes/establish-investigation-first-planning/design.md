## Context

The current workflow engine has strong execution authority but a deliberately narrow planning model. The project-local `expense-app` schema admits `.openspec.yaml`, proposal, design, delta specs, tasks, and `guard.json`; planning-path validation, managed-change validation, plan reports, task start, archive replay, fixtures, and CI all encode that exact five-artifact model. `plan-commit` validates and commits a complete authored plan, but nothing mechanically requires a broad survey, full-file rationale, or a provider-independent plan challenge.

The existing AI adapter surface is also intentionally evaluation-only. `workflow/ai-adapter-policy.json` permits no provider launch, and the adapter command reports missing isolation rather than executing an AI. Existing content records provide useful immutable-write primitives, but their IDs include timestamped payload bytes and do not implement the required provenance-sensitive `nodeId`, semantic `resultDigest`, convergence records, or descendant reuse proofs. Planning transitions are synchronous and process-scoped, while provider waits and caller answer cycles require durable state with short transition locks.

The pre-design survey identified the following load-bearing mechanisms and invariants. This table is investigation evidence for this legacy-schema bootstrap plan; it is not represented as an engine-owned managed projection because that capability does not exist yet.

| Mechanism                                  | Current files                                                                                                                                                                                                                | Why it is load-bearing                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed schema identity and graph          | `openspec/config.yaml`, `openspec/schemas/expense-app/**`, `packages/workflow-engine/src/openspec-schema-contract.ts`, `packages/workflow-engine/src/openspec-adapter.ts`, `packages/workflow-engine/src/openspec-doctor.ts` | The engine pins the schema source, exact file closure, graph, and digests so a user schema or incomplete graph cannot redefine readiness. A cutover must preserve historical replay and cannot make this active change invalidate itself.                                                                                                                                                                                                                       |
| Planning path and artifact closure         | `planning-paths.ts`, `planning-contract.ts`, `managed-change-contract.ts`, `planning-transition.ts`, `ci-planning.ts`, `ci-sequence.ts`, `ci-archive.ts`                                                                     | Local and CI planning authority accept only an exact artifact grammar and reconstruct it from Git. New JSON cannot be added as an untracked convention or as task work; both live and historical validators must select the same schema generation.                                                                                                                                                                                                             |
| Immutable reports                          | `content-record-store.ts`, `report-store.ts`, `planning-report.ts`                                                                                                                                                           | Safe no-follow writes and digest verification are reusable, but the present full-payload digest intentionally treats metadata as identity. Investigation reuse needs a second semantic digest without weakening immutable provenance.                                                                                                                                                                                                                           |
| Adapter deny policy                        | `ai-adapter-policy.ts`, `ai-adapter-evaluation.ts`, `ai-adapter-cli.ts`, `workflow/ai-adapter-policy.json`                                                                                                                   | The deny policy prevents an undocumented direct subprocess bypass. Real launch must evolve this reviewed contract, preserve diagnostic evaluation, and keep executable construction out of repo-authored data.                                                                                                                                                                                                                                                  |
| Human-present signing and terminal state   | `maintainer-signer.ts`, `maintainer-grant.ts`, `maintainer-store.ts`                                                                                                                                                         | Controlling-TTY checks, eligible SSH signers, canonical envelopes, atomic reservation, and terminal cleanup are the established human-presence primitives. Collaboration degradation may reuse those primitives but must not inherit authority-path or commit authority.                                                                                                                                                                                        |
| Repository fingerprints and Git resolution | `git.ts`, `planning-lock.ts`, lifecycle/session stores                                                                                                                                                                       | Read-only review can prove that a governed repository projection did not change, not that a same-user process was cryptographically confined. Durable provider waits also cannot retain a process lock across CLI exit.                                                                                                                                                                                                                                         |
| Workflow test aggregation                  | `packages/workflow-engine/test/contracts.test.ts`, `session.integration.test.ts`, `packages/workflow-engine/package.json`                                                                                                    | `workflow-tests` executes only the two aggregators. A new standalone test file has no evidentiary value unless imported by one of them; planning-CI coverage must be wired into the registered suite.                                                                                                                                                                                                                                                           |
| Completion projection and check execution  | `lifecycle.ts`, `verification.ts`, `git-transitions.ts`, `task-projection.ts`, `handoff.ts`, `runner-resolution.ts`, `package-closure.ts`, `archive-transformation.ts`                                                       | The legacy path checks the implementation tree, writes checkbox/handoff into the real worktree, then checks again before exact staging. A detached-worktree probe proved that candidate Node entrypoints resolve but the package runner correctly rejects a `node_modules` symlink whose real dependency closure escapes the candidate root. The pulled-forward substrate therefore cannot pretend that an unsafe symlink is an isolated execution environment. |

The scope follows the unified Roadmap: T1.5 implements the first six vertical slices—contracts/fakes, investigation DAG and scanner, WHY projection, real read-only adapters and resumable propose, exact-tree plan review, and collaboration grants. One deliberately narrow projected single-pass completion/staging substrate is pulled forward to remove duplicate checks from the remaining T1.5 tasks. Later T2 changes still own same-session revision, cross-agent TDD and mechanical-transform execution, exact-diff AI review, crash-safe finalize recovery and commit transaction, pre-merge composition, and final command-surface migration.

## Goals / Non-Goals

**Goals:**

- Make engine/main/blind breadth evidence, full-blob WHY rationale, and an independent exact-plan challenge mandatory for investigation-first planning generations.
- Keep hard claims narrow: exact sealed terms were scanned; every observed hit was dispositioned; every required row exists and is fresh; review presence and binding are current. Preserve the soft status of semantic completeness, WHY truth, model identity, and review judgment.
- Introduce provider-neutral orchestration with built-in Codex and Claude read-only adapters, explicit actor and independence assurance, bounded invocation, and durable pause/resume.
- Preserve historical and in-flight planning validity during self-hosting, then make post-cutover downgrade to the legacy schema impossible for a new or revised plan.
- Let CI reconstruct every mechanical gate from Git and tracked compact evidence without provider credentials or local `.git` runtime objects.
- Retain the existing engine ownership of task scope, checks, completion, staging, commits, CI, and archive.
- Let the remaining T1.5 tasks finalize through one required-check execution over the exact implementation + checkbox + handoff projection, then stage those exact bytes while keeping managed commit separate.

**Non-Goals:**

- Implement alternate-agent code writing, cross-agent RED/patch/GREEN, mechanical-transform closure execution, task revision/resume, exact-diff AI review, crash-safe finalize recovery, commit transaction, or pre-merge coverage composition.
- Prove complete search vocabulary, complete semantic dependency graphs, genuine file reading, correct WHY explanations, or correct reviewer judgment.
- Claim cryptographic local model identity, adversarial same-OS-user containment, or absence of every unobservable Git-object-store mutation.
- Add a generic semantic proposal/admission engine, let an AI create or prioritize issues, or let review verdict replace executable checks.
- Add a new registered check or change `workflow/checks.json`; all T1.5 tests run under the existing workflow checks.

## Decisions

### 1. Deliver T1.5 as one change with six capability slices and a self-hosting revision

The implementation is one managed Roadmap unit with bounded task commits. Slices 1–6 first make the new contracts, degraded-mode grants, live/CI validators, migration transition, and monotonic activation executable while the governing T1.5 plan remains valid under the legacy schema. Only after that machinery is committed does T1.5 perform one managed planning revision through the new investigation and plan-review path. The final adoption task then exercises the migrated generation.

This avoids six user-visible lifecycle seams while keeping each RED/GREEN unit reviewable. Pulling revision, cross-agent implementation, mechanical transformation, full finalize, or pre-merge into this change was rejected because those already have ordered T2 owners and would prevent T1.5 from reaching a usable planning boundary. The narrow exception below removes the immediate duplicate-check cost without taking over those T2 guarantees.

T1.5 records all governed mutation classes during breadth scanning, but it does not execute mechanical retirement closure. Exact-byte closure over `live`/`prohibited` paths remains T2.4 behavior. This resolves the roadmap shorthand in favor of the detailed plan and prevents breadth evidence from making a false semantic-closure claim.

### 1A. Pull forward a projected single-pass finalize substrate, not full atomic finalization

After Task 1.1 is committed and before Task 2.1 starts, this same change adds `workflow finalize-task <session-id> --json` as a compatible shortcut over the existing completion authority. It is designed to save the second full check pass on every remaining T1.5 task without merging the separately parked scaffold or changing managed commit authority.

The transition runs under the existing exclusive session-operation lock and performs one pinned inspection:

1. Require an active session, unchanged HEAD/contract/policy/runner inputs, an empty real index, and an implementation diff exactly within `allowedPaths`.
2. Reconcile the immediate predecessor as the legacy completion path does; render checkbox and semantic-handoff bytes as a pure engine projection; and construct the exact prospective implementation + projection tree in a temporary index without changing the real index.
3. Lease only those engine-owned projection bytes into the locked current worktree as the check execution view. The implementation bytes and the already-pinned dependency installation stay in their current repository, so no external `node_modules` symlink, caller `NODE_PATH`, network install, or second unpinned dependency source is introduced.
4. Execute every current-task required check exactly once against that complete projected view, reject check-view mutation, and bind one prospective tree/fingerprint plus the pinned runner/check identities to the resulting evidence. If immediate-predecessor reconciliation is required, its independently authorized predecessor checks remain separate and do not count as executions of the current task's finalization checks.
5. On any caught ordinary failure before final application, compare-and-swap restore the exact pre-invocation projection bytes/modes, leave the real index and report pointers unchanged, remove temporary state, and keep the session active. External process death, machine loss, or an uncooperative check mutating state outside the governed projection is not claimed recoverable by this substrate.
6. After success, revalidate HEAD/session/contract/worktree/index/operation ownership, retain or apply exactly the checked projection bytes, install the already-verified temporary index as the real staged tree, prove staged tree equals checked tree, and emit a compatible check -> completion -> finish report chain. `workflow commit` remains the next independent command and MUST NOT rerun required checks.

The legacy `workflow check -> complete-task -> finish` sequence remains supported as a compatibility and recovery surface. This task does not add exact-diff AI review, revision/resume, a durable invocation journal, crash classification/idempotent recovery, a ref/commit transaction, or automatic commit. Those remain T2.3. CLI output must label the delivered assurance as projected single-pass with ordinary-failure rollback; the persisted reports remain schema-compatible with the legacy evidence chain, and neither surface may call the result crash-safe or fully atomic.

A detached temporary worktree remains the preferred eventual execution view, but the pre-plan probe rejected the naive dependency link at `workflow-typecheck` with `CHECK_RUNNER_UNAVAILABLE`: `runner-resolution.ts` and `package-closure.ts` intentionally require the real runner closure to stay inside the declared repository root. Task 1.2 therefore uses the locked current-repository execution lease above rather than weakening runner containment. T2.3 may replace that lease only after it proves a portable isolated dependency view or adds the durable journal required by an overlay.

### 2. Add `expense-app-v2` beside legacy `expense-app` and cut over by the governing plan parent's marker

Directly adding three mandatory artifacts to `expense-app` would invalidate T1.5 while it is implementing the validator. Presence-based opt-in would be downgradeable. The engine therefore gains a schema registry with two explicit IDs:

- `expense-app`: immutable legacy graph retained for historical and pre-cutover governing plans;
- `expense-app-v2`: investigation-first graph with `investigation.json`, `execution.json`, and `plan-review.json` in addition to the existing artifacts.

The versioned activation marker is `workflow/schemas/investigation-planning-v1.schema.json`. Its first reviewed introduction commit is the activation anchor. Validation derives activation from commit ancestry and the configured protected-base lineage, not merely from current file presence:

1. For historical task/archive replay, resolve the immutable governing `Change: <id>` / `Transition: plan` commit and the first activation anchor reachable in the replayed lineage.
2. A legacy generation is eligible only when it is provably an ancestor of the activation anchor, or when the replayed lineage contains no activation anchor at all.
3. For a planning introduction, evaluate the candidate plan parent and configured protected-base baseline directly; no prior plan commit for that change is required.
4. For a planning revision, resolve the previous immutable governing generation and evaluate the candidate parent plus configured protected-base baseline.
5. If activation is reachable from either applicable baseline, the candidate MUST declare `expense-app-v2` and satisfy every v2 artifact/gate. A missing/deleted marker in the current tree, omitted JSON, legacy selection, stale pre-activation branch, or ambiguous activation ancestry fails closed.

The original T1.5 plan commit has a parent without the marker, so early task commits remain replayable even after the candidate implementation introduces the marker. Once the new wrapper/reviewer is usable, an advanced `workflow propose <id> --migrate-legacy` transition runs investigation over the existing authored plan, adds the three structured artifacts and managed design section, changes `.openspec.yaml` to `expense-app-v2`, obtains PlanReview, and creates a normal planning revision. It records `legacyMigration: true`, so the system does not falsely claim that investigation preceded the earlier plan's cognition. Completed task checkboxes are preserved as engine projections.

The same implementation changes the project default to `expense-app-v2`. Later introductions and revisions cannot choose legacy even if a stale branch omits the marker, because activation reachability is monotonic. Archived/pre-activation generations remain replayable by their immutable governing commit. The marker and its activation anchor are part of the reviewed workflow contract closure and may be replaced only by a future explicit migration that defines monotonic predecessor/successor rules; deleting or renaming the file is a validation failure, never an automatic downgrade.

The v2 OpenSpec graph is:

```text
investigation (engine-owned)
  -> proposal
  -> specs + design
  -> tasks
  -> guard + execution (engine-validated strategy projection)
  -> plan-review (engine/provider-owned projection)

apply requires investigation + tasks + guard + execution + plan-review
```

OpenSpec still supplies authored-artifact instructions; `workflow propose` owns engine artifacts and calls the typed OpenSpec adapter only for the middle authored graph. Templates for engine-owned JSON explicitly route users back to `workflow propose`; their presence in the graph does not authorize prompt-authored evidence.

### 3. Track compact semantic evidence; keep transcripts and mutable refs outside the tree

The exact tracked set for v2 is:

```text
openspec/changes/<id>/
  .openspec.yaml
  proposal.md
  design.md
  investigation.json
  execution.json
  plan-review.json
  tasks.md
  guard.json
  specs/**/spec.md
```

`investigation.json` contains normalized intent, actor/role assignments, all accepted source contributions, effective and superseded terms, deterministic scan summaries/hits, group selectors/exceptions/dispositions, complete WHY rows, required evidence-node envelopes, current refs, and any used collaboration envelope. `execution.json` contains per-task strategy family, scopes, checks, behavior/transform contract references, exemptions, and whether execution enforcement is available or only declared for later T2. `plan-review.json` contains the immutable review projection, planning generation, component target, findings, challenges, dispositions, reviewer terms, intake candidates, coverage, assurance, and any used collaboration envelope.

Provider raw event streams, prompts, latency, retry data, local process IDs, and bearer/reservation state remain under the Git common directory. Semantic provider output that CI cannot regenerate is normalized into the tracked artifacts. CI re-runs deterministic scans and renderers and validates signed/structured semantic records; it never needs a local runtime object or provider credential.

`guard.json` remains task paths plus registered checks. Cross-agent roles, investigation, and review policy are not smuggled into task scope.

### 4. Introduce a two-digest evidence object store instead of stretching timestamped reports

New canonical evidence objects live under:

```text
<git-common-dir>/workflow-engine/investigations/
  objects/sha256/<prefix>/<digest>.json
  refs/<change-id>.json
  sessions/<investigation-id>.json
  invocations/<invocation-id>.json
```

The store reuses the existing no-follow, restrictive-mode, atomic-write, fsync, and digest-read patterns, but object identity is computed before runtime metadata is attached:

```text
nodeId = sha256(type + node schema + evaluator + policy
                + exact input digests + provenance parent nodeIds)

resultDigest = sha256(type + output schema + canonical semantic output)
```

Runtime metadata is stored beside the immutable envelope and excluded from both digests unless a reviewed policy declares it semantic. Downstream nodes record parent `resultDigest`s as semantic inputs and exact producing `nodeId`s as provenance.

Any exact input change creates a new `nodeId`. Propagation stops only when compatible evaluator, policy, node schema, and output schema identities produce the same `resultDigest`; the engine then writes a `ConvergenceRecord`. Reusing an unchanged descendant requires a `DescendantReuseProofNode` for every changed parent edge naming the descendant, old/new parent IDs, convergence record, shared result digest, and validator version. The old descendant is never rewritten to pretend that it consumed a new parent. Missing, incompatible, ambiguous, or partial proofs remain stale; recomputation is always permitted.

Mutable current refs advance through compare-and-swap under short operation locks. No lock or writable file descriptor survives CLI exit or a provider/human wait.

### 5. Use a binary-safe in-process scanner over the pinned Git tree

`tracked-tree-reader.ts` enumerates the pinned tree with NUL-delimited Git object metadata and reads blobs as buffers. `investigation-scanner.ts` applies fixed literal matching; it does not spawn `grep`/`rg`, use a shell, consult caller-controlled `PATH`, or scan the working tree.

V1 term kinds are `literal-content`, `literal-path`, `symbol`, and `config-key`. Values are 1–256 UTF-8 bytes with no NUL, newline, or control characters; arbitrary regex is rejected. Matching is case-sensitive in V1. Terms preserve all provenance and move through proposed, previewed, sealed, or audited-superseded states. Engine-floor terms cannot be superseded.

The engine floor is a deterministic projection, not an unconstrained hook. It records a fact-to-term derivation for every qualifying machine-readable input: explicit paths, symbols, and configuration keys in normalized intent; both old and new identifiers for a rename/removal/transformation; renamed or removed path basenames and stems available from a pinned diff; and reviewed generated/mirror counterparts of any derived subject. If any qualifying fact exists, omitting its required term or returning an empty floor fails validation. If none exists, the engine records the exact checked categories as `noDerivableFloorFacts`; that result does not count as a breadth contribution, and sealing still requires non-empty main and ordinary provider-independent survey contributions.

The code-owned V1 resource maxima are:

- at most 64 main terms, 64 survey terms, 32 reviewer terms, and 128 effective terms;
- at most 512 projected hits per term and 4,096 total current hits;
- at most 2 MiB per scanned text blob and 64 MiB total scanned blob bytes;
- at most 4,096 hit-disposition work items and 30 seconds of deterministic scan CPU time;
- binary, invalid-UTF-8, oversize, submodule, and otherwise skipped objects are recorded with exact path/object ID/reason rather than silently disappearing.

T1.5 does not add a free-standing investigation-policy JSON file. The code-owned limits are fixed for V1 so they are formatted, reviewed, and replayed with the engine source; a later authority-reviewed policy may lower but never exceed them. A broad proposal remains visible and unsealed until narrowed or superseded; it cannot allocate unbounded work. Zero-hit scans are first-class current nodes.

The scanner sees every tracked mutation class: `live`, `prohibited`, `generated`, `mirror`, `append-only`, `immutable`, and `historical-reference`. Classification affects grouping and later T2 closure policy, never visibility during T1.5 investigation.

### 6. Group deterministically, then require semantic disposition and exact-blob WHY

V1 creates conservative initial groups from term ID, nearest declared package/root, path class, extension, and reviewed generated/mirror relationship. A hit belongs to one selector result; explicit exceptions override a broad selector. Ambiguous overlap or uncovered hits fail closed and must split.

Agents submit a typed disposition for each group: `load-bearing`, `test-or-mirror`, `generated`, `incidental-reference`, or `irrelevant`, with rationale. Every current hit must have exactly one effective disposition. The engine does not infer semantic irrelevance merely from a directory name.

For each load-bearing file the engine produces a skeleton with path, full blob ID/digest/line count, relevant location, hit IDs, matched terms, and relationship field. It makes the complete pinned file available through the read-only manifest and accepts only typed caller answers for WHY, protected invariant, sharp reviewer question, and answer. The caller—not the engine—is the semantic author. A `readComplete` field is recorded only as an actor attestation.

The design projection is bounded by single markers:

```text
<!-- workflow:investigation-ledger:start v1 -->
... deterministic rendered ledger ...
<!-- workflow:investigation-ledger:end v1 -->
```

The engine owns both markers and all bytes between them. Authored bytes outside the region remain agent-owned. Missing/duplicate/nested markers, stale blob IDs, placeholders, omitted rows, or byte divergence fail validation.

### 7. Evolve the adapter policy into built-in capability profiles with fixed resolution

`workflow adapter evaluate` remains a read-only diagnostic; it now reports enabled providers, compatible capability profiles, resolver result, actual controls, and honest residuals. Launch is available only through lifecycle orchestration, never a generic adapter pass-through.

The reviewed provider registry is code-owned and initially contains `codex` and `claude`, each declaring `survey` and `plan-review` under `repository-read-only`. Repository policy may enable/disable those IDs and lower time/output/concurrency limits. It cannot add IDs, executable paths, argv, shell text, module paths, prompts, or result parsers.

Adapters resolve only reviewed platform candidates and canonicalize a symlink to its real executable. Initial macOS candidates include the ChatGPT-bundled Codex executable plus canonical Homebrew/application locations for Codex and Claude. The adapter verifies regular executable shape, records real path/file identity and `--version`, and probes required flags. It does not search caller `PATH`. A missing or incompatible candidate makes that provider unavailable rather than falling back to an arbitrary binary.

Codex uses a fixed non-interactive, ephemeral, read-only invocation with ignored user configuration, repository root, JSON events, and an engine-owned output schema. Claude uses fixed print/no-persistence structured output, an empty strict MCP configuration, disabled slash/browser surfaces, plan/read-only permission, and only reviewed read/search tools. Both receive a minimized, provider-specific environment and engine-owned prompt/schema files outside the worktree. Authentication remains user-level and therefore part of the documented soft containment boundary.

Every request/result envelope binds invocation ID, nonce, purpose, provider, actor/role assignment, capability profile, repository, baseline/tree, target, input-manifest digest, output schema, policy/evaluator versions, and limits. Timeout is 300 seconds, stdout/stderr plus normalized output is capped at 1 MiB, and at most two provider invocations run concurrently. A retry is an explicit resume action, not a hidden loop. Timeout, signal, spawn error, non-zero exit, malformed JSON, wrong nonce/target/manifest, excess output, or schema mismatch creates no successful evidence.

### 8. Resolve actor signals conservatively and assign independence relative to roles

Actor resolution collects every recognized signal before selecting an actor:

1. explicit `--actor` selection;
2. recognized runtime hints such as `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `AGENT`, or Codex sandbox markers;
3. controlling-TTY confirmation when neither source is sufficient.

Explicit selection determines the requested actor, but it does not erase contrary runtime evidence. If recognized signals name different providers, the transition enters `actor-resolution-required` with `ACTOR_IDENTITY_CONFLICT`; it cannot use the disputed identity to claim provider independence. A controlling human may correct the input or confirm a conservative self-declared actor. Non-conflicting evidence is pinned once per investigation/session with `self-declared`, `runtime-hint`, `adapter-assigned`, or future stronger assurance; no local hint is promoted to cryptographic model identity.

The scheduler evaluates pairwise constraints: on the ordinary path the blind surveyor MUST be provider-independent from the investigation author, and the plan reviewer MUST be provider-independent from the plan author. These defaults cannot be configured down to session-only or no independence. An eligible collaboration grant is the only path to a precisely labeled degraded contribution. The engine records principal-, provider-, session-only, or no independence. Two providers may alternate roles; the design does not require a unique provider per role.

### 9. Make `workflow propose` a durable checkpoint wrapper, not an interactive questionnaire

The engine cannot call back into the currently running chat to obtain terms or WHY answers. Main-agent terms, dispositions, and ledger answers are therefore typed caller contributions. The routine surface is:

```text
pnpm workflow propose <change-id> --intent <intent.json> [--actor <id>] --json
pnpm workflow propose <change-id> --resume --input <envelope.json> --json
pnpm workflow status <investigation-or-task-id> --json
```

The first call seals the blind request before it reads any main contribution, starts the blind provider worker, persists an `awaiting-main-terms` envelope, and returns. The caller can perform its own grep/read work while the blind survey runs. Resume accepts the typed contribution, deterministically advances whichever independent result is available, and returns the next required envelope. Later checkpoints cover grouping dispositions, WHY answers, challenge dispositions, and over-broad-term narrowing. A process never waits indefinitely for the caller or human.

Provider workers write only to invocation-specific runtime output and advance state through CAS. `waiting-for-provider`, `awaiting-main-terms`, `awaiting-ledger-answers`, `awaiting-challenge-dispositions`, `actor-resolution-required`, and `human-action-required` are durable states. Retry and resume retain current nodes and never replay completed provider calls merely because the wrapper exited.

Internal transition functions remain directly testable, but no routine standalone plan-review journey is added. After current challenge dispositions, `propose` invokes the existing managed plan transition and returns its plan commit/report. The wrapper never weakens `plan-commit`; it assembles its prerequisites.

### 10. Bind PlanReview to a conservative component manifest and immutable planning generation

`planningGenerationId` is the hash of the v2 schema identity, normalized `.openspec.yaml`, component-typed plan manifest, investigation base/tree and result digests, execution/guard contracts, requirement-clause identities, and applicable schema/canonicalizer/renderer/review-policy digests. It excludes PlanReview itself.

Component rules are explicit:

- proposal and delta specs: exact LF-normalized authored bytes;
- design: exact LF-normalized authored regions plus canonical investigation source and renderer/version for the managed region;
- tasks: exact task IDs/text/order/headings, with checkbox bytes normalized as engine-owned completion projection;
- guard, investigation, execution, and schema metadata: canonical JSON/structured digests bound to exact schema/policy versions;
- requirement clauses: repository path, exact requirement/scenario heading identity, and LF-normalized complete block digest;
- enumerated timestamps, latency, retry count, PID, UI order, and invocation display metadata: excluded.

There is no general whitespace folding, Markdown reformat equivalence, prose parsing, or model semantic comparison.

The plan transition report stores `planningGenerationId` and the exact current PlanReview node/digest; no new commit trailer is added because plan trailers remain exactly `Change` and `Transition: plan`. Task start resolves the latest governing plan commit, reconstructs that immutable generation, validates the exact review, and pins both identities in the task session and every derived check/completion/finish/commit report. It does not infer plan currentness from live `tasks.md`, whose checkboxes legitimately change after completion.

PlanReview records the component target, investigation baseline/dependencies, review policy, reviewer assignment, required/achieved independence, and observed invocation projection. Future implementation commits do not stale it. A changed/superseding plan generation, investigation dependency, canonicalizer/renderer/schema policy, review policy, or independence requirement does.

### 11. Keep PlanReview judgment advisory while mechanically projecting only reviewer terms

The exact-plan reviewer receives the complete component manifest and pinned read-only tree. The same invocation challenges missing scope, sibling mechanisms, weak WHY, unsupported invariants, contradictions, strategy/testability, and additional terms; no third duplicate scope/depth call runs.

Before/after checks bind the symbolic HEAD/ref/OID/tree, refs snapshot, exact index stages/tree, tracked/untracked/ignored worktree manifests, planning artifacts, and governed runtime inputs, allowing only the engine-owned invocation output path. Any observed drift rejects the report. This establishes equality only for the observed governed projection; it does not prove same-user process confinement, absence of unreachable object writes, or global filesystem immutability.

Every challenge requires a disposition. Suggestions do not. An advisory `reject` with all challenges dispositioned does not itself block, while a missing/stale report or undispositioned challenge does. A structured no-scope result must cite blind-survey, Scan/Hit/Group, or reviewer-observed `file:line` evidence.

`proposedTerms` is the only projected review field. The engine reads it directly from the immutable report, applies the same grammar and aggregate preview, and reopens only affected investigation nodes. The main agent never transcribes terms. Unsupported semantic proposal kinds are retained as prose/findings but cannot mutate lifecycle state. Current-correctness findings become challenges; independent findings become deduplicated intake candidates and never direct AI-authored issues.

### 12. Use a distinct one-use collaboration grant and preserve two degraded cases

V1 commands are:

```text
pnpm workflow maintainer collaboration-grant ... --json
pnpm workflow maintainer collaboration-inspect [grant-id] --json
pnpm workflow maintainer collaboration-revoke <grant-id> --json
```

The signed namespace is `expense-app.workflow.collaboration-grant.v1`; runtime state lives under `<git-common-dir>/workflow-engine/collaboration-grants/`. Grants reuse the controlling-input/output/error TTY check, trusted interactive SSH signer, canonical signing, atomic available/reserved/terminal store, expiry, and idempotent cleanup primitives. They do not use authority grant schemas, path eligibility, audit-tag namespace, sessions, commit trailers, or commit authority.

V1 grants are transition-specific, one-use, and at most 30 minutes. The envelope binds repository, canonical origin, change, optional task, baseline/target or intent digest, lifecycle phase, exact conflicting roles, available provider/caller, requested degraded form, reason, signer, issue/expiry time, and one use. The signed non-secret envelope is projected into the relevant tracked investigation/review evidence when consumed, so CI can verify it from Git using the trusted signer policy; no reusable bearer token enters the worktree.

Two degraded cases remain distinct:

1. The caller's provider adapter is callable but no alternate provider exists. A grant permits a fresh same-provider invocation, recorded `session-independent` and not provider-independent.
2. No provider adapter is callable, although the current caller can continue. A grant may permit a typed caller-supplied survey/review or direct human review for that exact transition. It is recorded with no provider/session independence and no engine-spawn claim. It still requires the structured survey or PlanReview artifact; the grant does not create evidence that never occurred.

Trust-critical policy may require direct human review instead of case 2. Neither grant form can suppress the floor, union scan, dispositions, WHY, challenge response, checks, task scope, freshness, managed commit, CI, or archive. All downstream reports retain the actual degraded level. This implements the user's availability requirement without pretending that human authorization recreates a missing second perspective.

### 13. Share one pure validator between live transitions and CI

Every replayable planning gate is implemented as a content-pure function over a canonical subject, reviewed policy, immutable tracked evidence, and resolved Git objects. Live commands and CI use different loaders but call the same validators.

CI does not launch Codex or Claude. It verifies schema and canonical bytes, planning-generation selection, term provenance and effective-set rules, deterministic scans, exactly-once hit coverage, blob-bound WHY rows, projection equality, evidence DAG identity/currentness/convergence proofs, PlanReview binding/challenges/dispositions, actor/independence representation, and collaboration signatures/use facts. Unknown schema versions, missing runtime-only semantic input, ambiguous parents, or unconstructable evidence fail closed.

All new tests are imported by `contracts.test.ts` or `session.integration.test.ts`; planning-CI tests are explicitly aggregated. Tests use deterministic fake adapters/processes and temporary synthetic repositories. They never require real provider credentials, network, or API databases. Real adapters receive contract/preflight tests and a manual local pilot only after fake-backed behavior is green.

### 14. Keep strategy declaration separate from later strategy execution

`execution.json` accepts `cross-agent-tdd`, `mechanical-transform`, or `direct-reviewed` plus the scopes/checks/contracts required by the detailed plan. T1.5 validates and reviews this declaration and exposes whether enforcement is `available` or `planned`. Existing managed task execution remains authoritative; T1.5 does not claim that a later execution strategy ran.

Delegation-skill mode letters are not persisted engine vocabulary. The current `claude-delegate` skill calls read-only review Mode A, adversarial TDD implementation Mode B, and mechanical work Mode C, while older planning notes used a different A/B mapping. The engine therefore records named capabilities and strategies (`plan-review`, `cross-agent-tdd`, `mechanical-transform`) so a skill can map its current UI labels without changing lifecycle evidence.

The self-hosting T1.5 revision uses the existing `direct-reviewed` strategy plus an exact `legacyBootstrap: establish-investigation-first-planning` qualifier for its remaining task, with RED-first tests and read-only review still required. The qualifier is accepted only for this named pre-T2 activation lineage and cannot become a fourth strategy family or a general behavioral-task exemption. T2.4 removes the qualifier path when cross-agent TDD and mechanical-transform execution become available.

## Risks / Trade-offs

- **[Risk] The new schema strands this active change or invalidates history** → Keep explicit legacy/v2 schema IDs, select by the governing plan parent's immutable marker, self-migrate T1.5 before activation completes, and test local plus historical CI replay.
- **[Risk] A plan selects legacy after cutover** → Derive activation from ancestry plus the configured protected baseline; require v2 after the first activation anchor even when a stale branch deletes or omits the marker.
- **[Risk] CI relies on unavailable local objects or transcripts** → Embed every non-reconstructable semantic fact in compact tracked artifacts; leave only raw events and mutable state in `.git`.
- **[Risk] A broad reviewer term creates a denial of service** → Use one fixed projector with code-capped per-source, per-term, total-hit, byte, and time budgets; retain rejected terms as audited proposals.
- **[Risk] Conservative grouping hides distinct semantics** → Start with small deterministic groups, require exact exceptions, fail ambiguous overlap, and let plan review split/promote groups.
- **[Risk] Plausible WHY is false** → Bind complete blobs and sharp questions, preserve actor authorship, run independent challenge and later tests, and never label field presence as proved understanding.
- **[Risk] Provider read-only flags are weaker than claimed** → Verify a broad governed projection before/after, use fixed read-only tool profiles, fail on observed drift, and retain explicit same-user/unobservable-write residuals.
- **[Risk] Executable discovery runs an attacker-controlled PATH entry** → Use only code-reviewed absolute candidates, canonicalize and probe them, record actual identity/version, and treat absence as provider unavailability.
- **[Risk] Background provider work corrupts mutable state after CLI exit** → Give each invocation one output directory and lease, use immutable results plus CAS refs, use short locks only, and recover/retry explicitly.
- **[Risk] Actor hints conflict and invert reviewer selection** → Collect all hints, pause on conflict, and never count disputed identity toward provider independence.
- **[Risk] The pulled-forward finalize shortcut is mistaken for crash-safe atomicity** → Name it and render CLI output as a projected single-pass substrate, promise exact rollback only for caught ordinary failures, keep persisted reports schema-compatible, keep `workflow commit` separate, retain the legacy sequence, and leave durable interruption recovery/commit transaction to T2.3.
- **[Risk] A candidate checkout silently consumes an external or stale dependency tree** → Do not relax runner-root containment or use a detached-worktree `node_modules` symlink; execute the narrow substrate against the current session-pinned repository/dependency installation and make any later isolated view prove its dependency source independently.
- **[Trade-off] Transition-specific grants can require two TTY actions on a degraded plan** → Prefer exact one-use binding in V1; healthy two-provider paths require zero grants, and later empirical data may justify a bounded session grant.
- **[Trade-off] Exact authored Markdown identity stales review on harmless edits** → Accept conservative replay cost rather than risk treating a negation or formatting-sensitive change as equivalent.
- **[Trade-off] Tracked hit/group evidence can grow** → Bound terms/hits, store raw transcripts only at runtime, and prefer compact selectors; correctness and remote replay take precedence over an opaque local-only report.

## Migration Plan

1. Plan-commit this legacy-schema T1.5 change with all tasks unchecked and no new workflow authority claim.
2. After Task 1.1 is committed with no active session, plan-commit this revision, implement the RED-first projected single-pass finalize substrate, and prove one check pass, exact checked/staged-tree equality, caught-failure restoration, no-staging-on-drift, separate commit, and legacy-path compatibility before using it on Task 2.1.
3. Implement RED-first evidence-node, canonicalization, provider/role, fake-adapter, and shared-validator contracts without enabling real launch or new planning gates.
4. Implement the binary-safe tracked-tree scanner, bounded term union, hit/group/disposition DAG, convergence/reuse validation, full-blob WHY records, and deterministic design projection behind non-default v2 contracts.
5. Evolve the strict adapter policy and diagnostic; add built-in Codex/Claude read-only adapters, durable invocation/pause/resume, actor conflict handling, and fake-backed mutation/failure tests. Run a non-authoritative local preflight; do not treat provider text as workflow authority.
6. Implement component canonicalization, planning generations, exact PlanReview, challenge/term projection, and the separate collaboration-grant lifecycle before any self-hosted migration may need a degraded path.
7. Integrate the same pure validators into live planning, task/report evidence, CI, and archive; implement explicit introduction/revision selection, historical legacy/v2 replay, the legacy migration transition, then the activation anchor and v2 default in that order. Prove that the activation task can finish under its already-pinned legacy session and that replay selects the correct generation on both sides of the anchor.
8. With no task session active, run the governed legacy-migration form of `workflow propose` for T1.5, fill the engine-produced main/WHY envelopes, obtain PlanReview (or an exact human-granted degraded result if an alternate is unavailable), switch the change to `expense-app-v2`, and create a normal planning revision. Preserve completed task projections and verify historical legacy replay.
9. Update executable guidance and Roadmap ownership notes, run all registered non-database checks, perform an independent exact-diff review of the trust core, run healthy and explicitly authorized degraded pilots as applicable, and archive through the existing transition after merge.

Rollback before v2 activation is an ordinary managed revert while legacy remains the default. After the marker/default and migrated plan merge, rollback must preserve historical schema selection and either keep v2 support or introduce a new explicit successor migration; deleting the marker or rewriting archived evidence is not a rollback mechanism. Collaboration grant state is revoked/terminally cleaned without deleting signed evidence.

## Open Questions

None. Artifact names, schema/cutover discriminator, tracked/runtime boundary, term and provider budgets, grouping baseline, actor conflicts, provider resolution, PlanReview canonicalization/currentness, grant scope and no-adapter degradation, wrapper checkpoints, the projected single-pass/ordinary-failure boundary, and remaining T1.5/T2 ownership are fixed by this design.
