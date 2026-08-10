## Why

The Roadmap's [repository workflow adoption](../../../docs/ROADMAP.md#finish-repository-workflow-adoption) work can currently prove task scope and check evidence, but it cannot require an agent to survey the existing system broadly or explain the invariants behind the files it plans to change. Prior changes showed both failure modes: a narrow survey missed consumers, while a broad grep stopped at WHERE and never established WHY, so T1.5 makes investigation and an independent exact-plan challenge explicit, staleable lifecycle evidence before implementation begins.

## What Changes

- **BREAKING for newly proposed changes after cutover:** introduce a versioned investigation-first managed-change schema with `investigation.json`, `execution.json`, and `plan-review.json`; authoritative design materialization and plan commit require a sealed investigation, a current managed WHY projection, and a current exact-tree advisory review. Existing active and archived legacy changes remain valid under their declared legacy schema.
- Add an engine-owned Investigation Session: deterministically derive a non-removable search floor from every available typed path/symbol/config/rename/removal/mirror fact, accept typed main-agent terms with rationale and expected relationship, launch an ordinarily provider-independent blind survey, preview and seal the union, and scan the complete pinned Git-tracked tree without using task `allowedPaths` as a breadth boundary. A narrow structured, reviewed exemption exists only for eligible documentation, formatting, deterministic generated-projection, or time-boxed research changes that neither modify nor rely on non-trivial behavior.
- Require exactly-once semantic disposition for every current hit and exact-blob WHY/invariant/question/answer rows for every load-bearing group/file. The engine writes objective row skeletons and deterministic `design.md` projection bytes; agents remain the semantic authors, and the system makes no claim that their explanations are true.
- Add immutable content-addressed investigation evidence with separate provenance-sensitive `nodeId` and semantic `resultDigest`, precise dependency invalidation, explicit convergence/reuse proofs, and one content-pure validator shared by live transitions and CI replay.
- Evolve the evaluation-only adapter surface into a reviewed built-in Codex/Claude provider registry, typed read-only invocation envelopes, role-relative independence, explicit identity-assurance levels, mutation detection, bounded resources, and resumable provider-wait states. Keep policy evaluation as a diagnostic while repository configuration remains unable to supply arbitrary executables, shell fragments, or dynamic adapter code.
- Add exact-tree advisory PlanReview as the second scope/depth challenge. Hard gates cover presence, freshness, target binding, independence or an eligible human continuation grant, required severity/residual-risk/uncertainty structure, and challenge disposition; the AI verdict remains advisory. Reviewer `proposedTerms` enter one bounded deterministic term projector directly, while unrelated semantic suggestions cannot mutate lifecycle state or create issues.
- Add a collaboration-continuation grant, separate from authority maintenance, that only a human maintainer at the controlling TTY can issue to authorize an enumerated same-provider role conflict when no alternate provider is available. Ordinary provider results, granted same-provider results, caller-supplied typed results, and direct-human signed attestations retain distinct provenance while entering one content-bound validation contract. A grant cannot suppress investigation, review content, scope, checks, freshness, or managed Git authority, and degraded independence remains visible downstream.
- Ship a resumable `workflow propose` happy path that captures intent, runs main and blind investigation concurrently, materializes planning, obtains exact-plan review, and invokes the existing plan transition without adding a routine standalone review journey.
- Pull forward one narrow `projected single-pass finalize substrate` before the remaining T1.5 implementation: build the exact implementation + checkbox + handoff candidate projection, execute each current-task required check once, materialize and stage only the verified projection, retain `workflow commit` as a separate transition, and retain the legacy `check -> complete-task -> finish` path. This is ordinary-failure rollback, not full crash-safe atomic finalization.
- Publish one stable claim-ID/hardness registry for all user-visible assurance language. Make mutation classes visible to T1.5 breadth evidence, but leave cross-agent TDD implementation, mechanical transformation/retirement closure, mid-task revision, exact-diff AI review, durable finalize recovery/commit transaction, pre-merge coverage composition, and final surface migration to their ordered T2 changes.

Scope is limited to investigation-first planning, read-only provider orchestration, exact-plan review, degraded-planning grants, their OpenSpec/schema integration, CI-replayable validation, tests, executable workflow guidance, and the narrow single-pass completion/staging substrate. It does not change application behavior, database policy, remote merge authority, managed commit/archive authority, or the legacy completion interface.

Non-goals include proving term or dependency completeness, proving that an agent read or understood a file, cryptographically proving the underlying local model, claiming same-user adversarial containment, allowing an AI verdict to replace tests or Git facts, or accepting provider commands from an agent or repository-authored shell string.

## Capabilities

### New Capabilities

- `investigation-first-planning`: Change intent, engine/main/blind term union, bounded tracked-tree scanning, evidence grouping, and seal-before-design lifecycle behavior.
- `investigation-evidence-and-why`: Exactly-once hit disposition, full-file manifests, exact-blob WHY/invariant evidence, managed design projection, and precise evidence-DAG currentness.
- `managed-provider-orchestration`: Built-in provider registry/adapters, typed read-only invocation, actor assurance, role-relative independence, provider wait/resume, and bounded execution.
- `exact-plan-advisory-review`: Conservative component-typed plan targets, immutable planning generations, scope/depth challenge, direct reviewer-term projection, advisory verdict semantics, and challenge disposition.
- `collaboration-continuation-grant`: Human-present, exact-scope, short-lived authorization for visible single-provider degradation without correctness or workflow bypass.

### Modified Capabilities

- `openspec-workflow-integration`: Add the versioned investigation-first artifact graph and legacy-compatible cutover; require current investigation, managed projection, execution strategy, and exact-plan review at planning readiness, plan commit, and task preflight.
- `workflow-assurance`: Extend immutable evidence and CI replay to planning DAG nodes, two-digest identity, convergence/reuse proofs, exact review currentness, role/provenance representation, and shared content-pure validation.

## Impact

- Workflow lifecycle, planning transition, reports/object storage, path/schema contracts, CI replay, CLI dispatch, provider policy, actor resolution, and human-grant infrastructure under `packages/workflow-engine/`.
- A pre-T2 `workflow finalize-task` path that emits a compatible check/completion/finish evidence chain from one check pass and stages the exact verified tree while preserving the existing managed commit command and compatibility path.
- A parallel versioned project schema and templates under `openspec/schemas/`, followed by an explicit default-schema cutover that does not invalidate this change or archived legacy changes.
- Tracked planning artifacts for future investigation-first changes and immutable runtime objects/refs under the Git common directory.
- Built-in Codex and Claude read-only subprocess integration using reviewed fixed argv construction and structured result schemas; no new package dependency or caller-controlled executable lookup.
- Provider policy JSON, workflow artifact schemas, workflow-engine integration fixtures, contract/unit/integration/CI tests, `docs/WORKFLOW.md`, and command-governance guidance after the executable surface exists. Investigation scan limits remain code-owned in V1 so no new root policy or registered-format authority is required.
- No API, mobile, web, or destructive database tests are required. No `workflow/checks.json` change is planned; if implementation proves a new universal check is necessary, that separate definition change remains human-only authority maintenance.
