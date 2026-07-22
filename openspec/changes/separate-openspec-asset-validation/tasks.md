## 1. Managed Baseline

- [x] 1.1 Refresh the generated semantic handoff for this active change and prove the managed-document baseline is clean before implementation or any later planning revision.

## 2. Authority Transition Evidence

- [x] 2.1 Add a characterization regression for one validated authority commit that changes an existing required check definition while adding an unused definition, prove that only a later guard reference activates the new check, and establish an exact temporary old/new `workflow-format` contract for the planned asset-scope transition.

## 3. Tool-Plural OpenSpec Assets

- [x] 3.1 Follow RED -> GREEN -> REFACTOR to build the tool-neutral schema-v2 manifest, single-run Codex/Claude source generation, three-stage digest model, all-target delivery/closure rules, hardened forbidden-authority checks, deterministic generator, and formatter-independent read-only checker alongside the still-live Codex asset surface.
- [x] 3.2 Follow RED -> GREEN -> REFACTOR to atomically cut the live repository over from `codex-assets` to `openspec-assets`: switch CLI/integration consumers, make missing or renamed manifests fail closed in hooks and CI, migrate/regenerate Codex, Claude, `.agents`, and prompt targets, remove the old modules/home, update full-integration fixtures and regressions, and align active agent/workflow guidance without changing `workflow/checks.json`.

## Human-Only Authority Transition (Completed Outside the Task Lifecycle)

After Tasks 1.1 through 3.2 were committed, merged, and reachable from the configured base, a human maintainer used one fresh grant for exact path `workflow/checks.json`. The reviewed signed authority commit added the non-destructive `openspec-assets` definition and replaced the broad `workflow-format` path with the exact human-maintained workflow JSON/schema scope. It passed authority replay and strict CI, merged, and received the required authority attestation. Those human-only actions remain outside the executable task lifecycle.

## 4. Registered Asset Validation Activation

- [x] 4.1 Activate the registered `openspec-assets` check through the managed lifecycle: require it alongside the existing workflow and managed-document checks, narrow the temporary `workflow-format` contract assertion to the new definition only, normalize reviewed mirror materialization to the order-independent two-pass form already used for final assets, remove the three unused OpenSpec asset alias exports and the implementation-coupled formatter call-count assertion identified in post-merge review, refresh the semantic handoff, and capture the first managed and CI evidence for the registered check.
