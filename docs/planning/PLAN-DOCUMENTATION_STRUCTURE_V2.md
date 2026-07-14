# Documentation Structure V2 — Adoption Plan

**Status**: Approved direction; non-destructive migration in progress
**Created**: 2026-07-14
**Last updated**: 2026-07-14
**Scope**: Documentation ownership, structure, and mutation policy

Implementation tasks live only in
`openspec/changes/establish-executable-ai-workflow/tasks.md`. This plan records
the approved destination and migration order without becoming another task
database.

## Objectives

- Give humans and AI one small entry point for current project context.
- Avoid duplicate requirements, plans, tasks, status, and execution history.
- Let AI read useful context broadly while controlling managed-document writes.
- Preserve legacy material until links and unique content have been audited.
- Keep `docs/WORKFLOW.md` planned but uncreated during bootstrap.

## Approved Decisions

1. `AGENTS.md` elevates RED → GREEN → REFACTOR to a repository principle.
2. `docs/ROADMAP.md` is the only current priority document.
3. `docs/CURRENT_AND_NEXT_STEPS.md` is the only current state and handoff.
4. Normative requirements live only in `openspec/specs/**`.
5. Proposal, design, delta specs, and tasks live only in one
   `openspec/changes/<change-id>/` directory.
6. Change-local `guard.json` contains machine scope/check policy only.
7. New session logs and manually maintained commit logs stop after adoption;
   Git plus workflow evidence provide technical history.
8. Architecture and feature references are automatically readable but updated
   only through explicit, reviewed scope.
9. Generated and append-only documents use structured commands rather than
   unrestricted AI edits.
10. Spectra remains installed but is not invoked, integrated, or authoritative.
11. `WORKFLOW.md` will eventually replace `UPDATE_CHECKLIST.md`, but it is a
    separate reviewed task and is not created now.

## Target Structure

```text
expense-app/
├── AGENTS.md
├── docs/
│   ├── README.md
│   ├── ROADMAP.md
│   ├── CURRENT_AND_NEXT_STEPS.md
│   ├── CHANGELOG.md
│   ├── ISSUE_LOG.md
│   ├── DOCUMENT_STRUCTURE_GUIDE.md
│   ├── WORKFLOW.md                    # planned, not created yet
│   ├── issues/
│   │   └── issues.yaml
│   ├── architecture/
│   │   └── decisions/
│   ├── features/
│   ├── guides/
│   ├── research/
│   │   └── <topic>.md
│   ├── templates/
│   └── archive/
│       └── legacy/
├── openspec/
│   ├── specs/<capability>/spec.md
│   └── changes/<change-id>/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.md
│       ├── specs/
│       └── guard.json
├── workflow/
│   ├── config.json
│   ├── checks.json
│   ├── document-policy.json
│   └── schemas/
└── <git-common-dir>/workflow-engine/
    ├── sessions/
    ├── reports/
    └── locks/
```

Existing `planning/`, `status/`, `logs/`, `template/`, and archive files remain
in place during additive migration. Their presence does not make them current
truth.

## Source-of-Truth Matrix

| Question                               | Canonical source                 | Mutation model                 |
| -------------------------------------- | -------------------------------- | ------------------------------ |
| What should happen next?               | `docs/ROADMAP.md`                | curated                        |
| What is active/completed/blocked/next? | `docs/CURRENT_AND_NEXT_STEPS.md` | generated projection           |
| How does development work?             | future `docs/WORKFLOW.md`        | reviewed process contract      |
| What must the system do?               | `openspec/specs/**`              | normative spec change          |
| Why/how is a feature changing?         | OpenSpec proposal/design/delta   | reviewed change artifact       |
| What are the executable tasks?         | change `tasks.md`                | evidence-authorized projection |
| What may a task change/run?            | change `guard.json`              | machine policy                 |
| How does the implementation work?      | `architecture/**`, `features/**` | curated                        |
| What uncommitted issues exist?         | `issues/issues.yaml`             | structured command             |
| What is the readable issue view?       | `ISSUE_LOG.md`                   | generated                      |
| What user outcome shipped?             | `CHANGELOG.md`                   | append-only                    |
| What happened in an execution?         | Git and workflow reports         | machine evidence               |
| What is historical?                    | `archive/**` and retained legacy | immutable/reference            |

## TDD Principle

`AGENTS.md` states:

- behavior changes and bug fixes follow RED → GREEN → REFACTOR;
- add or identify a test that fails for the intended reason first;
- implement the smallest passing change, then refactor while green;
- documentation, formatting, dependency-only, and time-boxed research work may
  be exempt when the reason is stated;
- database-writing API tests require a disposable `TEST_DATABASE_URL`.

Configured checks and workflow reports are evidence. Prose and checkboxes are
not.

## Roadmap Policy

`docs/ROADMAP.md` contains:

- project direction;
- Now / Next / Later order;
- active OpenSpec change links;
- explicit priority changes.

It excludes detailed tasks, chat/session history, volatile test counts, and
implementation diaries.

## Current and Next Policy

`docs/CURRENT_AND_NEXT_STEPS.md` contains only current handoff information:

- verified timestamp and baseline commit;
- active change/task/session;
- short current system picture with durable links;
- current blockers and decisions;
- most recent meaningful completion;
- exact next task and verification expectation.

History belongs in Git, reports, changelog, or immutable legacy archives. The
target renderer may preserve one explicitly maintained decisions field, but it
must not grow into another log.

## Requirements Migration

`docs/REQUIREMENT_LOG.md` is currently a migration inventory because
`openspec/specs/` has not yet absorbed its accepted requirements. Do not delete
or archive it yet.

Migration must:

1. classify current behavior separately from plans and priorities;
2. express accepted behavior as capability specs with requirements/scenarios;
3. update live issue, roadmap, architecture, and feature links;
4. validate coverage and anchors;
5. only then downgrade the old file to an immutable legacy pointer.

Priority/status/notes do not belong in normative specs.

## Architecture and Feature Context

AI should read relevant `docs/architecture/**` and `docs/features/**` before
planning or implementation. A session may pin selected paths and digests.

Updates remain explicit:

```text
changed code
  -> detect affected references or drift
  -> propose scoped document patch
  -> validate allowed paths/sections and expected digests
  -> human review
  -> apply approved patch
```

Scheduled or PR automation may report stale paths and missing coverage. It must
not silently generate/merge architecture prose, change normative specs, or mark
work complete.

## Issue Gateway

Target state:

```text
docs/issues/issues.yaml  -> deterministic renderer -> docs/ISSUE_LOG.md
```

Commands will add, update, close, archive, list, render, and validate issues by
schema. Direct `ISSUE_LOG.md` changes fail only after:

- every existing issue is seeded without data loss;
- stable ordering/format is defined;
- renderer equivalence is tested;
- Git/CI validation is active.

Until then its generated policy is explicitly `planned`, not a hard guarantee.

## Mutation Modes

| Mode            | Rule                                                          |
| --------------- | ------------------------------------------------------------- |
| generated       | modify structured source and render; never edit view directly |
| append-only     | append validated entries; preserve existing history           |
| curated         | read freely; update only through scoped reviewed work         |
| normative       | update through a reviewed OpenSpec change                     |
| change-artifact | controlled mutation inside the active change                  |
| reference       | may inform work but is not current truth                      |
| immutable       | no edits, moves, renames, or deletion without approval        |

`workflow/document-policy.json` starts in audit-only mode. A policy becomes
blocking only with executable validation, bypass tests, and CI enforcement.

## `WORKFLOW.md` Boundary

The future document will explain:

- TDD-first methodology;
- idea/issue → spec/change → session → implementation → evidence → archive;
- produced artifacts;
- soft guard versus CLI/hook/CI hard guard;
- OpenSpec ownership and Spectra non-participation;
- document/state ownership and update triggers.

It will link to executable commands and schemas rather than duplicate their
details. Before replacing `UPDATE_CHECKLIST.md`, retain valid safety rules,
remove stale commands/manual-log requirements, update live links, and obtain
explicit archival approval.

## Non-Destructive Migration Order

### Completed bootstrap

- Approved target structure and ownership matrix.
- Elevated TDD and disabled Spectra routing in `AGENTS.md`.
- Created root `ROADMAP.md` and `CURRENT_AND_NEXT_STEPS.md`.
- Rewrote `docs/README.md` and `DOCUMENT_STRUCTURE_GUIDE.md`.
- Added superseded warnings without deleting old roadmap/status/checklist.
- Added audit-only document policy.
- Created canonical OpenSpec workflow-assurance change artifacts.

### Next

1. Implement verification/completion evidence.
2. Seed issue source and prove lossless rendering.
3. Audit legacy requirements into OpenSpec capability specs.
4. Add architecture/feature context and drift commands.
5. Review/create `WORKFLOW.md`.
6. Update remaining live links.
7. Move or archive legacy files only with explicit approval.

Historical changelog/archive links should not be rewritten merely to appear
current. Redirect notices are preferred during migration.

## Adoption Criteria

- one canonical roadmap and current handoff exist;
- requirements exist only in capability specs after audited migration;
- active proposal/design/tasks exist only in OpenSpec changes;
- no new session/manual commit logs are required;
- architecture/feature context is readable but cannot be silently rewritten;
- generated, append-only, curated, normative, reference, and immutable policies
  are executable and CI-verifiable;
- `WORKFLOW.md` eventually becomes the only workflow overview;
- legacy files are not deleted or moved without explicit approval.
