# Executable AI Workflow Engine Plan

**Status**: Approved architecture; bootstrap kernel implemented
**Owner**: Project maintainer
**Created**: 2026-07-14
**Last updated**: 2026-07-14
**Implementation**: `packages/workflow-engine/`
**Command**: `pnpm workflow ...`

Implementation progress is tracked only in
`openspec/changes/establish-executable-ai-workflow/tasks.md`. This document
records stable architecture and rollout decisions; it is not a second task
tracker.

## Executive Decision

Build a small repository-owned policy enforcement point that treats AI,
prompts, Markdown, paths, configuration, stored booleans, and the worktree as
untrusted inputs.

Use the responsibility split below:

| Responsibility                                    | Owner                                         |
| ------------------------------------------------- | --------------------------------------------- |
| Normative current behavior                        | `openspec/specs/**`                           |
| Proposal, design, delta specs, tasks              | `openspec/changes/<change-id>/**`             |
| Task path scope and required check IDs            | change-local `guard.json`                     |
| Roadmap priority                                  | `docs/ROADMAP.md`                             |
| Current handoff                                   | `docs/CURRENT_AND_NEXT_STEPS.md`              |
| Git facts, sessions, locks, diff, checks, reports | workflow engine                               |
| Managed document writes                           | future Document Gateway                       |
| Fast local feedback                               | Codex/Git hooks delegating to the engine      |
| Merge authority                                   | CI plus branch protection                     |
| Spectra                                           | retained installation, not used or integrated |

Do not create `workflow/changes/`. OpenSpec is the one tracked change/task
format; the engine is an execution-assurance layer, not another SDD system.

## Control Inversion

```text
Prompt-led                              Executable

User                                    User
  -> prompt/skill                         -> workflow start
     -> AI                                   -> deterministic preflight
        -> repository changes                -> pinned session contract
                                                  -> bounded implementation
                                                  -> verification/report
                                                  -> hooks + CI
```

The AI may request a state transition, but only executable code may authorize
session start, task completion, archive readiness, staging, commit, or merge.

## Honest Security Boundary

The local CLI can guarantee that its own command refuses invalid input and does
not create a valid session after failed preflight. It cannot prevent an editor,
human, unrelated AI, direct shell, `--no-verify`, or a process with the same OS
permissions from changing files.

Therefore enforcement is layered:

1. preflight before a managed session;
2. revalidation before completion and commit;
3. optional controlled process/sandbox for write restriction;
4. authoritative CI recomputation before merge.

Local runtime files are evidence, not an unforgeable security token. CI must not
trust a local `passed: true` field without recomputing relevant facts.

## Repository Layout

```text
packages/workflow-engine/
├── src/
├── test/
├── package.json
└── tsconfig.json

workflow/
├── config.json
├── checks.json
├── document-policy.json
└── schemas/

openspec/
├── specs/<capability>/spec.md
└── changes/<change-id>/
    ├── proposal.md
    ├── design.md
    ├── tasks.md
    ├── specs/<capability>/spec.md
    └── guard.json

<git-common-dir>/workflow-engine/
├── locks/
├── sessions/
└── reports/
```

Runtime state never appears as an untracked worktree file.

## Change and Session Lifecycles

Tracked OpenSpec change state and local execution state are separate:

```text
Change:  proposal -> ready -> active -> complete -> archived
Session: created  -> active -> verifying -> passed -> committed
                       |           |
                       +-> aborted +-> failed
```

`tasks.md` is a human-readable projection. A checked box without matching
current evidence is invalid. After bootstrap, only `workflow complete-task` may
authorize a checkbox transition.

## Semantic Handoff and Git Traceability

`docs/CURRENT_AND_NEXT_STEPS.md` answers what a new maintainer or agent needs to
resume work: current change, current task, next task, focus, blockers, and
durable references. It does not persist a baseline, latest, or implementation
commit hash. A commit cannot contain its own final hash, and a follow-up commit
whose only purpose is recording the preceding hash adds no project value.

Managed commits instead carry semantic trailers:

```text
Change: establish-executable-ai-workflow
Task: 2.1
```

`workflow status` and later traceability commands may query Git trailers to
resolve `Task -> Commit -> PR -> Release` at runtime. Git remains the commit
history source; tracked Markdown never mirrors that history.

## Guard Contract

`guard.json` contains machine policy only:

```json
{
  "schemaVersion": 1,
  "changeId": "add-export-feature",
  "tasks": {
    "1.1": {
      "allowedPaths": ["apps/api/src/export/**"],
      "requiredChecks": ["api-build", "api-export-test"]
    }
  }
}
```

Rules:

- IDs use strict grammars.
- Paths are repository-relative exact paths or directory prefixes ending in
  `/**`.
- Absolute paths, traversal, unsupported glob syntax, and symlink escapes fail.
- Prefix matching is segment-aware.
- Check IDs must exist in `workflow/checks.json`.
- Check commands are fixed argv arrays; never use Markdown commands, a shell,
  interpolation, or `eval`.
- `tasks.md` and `guard.json` task IDs must match exactly.

## Session Contract

A successful `start` pins:

- real repository and Git common-directory paths;
- change and task IDs;
- exact branch, HEAD, and tree;
- proposal, design, delta spec, tasks, guard, config, and checks digests;
- allowed paths and required check IDs;
- creation timestamp and exclusive change lock.

Session creation uses an exclusive file and atomic temporary-file rename. A
failed guard must leave no valid session or retained lock created by that
attempt.

## Hard Guards

### Start

- repository identity resolves through Git;
- branch is attached, non-protected, and exactly `work/<change-id>`;
- staged, unstaged, and untracked state is empty;
- required OpenSpec artifacts and delta specs exist;
- task IDs, policy paths, and check IDs validate;
- selected task is incomplete;
- no active change lock exists;
- persisted session is re-read and verified.

The command never stashes, resets, deletes, rebases, or absorbs existing work.

### Check and Completion

- branch and HEAD still match the baseline;
- workflow artifact digests are unchanged;
- stored session scope matches the current pinned contract;
- all changed and untracked paths belong to the selected task;
- required checks pass under current configuration;
- destructive API checks have an explicitly disposable database;
- verification evidence matches the exact diff being completed;
- document mutation policies pass.

### Commit and Merge

- a current passing finish report exists;
- staged paths equal the verified set;
- commit includes exact machine-readable `Change:` and `Task:` trailers;
- current-state documents contain semantic identifiers rather than commit
  hashes;
- hooks delegate to the engine rather than copy logic;
- CI recomputes authoritative evidence from the PR base/head;
- branch protection requires CI.

Hooks remain bypassable local feedback. CI is the final hard boundary.

## Document Mutation Boundary

`workflow/document-policy.json` declares:

- `generated`: mutate structured source and render deterministically;
- `append-only`: append validated entries without changing history;
- `curated`: explicitly scoped, reviewed semantic edits;
- `normative`: reviewed OpenSpec specification changes;
- `change-artifact`: controlled active-change mutation;
- `reference`: readable but never workflow truth;
- `immutable`: historical content cannot change.

The policy is currently audit-only. Do not claim hard protection for a mode
until its command, validator, bypass tests, and CI enforcement exist.

## Database Safety

API tests may truncate or drop their configured PostgreSQL database. Before any
destructive check, the engine will:

- require `TEST_DATABASE_URL` rather than accept a fallback;
- require `WORKFLOW_DISPOSABLE_DATABASE=1` as explicit operator confirmation;
- parse the URL without shell evaluation;
- require a database-name token such as `test`, `ci`, `tmp`, `temp`,
  `disposable`, or `ephemeral`;
- reject development, shared, staging, and production identities;
- reject equality with the development `DATABASE_URL`;
- record only a redacted database identity.

## Command Surface

Implemented bootstrap commands:

```bash
pnpm workflow doctor [--json]
pnpm workflow validate-change <change-id> [--json]
pnpm workflow start <change-id> --task <task-id> [--json]
pnpm workflow status [session-id] [--json]
pnpm workflow check <session-id> [--json]
pnpm workflow abort <session-id> --reason "..." [--json]
```

Planned commands after evidence contracts are implemented:

```bash
pnpm workflow complete-task <session-id>
pnpm workflow finish <session-id>
pnpm workflow commit <session-id> --message "..."
pnpm workflow ci
```

Stable exit classes are usage `2`, guard `10`, lock conflict `11`, unsafe
environment `12`, verification `13`, and stale/tampered state `14`.

## Spectra and OpenSpec Boundary

- Do not invoke Spectra commands, skills, state, or adapters.
- Keep `.spectra.yaml`, `.agents/skills/spectra-*`, and `.agents/README.md`
  unless the maintainer separately requests removal.
- Read OpenSpec artifacts directly as canonical tracked input.
- An OpenSpec CLI may perform extra authoring validation but cannot authorize
  execution.
- Do not write runtime state under `openspec/`.

## Rollout

1. Bootstrap: contract validation, start/check/abort kernel, disposable Git
   tests.
2. Verification: allowlisted checks, database safety, redacted evidence.
3. Completion: immutable reports, diff digest, `complete-task`, finish, commit.
4. Documents: issue gateway, generated status, reviewed curated refresh.
5. Enforcement: hook delegation and CI recomputation.
6. Controlled AI: process adapter and filesystem restrictions only after the
   preceding boundaries are stable.

Emergency overrides must be reviewed, attributed, timestamped, reasoned, and
visible to CI. There is no silent `SKIP_WORKFLOW=1` design.

## Bootstrap Result and Next Slice

The one-time bootstrap exception is recorded in the canonical change design and
tasks. Typecheck, ESLint, nine node tests, change validation, diagnostics, and a
real protected-branch refusal passed.

Next is canonical task `2.1`:

1. run allowlisted check IDs as fixed argv arrays;
2. enforce disposable database policy;
3. record redacted check evidence;
4. add command-injection and unsafe-database regressions.

Do not start an AI adapter, hook, document renderer, or commit wrapper before
the verification/completion boundary is reviewable.
