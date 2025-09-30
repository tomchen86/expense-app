# Update Checklist

_Last updated: September 30, 2025_

## Purpose

This checklist works in tandem with `docs/DOCUMENT_STRUCTURE_GUIDE.md`. Use this at the end of every coding session or before committing to ensure code quality, documentation accuracy, and proper version control.

**Key Principles**:

- Follow the hybrid documentation structure (planning/, status/, logs/, features/, architecture/, archive/)
- Use prefixes consistently (PLAN-, STATUS-, LOG-, ✅)
- Archive completed work, don't delete it
- Keep session logs append-only

---

## Session Flow

1. **Workspace Snapshot** — Verify git state and dependencies
2. **Quality Gates** — Run tests/lints for areas you touched
3. **Documentation Update** — Follow hybrid structure rules (see below)
4. **Git Commit** — Stage, commit, push with proper messages
5. **Situational Checks** — Optional deep dives when warranted

---

## 1. Workspace Snapshot (Always)

```bash
git status                          # Confirm staged vs unstaged
git diff && git diff --staged       # Review changes, check for secrets
pnpm install --frozen-lockfile      # Only if package.json or lockfile changed
```

---

## 2. Quality Gates (Run Per Touched Surface)

| Surface                    | Run When                            | Commands                                                                                       | Notes                                                    |
| -------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Mobile** (`apps/mobile`) | Any mobile code, store, hooks       | `pnpm --filter mobile lint`<br>`pnpm --filter mobile typecheck`<br>`pnpm --filter mobile test` | Add `pnpm --filter mobile test:e2e` when flows change    |
| **API** (`apps/api`)       | Backend, entities, DTOs, migrations | `pnpm --filter api lint`<br>`pnpm --filter api build`<br>`pnpm --filter api test`              | Add `pnpm --filter api test:e2e` for routes/auth changes |
| **Web** (`apps/web`)       | Frontend components, routes         | `pnpm --filter web lint`<br>`pnpm --filter web typecheck`<br>`pnpm --filter web test`          | Run `build` when touching routing/config                 |
| **Monorepo**               | Shared packages, configs, tooling   | `pnpm lint --recursive`<br>`pnpm test --recursive`                                             | Verify Husky/pre-commit hooks pass                       |

---

## 3. Documentation Update (Hybrid Structure)

### Step 1: Identify Document Type

Ask yourself: **What kind of work did I do?**

- **Planning** → Update/create `docs/planning/PLAN-*.md`
- **Active Development** → Update `docs/status/STATUS-*.md`
- **Session Complete** → Create `docs/logs/LOG-SESSION_YYYY_MM_DD.md`
- **Work Complete** → Archive to `docs/archive/✅-*.md`
- **Feature Reference** → Update `docs/features/[domain]/*.md`

### Step 2: Always Update (Every Session)

| Document                | Location       | Purpose                  | Action                                              |
| ----------------------- | -------------- | ------------------------ | --------------------------------------------------- |
| **COMMIT_LOG.md**       | `docs/logs/`   | Technical commit details | Append entry with commit details (see format below) |
| **STATUS-[FEATURE].md** | `docs/status/` | Track current progress   | Update progress, blockers, next steps               |

**COMMIT_LOG Entry Format**:

```markdown
[COMMIT_HASH] #Day Month DD HH:MM:SS YYYY
⏺ Brief description of what was accomplished

## Major Changes

- Change 1
- Change 2

## Files Modified

- File 1 - what changed
- File 2 - what changed

## Test Status

- ✅ All tests passing (X/X)
- ❌ Known issues

## Next Steps

1. Next action
2. Follow-up work
```

### Step 3: Conditional Updates (When Triggered)

| Trigger                      | Document                    | Location                                             | Action                                                  |
| ---------------------------- | --------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| **New feature planned**      | `PLAN-[FEATURE].md`         | `docs/planning/`                                     | Create new plan with approach, requirements             |
| **Work started**             | `STATUS-[FEATURE].md`       | `docs/status/`                                       | Create status doc tracking progress                     |
| **Session ended**            | `LOG-SESSION_YYYY_MM_DD.md` | `docs/logs/`                                         | Create session summary (decisions, blockers, insights)  |
| **Work completed**           | Move to archive             | `docs/archive/`                                      | Rename with ✅ prefix: `✅-PLAN-*.md`, `✅-STATUS-*.md` |
| **Feature implemented**      | Feature docs                | `docs/features/[domain]/`                            | Create/update technical reference docs                  |
| **Testing approach changed** | Testing docs                | `docs/features/testing/`                             | Update test strategy, coverage docs                     |
| **Architecture decision**    | ADR                         | `docs/architecture/ARCHITECTURE_DECISION_RECORDS.md` | Append new ADR entry                                    |
| **Schema changed**           | Database docs               | `docs/features/database/`                            | Update schema, migration docs                           |
| **API endpoint added**       | API docs                    | `docs/features/api/`                                 | Update endpoint documentation                           |
| **Risk identified**          | Risk assessment             | `docs/architecture/RISK_ASSESSMENT.md`               | Add risk entry with mitigation                          |
| **Roadmap shifted**          | Roadmap                     | `docs/planning/ROADMAP.md`                           | Update milestones, phases                               |
| **Env vars changed**         | `.env.example`              | Root                                                 | Keep example current                                    |

### Step 4: Never Modify (Archive Only)

**These documents are historical records - never edit after archival**:

| Document Type       | Location                                             | Rule                                    |
| ------------------- | ---------------------------------------------------- | --------------------------------------- |
| Archived plans      | `docs/archive/✅-PLAN-*.md`                          | Never modify once archived              |
| Archived status     | `docs/archive/✅-STATUS-*.md`                        | Never modify once archived              |
| Session logs        | `docs/logs/LOG-SESSION-*.md`                         | Append-only, create new for new session |
| Closed ADRs         | `docs/architecture/ARCHITECTURE_DECISION_RECORDS.md` | Append new ADRs, don't edit old ones    |
| Completed task logs | `docs/archive/`                                      | Historical reference only               |

---

## 4. Document Lifecycle Examples

### Example 1: Starting New Feature

```bash
# 1. Create planning document
docs/planning/PLAN-E2E_TESTING.md

# 2. Work starts, create status tracker
docs/status/STATUS-E2E_IMPLEMENTATION.md

# 3. Daily work sessions
docs/logs/LOG-SESSION_2025_09_30.md
docs/logs/COMMIT_LOG.md (append entry)

# 4. Update status document
docs/status/STATUS-E2E_IMPLEMENTATION.md (update progress)

# 5. Work complete
docs/archive/✅-PLAN-E2E_TESTING.md (renamed and moved)
docs/archive/✅-STATUS-E2E_IMPLEMENTATION.md (renamed and moved)

# 6. Feature docs remain active
docs/features/testing/E2E_TESTID_MAPPING.md (stays in place)
```

### Example 2: Updating Existing Feature

```bash
# 1. Update feature documentation
docs/features/database/DATABASE_SCHEMA.md

# 2. Update status if tracked
docs/status/STATUS-DATABASE_IMPLEMENTATION.md

# 3. Log session work
docs/logs/LOG-SESSION_2025_09_30.md
docs/logs/COMMIT_LOG.md (append)
```

### Example 3: Making Architectural Decision

```bash
# 1. Record ADR
docs/architecture/ARCHITECTURE_DECISION_RECORDS.md (append new ADR)

# 2. Update architecture doc if needed
docs/architecture/ARCHITECTURE.md

# 3. Log decision in session
docs/logs/LOG-SESSION_2025_09_30.md

# 4. Update roadmap if scope changed
docs/planning/ROADMAP.md
```

---

## 5. Git & Release Readiness

### Pre-Commit Checks

```bash
# 1. Review staged files
git add -p                         # Stage specific hunks
git status                         # Verify what's staged

# 2. Security check
git diff --staged                  # Look for secrets, keys, tokens
# Ensure no .env files, credentials, API keys committed

# 3. Verify file sizes
ls -lh $(git diff --staged --name-only)  # Check for large binaries

# 4. Commit with proper format
git commit -m "Brief imperative message

Detailed description if needed

See docs/logs/COMMIT_LOG.md for complete details.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

### Commit Message Guidelines

- **Use imperative mood**: "Add feature" not "Added feature"
- **Be concise**: First line ≤50 chars
- **Reference docs**: Point to COMMIT_LOG.md for details
- **Link issues**: Include issue numbers if applicable

---

## 6. Situational Checks (Run When Relevant)

| Check                   | When                          | Command                                   |
| ----------------------- | ----------------------------- | ----------------------------------------- |
| **Clear Expo cache**    | Expo build issues             | `pnpm --filter mobile expo start --clear` |
| **Load testing**        | Performance-sensitive backend | `pnpm --filter api test:load`             |
| **E2E web tests**       | Web journey changes           | `pnpm --filter web test:e2e`              |
| **Accessibility audit** | UI/component updates          | Lighthouse, axe DevTools                  |
| **Device testing**      | Before release                | Manual iOS/Android testing                |
| **Build verification**  | Config/routing changes        | `pnpm --filter [app] build`               |

---

## Quick Reference Commands

```bash
# Quality Gates
pnpm --filter mobile lint && pnpm --filter mobile typecheck && pnpm --filter mobile test
pnpm --filter api lint && pnpm --filter api build && pnpm --filter api test
pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web test

# Monorepo
git status && git diff --staged
pnpm lint --recursive
pnpm install --frozen-lockfile

# Documentation Check
ls docs/status/STATUS-*.md          # Active work
ls docs/logs/LOG-SESSION-*.md       # Recent sessions
ls docs/planning/PLAN-*.md          # Active plans
ls docs/archive/✅-*.md              # Completed work
```

---

## Integration with DOCUMENT_STRUCTURE_GUIDE.md

This checklist follows the structure defined in `docs/DOCUMENT_STRUCTURE_GUIDE.md`:

- **Naming**: Use prefixes (PLAN-, STATUS-, LOG-, ✅)
- **Organization**: Follow hybrid folder structure
- **Lifecycle**: Plan → Status → Log → Archive (✅)
- **Updates**: Refer to guide for "when to update which documents"

**When to consult the guide**:

- Creating new document types
- Unsure where document belongs
- Need lifecycle clarification
- Reorganizing documentation

---

## Workflow Summary

```
┌─────────────────────────────────────────────────────────────┐
│ 1. CODE CHANGES                                             │
│    - Write code, tests                                      │
│    - Run quality gates                                      │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ 2. UPDATE DOCS (Hybrid Structure)                          │
│    Planning:   docs/planning/PLAN-*.md                      │
│    Status:     docs/status/STATUS-*.md                      │
│    Logs:       docs/logs/LOG-SESSION-*.md, COMMIT_LOG.md    │
│    Features:   docs/features/[domain]/*.md                  │
│    Archive:    docs/archive/✅-*.md (when complete)          │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ 3. GIT COMMIT                                               │
│    - Review staged changes                                  │
│    - Check for secrets                                      │
│    - Write concise commit message                           │
│    - Reference COMMIT_LOG.md                                │
└───────────────────────┬─────────────────────────────────────┘
                        │
┌───────────────────────▼─────────────────────────────────────┐
│ 4. PUSH & NEXT                                              │
│    - Push to remote                                         │
│    - Update STATUS-*.md with next steps                     │
│    - Archive if work complete (add ✅ prefix)               │
└─────────────────────────────────────────────────────────────┘
```

---

**Last Review**: Update this checklist alongside `docs/DOCUMENT_STRUCTURE_GUIDE.md` when workflows change. Keep both documents synchronized.
