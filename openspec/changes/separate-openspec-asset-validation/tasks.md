## 1. Managed Baseline

- [x] 1.1 Refresh the generated semantic handoff for this active change and prove the managed-document baseline is clean before implementation or any later planning revision.

## 2. Authority Transition Evidence

- [x] 2.1 Add a characterization regression for one validated authority commit that changes an existing required check definition while adding an unused definition, prove that only a later guard reference activates the new check, and establish an exact temporary old/new `workflow-format` contract for the planned asset-scope transition.

## 3. Tool-Plural OpenSpec Assets

- [x] 3.1 Follow RED -> GREEN -> REFACTOR to build the tool-neutral schema-v2 manifest, single-run Codex/Claude source generation, three-stage digest model, all-target delivery/closure rules, hardened forbidden-authority checks, deterministic generator, and formatter-independent read-only checker alongside the still-live Codex asset surface.
- [x] 3.2 Follow RED -> GREEN -> REFACTOR to atomically cut the live repository over from `codex-assets` to `openspec-assets`: switch CLI/integration consumers, make missing or renamed manifests fail closed in hooks and CI, migrate/regenerate Codex, Claude, `.agents`, and prompt targets, remove the old modules/home, update full-integration fixtures and regressions, and align active agent/workflow guidance without changing `workflow/checks.json`.

## Human-Only Authority Transition (Not an Executable Task)

After Tasks 1.1 through 3.2 are committed, merged, and reachable from the configured base, a human maintainer must use one fresh grant for exact path `workflow/checks.json`. The reviewed signed authority commit adds the non-destructive `openspec-assets` definition and replaces the broad `workflow-format` path with the exact human-maintained workflow JSON/schema scope. It must pass authority replay, merge through strict CI, and receive the required authority attestation. An agent may prepare and review the intended JSON diff but must not issue the grant, create the signed commit, or publish the audit/attestation evidence.

## Planned Post-Authority Revision (Not Yet Executable)

Only after the authority commit is merged and attested, revise these planning artifacts through `plan-commit` to add Task 4.1 and its guard policy. Task 4.1 will require `openspec-assets` plus the existing workflow and managed-document checks, change the temporary format assertion to the new definition only, refresh the semantic handoff, and provide the first managed/CI execution evidence for the newly registered check. Do not add or start that task while the check ID is absent from the registry.
