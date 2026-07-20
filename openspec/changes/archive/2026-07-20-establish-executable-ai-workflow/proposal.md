# Proposal: Establish Executable AI Workflow Assurance

## Intent

Replace reminder-driven AI workflow behavior with deterministic repository
guards while retaining a small, readable planning system.

## Scope

- Use OpenSpec specs and changes as the only normative requirement and active
  proposal/design/task artifacts.
- Add `guard.json` to each managed change for task path scope and check IDs.
- Build a repository-owned workflow CLI for Git preflight, session locks,
  immutable baselines, diff scope, verification evidence, and later completion.
- Establish `docs/ROADMAP.md` and `docs/CURRENT_AND_NEXT_STEPS.md` as the current
  project entry points.
- Keep the handoff semantic and compact; resolve commit relationships from Git
  change/task trailers instead of storing commit hashes in Markdown.
- Add controlled document mutation in later tasks.
- Retain the Spectra installation without invoking or integrating it.

## Non-Goals

- Removing Spectra files.
- Building a second `workflow/changes/` planning database.
- Trusting prompts, checkboxes, local hooks, or AI statements as proof.
- Launching a controlled AI adapter in the bootstrap slice.
- Deleting or moving legacy documentation during the additive migration.
- Creating `docs/WORKFLOW.md` before its separate review task.

## Success Criteria

- One canonical source exists for requirements, change design, and tasks.
- Unsafe session start fails before runtime state or an AI handoff is created.
- Active sessions pin repository and artifact facts and reject out-of-scope
  changes.
- Generated and immutable document policies become CI-verifiable in later
  tasks.
- Current-state updates never require a hash-only metadata commit.
- Spectra is absent from the execution path.

## Roadmap

See `docs/ROADMAP.md#establish-executable-ai-workflow-assurance`.
