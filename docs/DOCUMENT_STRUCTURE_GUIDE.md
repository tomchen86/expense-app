# Document Structure Guide

_Last updated: July 14, 2026_

## Purpose

Keep project knowledge small, navigable, and enforceable without duplicating
requirements, tasks, current state, or execution history.

## Canonical Structure

```text
docs/
├── README.md
├── ROADMAP.md
├── CURRENT_AND_NEXT_STEPS.md
├── CHANGELOG.md
├── ISSUE_LOG.md
├── DOCUMENT_STRUCTURE_GUIDE.md
├── WORKFLOW.md                 # planned; do not create in bootstrap
├── issues/                     # structured issue source
├── architecture/               # curated system-wide design
│   └── decisions/              # append-only ADRs
├── features/                   # curated implementation reference by domain
├── guides/                     # stable how-to material
├── research/                   # one background topic per <topic>.md
├── templates/                  # reusable document templates
└── archive/                    # immutable historical material

openspec/
├── specs/<capability>/spec.md  # normative current behavior
└── changes/<change-id>/        # proposal, design, delta specs, tasks, guard

workflow/                       # executable policy/configuration, no plans
└── ...
```

Existing `docs/planning/`, `docs/status/`, `docs/logs/`, and `docs/template/`
directories remain in place during non-destructive migration. Their presence
does not make them canonical.

## Source-of-Truth Matrix

| Question                                      | Source of truth                                                   |
| --------------------------------------------- | ----------------------------------------------------------------- |
| What should happen next?                      | `docs/ROADMAP.md`                                                 |
| What is active, completed, blocked, and next? | `docs/CURRENT_AND_NEXT_STEPS.md`                                  |
| What must the system do?                      | `openspec/specs/**`                                               |
| Why and how is a change being made?           | `openspec/changes/<change-id>/proposal.md` and `design.md`        |
| What are the executable tasks?                | `openspec/changes/<change-id>/tasks.md`                           |
| What may each task change and run?            | `openspec/changes/<change-id>/guard.json`                         |
| How does the implemented system work?         | `docs/architecture/**` and `docs/features/**`                     |
| What is the runtime evidence?                 | Git plus workflow sessions/reports under the Git common directory |

There is no `workflow/changes/` planning tree. Runtime state never belongs in
tracked Markdown.

## Mutation Policies

| Class           | Rule                                                                          | Typical paths                                                        |
| --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Generated       | Update structured source, then render; never edit the view directly           | `ISSUE_LOG.md`, eventually `CURRENT_AND_NEXT_STEPS.md`               |
| Append-only     | Add validated entries; never rewrite prior history                            | `CHANGELOG.md`, accepted ADRs                                        |
| Curated         | Read freely; update only in explicitly scoped and reviewed work               | `ROADMAP.md`, `architecture/**`, `features/**`, future `WORKFLOW.md` |
| Normative       | Modify through a reviewed OpenSpec change                                     | `openspec/specs/**`                                                  |
| Change artifact | Mutate through the active change lifecycle; task completion requires evidence | `openspec/changes/**`                                                |
| Reference       | May inform work but is never current truth                                    | `research/**`, `ai-responses/**`, retained Spectra files             |
| Immutable       | Do not edit, rename, or delete without explicit maintainer approval           | `archive/**`, historical logs and reports                            |

The Document Gateway and CI enforcement are being implemented incrementally.
Until a policy is blocking, its status must be described as advisory or
audit-only rather than claimed as a hard guarantee.

## Document Creation Rules

1. Prefer updating the canonical document over creating another tracker.
2. Put normative behavior in an OpenSpec spec, not in a roadmap or issue.
3. Put proposal, design, and tasks in one OpenSpec change directory.
4. Put machine scope and check IDs in `guard.json`; do not repeat prose tasks.
5. Put current handoff facts only in `CURRENT_AND_NEXT_STEPS.md`; history belongs
   in Git, reports, changelog, or immutable archives.
6. Put reusable technical explanations under `architecture/`, `features/`, or
   `guides/` according to scope.
7. Put investigation notes at `docs/research/<topic>.md` and label assumptions.
8. Do not create new per-session logs or manually maintained commit logs.
9. Do not create `WORKFLOW.md` until its content is reviewed as a separate task.

## Non-Destructive Migration

- Create and link new canonical entry points first.
- Add a superseded notice to old live documents without deleting their content.
- Migrate accepted requirements before downgrading `REQUIREMENT_LOG.md` to a
  historical inventory.
- Seed structured issue data and prove lossless rendering before making
  `ISSUE_LOG.md` generated-only.
- Update live references before moving any historical document.
- Never rewrite historical links inside immutable changelog/archive snapshots
  merely to make them look current.

The detailed adoption sequence lives in
`planning/PLAN-DOCUMENTATION_STRUCTURE_V2.md` until the future `WORKFLOW.md` is
approved.
