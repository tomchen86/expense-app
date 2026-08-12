---
name: openspec-propose
description: Drive a new change through the repository-owned investigation-first planning checkpoints and produce governed proposal, design, spec, task, and guard artifacts.
license: MIT
compatibility: Requires the repository-pinned OpenSpec CLI and workflow engine.
metadata:
  author: openspec
  version: '1.0'
  generatedBy: '1.6.0'
---

Propose a new change through the repository-owned investigation-first planning wrapper.

The wrapper gathers evidence, obtains exact PlanReview, materializes the governed planning graph, and invokes the existing managed plan transition. `plan-commit` remains the underlying authority and is not a caller shortcut from this interface.

**Input**: The user request should include a kebab-case change name or enough detail to derive one.

**Steps**

1. If the request is unclear, ask one open-ended question before starting. Derive a stable change ID. Before creating durable state, verify a clean exact `work/<change-id>` branch and stop otherwise. Create a temporary normalized intent JSON file outside tracked planning artifacts. Its exact top-level keys are `schemaVersion`, `summary`, `explicitPaths`, `explicitSymbols`, `explicitConfigKeys`, and `renamePairs`, with no extras. Set `schemaVersion` to `1`. Use a non-empty string for `summary`. Use string arrays for `explicitPaths`, `explicitSymbols`, and `explicitConfigKeys`. Encode each rename pair with exactly the string keys `from` and `to`. Empty arrays are valid.

2. Start the durable wrapper:

   ```bash
   pnpm workflow propose <change-id> --intent <intent.json> [--actor <id>] --json
   ```

3. Read the returned `state`, `nextAction`, and `inputSchema` exactly. Preserve every returned binding value. Fill only the caller-owned contribution requested by that schema, using `work` and any `authoredInstructions` as constraints. Do not directly create or overwrite engine-owned `investigation.json`, `execution.json`, `plan-review.json`, or managed ledger fields.

4. Submit each typed checkpoint from a temporary envelope file:

   ```bash
   pnpm workflow propose <change-id> --resume --input <envelope.json> --json
   ```

   Repeat only for the newly returned checkpoint. Do not replay completed provider work, invent grant evidence, or bypass `human-action-required`. Inspect durable progress without mutation when needed:

   ```bash
   pnpm workflow status <investigation-or-task-id> --json
   ```

5. Planning is ready only when the wrapper returns `state: planning-complete` with its managed planning transition. Then start the selected task:

   ```bash
   pnpm workflow start <change-id> --task <task-id> --json
   ```

6. During implementation, inspect the versioned advisory command catalog and use its preferred projected single-pass path:

   ```bash
   pnpm workflow guide --json
   pnpm workflow finalize <session-id> --message "Imperative subject" --json
   ```

   The preferred transaction checks the implementation + checkbox + handoff prospective tree once, stages only that identical checked tree, and creates its managed commit without rerunning required checks. Only a caught ordinary failure receives exact projection rollback. Deprecated and compatible surfaces remain discoverable through the same catalog. New callers do not compose a separate finalize-task and commit path.

## Applicability and assurance boundaries

An investigation exemption changes planning applicability only: omitted scan and WHY claims become inapplicable, while PlanReview, task scope, checks, CI, and managed Git transitions remain. A task-execution exemption or strategy is separate and does not create an investigation exemption.

This interface does not prove semantic completeness, provider identity, same-user containment, reviewer judgment, or provider availability. It does not claim crash-safe or fully atomic finalization. A collaboration grant records an authorized degradation and does not recreate missing independence.

The governed propose surfaces use this wrapper. The separately governed explore-skill handoff remains outside this task and must not be described as adopted until successor managed work updates it.
