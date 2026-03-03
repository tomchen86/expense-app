# Guide: Progress Tracking Logs for Human + AI Collaboration

_Last updated: March 3, 2026_

> Related guides:
>
> - Folder structure, naming, lifecycle: `docs/DOCUMENT_STRUCTURE_GUIDE.md`
> - Session workflow, quality gates, update triggers: `docs/UPDATE_CHECKLIST.md`

## Why this guide exists

This project keeps three different logs because they serve different audiences and time horizons:

1. `docs/logs/LOG-SESSION_YYYY_MM_DD*.md` for work-in-progress handoff
2. `docs/logs/COMMIT_LOG.md` for technical commit audit
3. `docs/CHANGELOG.md` for release and milestone outcomes

Using all three is recommended. The key is strict boundaries.

## Ownership and boundaries at a glance

| Document        | Audience                                          | Granularity                  | Include                                                                  | Must NOT include                                          |
| --------------- | ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `LOG-SESSION_*` | Human + AI collaborator stepping into active work | Session/day                  | Attempts, decisions, blockers, next action                               | Final release summary, detailed commit-by-commit audit    |
| `COMMIT_LOG.md` | Developers reviewing implementation traceability  | Per commit or pending commit | Intent, changed areas, verification commands/results, risk/rollback      | Long narrative session diary, roadmap planning text       |
| `CHANGELOG.md`  | Team/stakeholders consuming delivered outcomes    | Milestone/release            | User-visible or project-level validated outcomes (`Added/Changed/Fixed`) | Pending work, raw debug notes, AI conversation transcript |

## Single-source rule (anti-overlap)

Record each fact once, then reference it from other docs.

- Session-level context lives in `LOG-SESSION_*`.
- Commit-level verification details live in `COMMIT_LOG.md`.
- Release-level outcomes live in `CHANGELOG.md`.

If the same detail appears in two places, keep the fuller version in exactly one doc and shorten the other to a reference line.

## Canonical workflow

1. Start/continue work: write or update current `LOG-SESSION_...` entry.
2. Create commit: append one structured entry to `COMMIT_LOG.md`.
3. Merge/release milestone: summarize validated outcomes in `CHANGELOG.md`.

## Cross-reference convention (recommended)

Use a shared work id:

- Work id format: `WORK-YYYY-MM-DD-XX` (example: `WORK-2026-03-02-01`)
- Put it in session entries and commit log entries.
- In changelog, mention only if useful for internal traceability.

This gives fast human/AI handoff without duplicating narrative.

## Templates

### 1) Session log template (`docs/logs/LOG-SESSION_YYYY_MM_DD[_TOPIC].md`)

```md
# LOG-SESSION_YYYY_MM_DD[_TOPIC]

Date: YYYY-MM-DD
Work ID: WORK-YYYY-MM-DD-XX
Participants: Human + AI

## Scope

- What this session is trying to complete

## Context In

- Current branch/state
- Relevant active plan/status docs

## Work Performed

- Attempt 1: what was changed and why
- Attempt 2: what was changed and why

## Decisions

- Decision: ...
  - Reason: ...
  - Impact: ...

## Blockers / Risks

- Blocker or risk
- Mitigation or fallback

## Context Out (Next Handoff)

- Exact next command/task for next person/AI
- Files to inspect first
```

### 2) Commit log template (`docs/logs/COMMIT_LOG.md`)

```md
[<commit-hash>|PENDING] YYYY-MM-DD HH:mm
Title: <imperative summary>
Work ID: WORK-YYYY-MM-DD-XX
Authoring: Human | AI | Human+AI

Intent

- Problem being solved

Changes

- Key implementation points
- Main files touched

Verification

- `pnpm --filter api build` -> pass/fail
- `pnpm --filter api test -- <spec>` -> pass/fail

Risks / Rollback

- Known risk
- Safe rollback approach

Links

- Session log: docs/logs/LOG-SESSION_YYYY_MM_DD[_TOPIC].md
```

### 3) Changelog template (`docs/CHANGELOG.md`)

```md
## [YYYY-MM-DD] - <milestone or release title>

### Added

- Validated new capabilities only

### Changed

- Behavior changes that matter for users/team

### Fixed

- Validated bug fixes only
```

## Hard rules to prevent overlap

1. Do not put `[PENDING_COMMIT]` items in `CHANGELOG.md`.
2. Do not paste full test output in `CHANGELOG.md`; keep test details in `COMMIT_LOG.md`.
3. Do not write long "what happened this session" narratives in `COMMIT_LOG.md`; keep that in `LOG-SESSION_*`.
4. Do not copy `COMMIT_LOG.md` entries into `LOG-SESSION_*`; add one reference line instead.
5. Do not include unresolved TODOs in `CHANGELOG.md`; only landed and validated outcomes.

## Practical update checklist

Before ending a work session:

1. Session handoff updated in `LOG-SESSION_*`
2. Commit entry appended in `COMMIT_LOG.md` (or `PENDING` prepared)
3. `CHANGELOG.md` updated only if milestone/release-level value was delivered
