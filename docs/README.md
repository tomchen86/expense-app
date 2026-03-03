# Documentation — Entry Point

## Quick Start — What to Read First

| You want to...                                      | Read                                      |
| --------------------------------------------------- | ----------------------------------------- |
| Understand the project & run commands               | `../CLAUDE.md`                            |
| Check current progress / next steps                 | `status/STATUS-CURRENT_AND_NEXT_STEPS.md` |
| Know where to put a new document                    | `DOCUMENT_STRUCTURE_GUIDE.md`             |
| Run end-of-session checks                           | `UPDATE_CHECKLIST.md`                     |
| Write a session log, commit log, or changelog entry | `GUIDE-LOG_TRACKING.md`                   |
| Review the API development plan                     | `planning/PLAN-TDD_API_IMPLEMENTATION.md` |
| Understand the storage architecture                 | `architecture/STORAGE_STRATEGY.md`        |

## Project Status (qualitative)

- **Mobile app**: Feature-complete, local-only storage. Run `pnpm --filter mobile test` for current counts.
- **Database schema**: Complete (PostgreSQL, TypeORM, migrations, seeds).
- **API**: In progress — NestJS, mobile-first TDD. Run `pnpm --filter api test` for current counts.
- **Web**: Deferred until API is complete.

## Folder Structure

| Folder          | Contents                                                 |
| --------------- | -------------------------------------------------------- |
| `planning/`     | Active plans (`PLAN-*.md`), roadmap, methodology         |
| `status/`       | Living progress trackers (`STATUS-*.md`)                 |
| `logs/`         | Session logs, `COMMIT_LOG.md` (append-only)              |
| `features/`     | Feature-specific technical docs (testing, database, api) |
| `architecture/` | System design, ADRs, storage strategy                    |
| `archive/`      | Completed/obsolete docs (prefixed with `✅-`)            |

## Conventions (three meta-docs, each with a clear domain)

| Guide                         | Owns                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `DOCUMENT_STRUCTURE_GUIDE.md` | Folder structure, prefix naming, lifecycle, categories, immutability rules        |
| `UPDATE_CHECKLIST.md`         | Session workflow, quality gates, update triggers, git workflow                    |
| `GUIDE-LOG_TRACKING.md`       | Log templates (session, commit, changelog), anti-overlap rules, cross-referencing |

Each guide cross-references the other two. No content is duplicated across them.
