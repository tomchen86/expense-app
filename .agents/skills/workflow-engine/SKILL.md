---
name: workflow-engine
description: Route implementation, recovery, review, finalization, and archive work through the repository workflow engine after governed planning is ready.
license: MIT
compatibility: Requires the repository-owned workflow engine and a reviewed repository plan.
metadata:
  author: expense-app
  version: '1.0'
  generatedBy: repository-review
---

Use the repository workflow engine after a governed plan is ready. This skill
is a routing guide only: it does not authorize task preparation, protected
changes, completion, signing, publication, or any external effect.

## Routine task loop

1. Inspect the versioned command catalog before choosing a lifecycle surface:

   ```bash
   pnpm workflow guide --json
   ```

2. Open the selected or next incomplete task. Supply a Task Mandate only when
   the engine reports that the reviewed scope requires one:

   ```bash
   pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] --json
   ```

3. Implement only the task guard scope with RED then GREEN evidence. Read
   durable state without advancing it:

   ```bash
   pnpm workflow status <session-id> --json
   ```

4. When the task strategy or a persisted recovery phase pauses, resume only
   the exact returned transaction and preserve its bindings:

   ```bash
   pnpm workflow resume <session-id> --json
   pnpm workflow review-diff status <session-id> --json
   ```

5. Finalize through the preferred single transaction. Intermediate tasks run
   targeted checks. The engine adds the terminal full gate when this transition
   makes every task terminal:

   ```bash
   pnpm workflow finalize <session-id> --message "Imperative subject" --json
   ```

6. Archive only after every task commit is present on the configured base:

   ```bash
   pnpm workflow archive <change-id> --json
   ```

## Boundaries

- Never edit task checkboxes, stage files, or construct managed commits by
  hand.
- Never invent a mandate, grant, attestation, provider result, review verdict,
  or recovery binding.
- Human-only signing and protected Apply remain human-only. Explain the exact
  engine-returned checkpoint and wait for the maintainer.
- A status or guide result is advisory or observational until the governing
  command validates the exact current tree.
- Use targeted tests during implementation. Run the full gate once at the
  terminal exact tree and reuse it while that tree remains unchanged.
