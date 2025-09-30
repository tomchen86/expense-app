# Document Structure Guide

_Last updated: September 30, 2025_

## Purpose

This guide defines the organizational structure and naming conventions for all documentation in this project. It uses a **hybrid approach** combining:

- **Category-based organization** (planning, status, logs, features, architecture)
- **Feature-based grouping** within categories
- **Prefix-based naming** for document lifecycle management

## File Naming Conventions

### Prefixes by Document Type

| Prefix       | Status      | Purpose                               | Example                           | Lifecycle                           |
| ------------ | ----------- | ------------------------------------- | --------------------------------- | ----------------------------------- |
| `PLAN-`      | Active      | Planning document for work to be done | `PLAN-E2E_TESTING.md`             | Created before work starts          |
| `✅-PLAN-`   | Complete    | Completed planning document           | `✅-PLAN-DATABASE_SCHEMA.md`      | Renamed when work is done           |
| `STATUS-`    | Active      | Current progress/state tracking       | `STATUS-E2E_IMPLEMENTATION.md`    | Living document, updated frequently |
| `✅-STATUS-` | Complete    | Final status snapshot                 | `✅-STATUS-E2E_IMPLEMENTATION.md` | Renamed when work is complete       |
| `LOG-`       | Append-only | Historical record of sessions/work    | `LOG-SESSION_2025_09_30.md`       | Created per session, never modified |
| `GUIDE-`     | Reference   | How-to instructions                   | `GUIDE-TESTING_SETUP.md`          | Updated as process evolves          |
| None         | Reference   | Feature/technical documentation       | `DATABASE_SCHEMA.md`              | Updated as features evolve          |

### Document Lifecycle

```
1. Planning Phase:
   PLAN-E2E_TESTING.md (created)

2. Work Starts:
   STATUS-E2E_IMPLEMENTATION.md (created to track progress)

3. During Work:
   LOG-SESSION_2025_09_30.md (created each work session)
   STATUS-E2E_IMPLEMENTATION.md (updated with progress)

4. Work Complete:
   ✅-PLAN-E2E_TESTING.md (renamed, moved to archive/)
   ✅-STATUS-E2E_IMPLEMENTATION.md (renamed, moved to archive/)
   Feature docs remain active (e.g., E2E_TESTID_MAPPING.md)
```

## Directory Structure (Hybrid Organization)

```
docs/
├── planning/                    # All planning documents (by category)
│   ├── PLAN-E2E_TESTING.md
│   ├── PLAN-API_ENDPOINTS.md
│   ├── ROADMAP.md
│   └── TDD_METHODOLOGY.md
│
├── status/                      # Current state snapshots (by category)
│   ├── STATUS-E2E_IMPLEMENTATION.md
│   ├── STATUS-API_PROGRESS.md
│   └── STATUS-MOBILE_TEST_COVERAGE.md
│
├── logs/                        # Historical records (by category)
│   ├── COMMIT_LOG.md           # Technical commit details
│   ├── LOG-SESSION_2025_09_30.md
│   └── LOG-SESSION_2025_09_29.md
│
├── features/                    # Feature-specific docs (by feature)
│   ├── testing/
│   │   ├── MOBILE_UNIT_TESTS.md
│   │   ├── MOBILE_INTEGRATION_TESTS.md
│   │   ├── E2E_TESTID_MAPPING.md
│   │   └── API_TEST_COMPREHENSIVE_SUMMARY.md
│   ├── database/
│   │   ├── DATABASE_SCHEMA.md
│   │   └── MIGRATION_GUIDE.md
│   └── api/
│       ├── API_ENDPOINTS.md
│       └── AUTHENTICATION.md
│
├── architecture/                # System design docs (by category)
│   ├── ARCHITECTURE.md
│   ├── STORAGE_STRATEGY.md
│   └── ARCHITECTURE_DECISION_RECORDS.md
│
├── archive/                     # Completed/obsolete docs (by category)
│   ├── ✅-PLAN-EXPO_ROUTER_MIGRATION.md
│   ├── ✅-STATUS-PHASE_1.md
│   └── ✅-PLAN-DATABASE_DESIGN.md
│
└── CHANGELOG.md                 # High-level user-facing changes (optional)
    COMMIT_LOG.md → logs/       # Detailed technical changes (moved)
```

## When to Update Which Documents

### Always Update

| Document             | Purpose                  | Trigger                    | Location       |
| -------------------- | ------------------------ | -------------------------- | -------------- |
| `logs/COMMIT_LOG.md` | Technical commit details | Every commit               | `docs/logs/`   |
| `STATUS-*.md`        | Current progress         | Work progress on that task | `docs/status/` |

### Conditional Updates

| Category         | Document                           | Purpose            | Trigger                 | Location                  |
| ---------------- | ---------------------------------- | ------------------ | ----------------------- | ------------------------- |
| **Planning**     | `PLAN-*.md`                        | Task/feature plans | Creating new work plan  | `docs/planning/`          |
| **Planning**     | `ROADMAP.md`                       | Phase sequencing   | Roadmap/scope changes   | `docs/planning/`          |
| **Status**       | `STATUS-*.md`                      | Progress tracking  | Work starts on plan     | `docs/status/`            |
| **Logs**         | `LOG-SESSION_*.md`                 | Session summary    | End of work session     | `docs/logs/`              |
| **Features**     | Feature docs                       | Technical details  | Feature implementation  | `docs/features/[domain]/` |
| **Architecture** | `ARCHITECTURE.md`                  | System design      | Cross-app changes       | `docs/architecture/`      |
| **Architecture** | `ARCHITECTURE_DECISION_RECORDS.md` | ADR log            | Architectural decisions | `docs/architecture/`      |

### Never Modify (Archive Only)

| Document Type                          | Action                                  |
| -------------------------------------- | --------------------------------------- |
| Archived plans (`✅-PLAN-*.md`)        | Leave untouched in `docs/archive/`      |
| Archived status (`✅-STATUS-*.md`)     | Leave untouched in `docs/archive/`      |
| Past session logs (`LOG-SESSION-*.md`) | Never modify, create new log            |
| Closed ADRs                            | Append new ADR, don't edit past entries |

## Document Categories Explained

### 1. Planning (`docs/planning/`)

**Purpose**: Documents describing work to be done

**What goes here**:

- `PLAN-[FEATURE].md` - Detailed implementation plans
- `ROADMAP.md` - High-level project roadmap
- `TDD_METHODOLOGY.md` - Development approach docs

**Lifecycle**:

- Created before work starts
- Rarely modified once work begins
- Renamed with ✅ prefix and moved to `archive/` when complete

### 2. Status (`docs/status/`)

**Purpose**: Living documents tracking current progress

**What goes here**:

- `STATUS-[FEATURE]_IMPLEMENTATION.md` - Current progress on active work
- `STATUS-[PHASE].md` - Phase-level progress tracking

**Lifecycle**:

- Created when work starts
- Updated frequently during work
- Renamed with ✅ prefix and moved to `archive/` when work is complete

### 3. Logs (`docs/logs/`)

**Purpose**: Append-only historical records

**What goes here**:

- `LOG-SESSION_YYYY_MM_DD.md` - Session work summaries
- `COMMIT_LOG.md` - Detailed technical commit history

**Lifecycle**:

- Created per session/commit
- **Never modified** after creation
- Never archived (logs are permanent history)

### 4. Features (`docs/features/`)

**Purpose**: Feature-specific technical documentation

**What goes here**:

- `testing/` - Test documentation
- `database/` - Database schema and migrations
- `api/` - API endpoints and contracts
- `mobile/` - Mobile app specific docs

**Lifecycle**:

- Created when feature is implemented
- Updated as feature evolves
- Rarely archived (these are living reference docs)

### 5. Architecture (`docs/architecture/`)

**Purpose**: System-wide design decisions

**What goes here**:

- `ARCHITECTURE.md` - System overview
- `STORAGE_STRATEGY.md` - Data persistence approach
- `ARCHITECTURE_DECISION_RECORDS.md` - ADR log

**Lifecycle**:

- Updated when architectural changes occur
- ADRs are append-only
- Never archived

### 6. Archive (`docs/archive/`)

**Purpose**: Completed or obsolete documentation

**What goes here**:

- Completed plans (`✅-PLAN-*.md`)
- Completed status docs (`✅-STATUS-*.md`)
- Outdated/superseded documentation

**Lifecycle**:

- Files moved here when work is complete
- **Never modified** once archived
- Kept for historical reference

## Naming Examples

### Good Names

```
✅ docs/planning/PLAN-E2E_TESTING.md
✅ docs/status/STATUS-E2E_IMPLEMENTATION.md
✅ docs/logs/LOG-SESSION_2025_09_30.md
✅ docs/features/testing/MOBILE_UNIT_TESTS.md
✅ docs/archive/✅-PLAN-DATABASE_SCHEMA.md
✅ docs/archive/✅-STATUS-PHASE_2.md
```

### Bad Names

```
❌ docs/E2E_IMPLEMENTATION_STATUS.md (no prefix, wrong location)
❌ docs/planning/DATABASE_PLAN.md (no PLAN- prefix)
❌ docs/SESSION_SUMMARY_2025_09_30.md (no LOG- prefix, wrong location)
❌ docs/archive/PLAN-OLD_FEATURE.md (not marked as complete with ✅)
```

## Migration Rules

When reorganizing existing documentation:

1. **Add prefix** to documents missing them
   - `PHASE_2_API_DEVELOPMENT_PLAN.md` → `PLAN-PHASE_2_API_DEVELOPMENT.md`

2. **Move to correct category**
   - `E2E_IMPLEMENTATION_STATUS.md` → `status/STATUS-E2E_IMPLEMENTATION.md`
   - `SESSION_SUMMARY_*.md` → `logs/LOG-SESSION_*.md`

3. **Archive completed work**
   - `planning/PLAN-DATABASE_SCHEMA.md` → `archive/✅-PLAN-DATABASE_SCHEMA.md`
   - `status/STATUS-DATABASE_IMPLEMENTATION.md` → `archive/✅-STATUS-DATABASE_IMPLEMENTATION.md`

4. **Group by feature**
   - `MOBILE_UNIT_TESTS.md` → `features/testing/MOBILE_UNIT_TESTS.md`
   - `DATABASE_SCHEMA.md` → `features/database/DATABASE_SCHEMA.md`

## CHANGELOG vs COMMIT_LOG

**COMMIT_LOG.md** (Technical - Recommended):

- Detailed technical changes per commit
- For developers reviewing implementation
- Located in `docs/logs/COMMIT_LOG.md`
- Append-only, chronological

**CHANGELOG.md** (User-facing - Optional):

- High-level feature releases
- Version numbers (1.0.0, 1.1.0)
- For stakeholders/users
- Located in `docs/CHANGELOG.md`

**Recommendation**: Use COMMIT_LOG.md as primary. CHANGELOG.md is optional for versioned releases.

## Best Practices

1. **Create new documents sparingly** - Update existing docs when possible

2. **Use prefixes consistently** - Every document should have appropriate prefix

3. **Archive completed work** - Don't delete, move to `archive/` with ✅ prefix

4. **One status doc per feature** - Track progress in single `STATUS-*.md` file

5. **Session logs are append-only** - Create new log per session, never edit old ones

6. **Feature docs stay active** - Don't archive technical reference documentation

7. **Cross-reference in commits** - Link to relevant docs in commit messages

8. **Update this guide** - When structure changes, update this guide first

## Quick Reference

### Starting New Work

1. Create `docs/planning/PLAN-[FEATURE].md`
2. Begin work, create `docs/status/STATUS-[FEATURE]_IMPLEMENTATION.md`
3. Each session, create `docs/logs/LOG-SESSION_YYYY_MM_DD.md`

### Completing Work

1. Rename `docs/planning/PLAN-[FEATURE].md` → `docs/archive/✅-PLAN-[FEATURE].md`
2. Rename `docs/status/STATUS-[FEATURE].md` → `docs/archive/✅-STATUS-[FEATURE].md`
3. Keep feature docs active in `docs/features/[domain]/`

### Finding Documents

- **"What should I work on next?"** → `docs/planning/ROADMAP.md`
- **"What's the current progress?"** → `docs/status/STATUS-*.md`
- **"What happened last session?"** → `docs/logs/LOG-SESSION_*.md`
- **"How does testing work?"** → `docs/features/testing/`
- **"What was the database plan?"** → `docs/archive/✅-PLAN-DATABASE_SCHEMA.md`

---

_This guide supersedes previous documentation structure. All new documents should follow these conventions._
