# Documentation Consolidation Plan

## Context

Three meta-docs (`DOCUMENT_STRUCTURE_GUIDE.md`, `UPDATE_CHECKLIST.md`, `GUIDE-LOG_TRACKING.md`) have significant overlap. They were written at different times and now duplicate content on: folder structure, prefix conventions, document lifecycle, log formats, never-modify rules, and COMMIT_LOG templates. An AI starting a new session may read conflicting or redundant instructions from all three.

**Goal**: Give each file a clear, non-overlapping responsibility. Trim duplicated content. Replace duplicated sections with cross-references. Keep the same level of detail — just in one place, not three. Also: add `docs/README.md` as the entry point, rewrite CLAUDE.md to be leaner, and do Phase A renames/moves from the prior plan.

---

## Overlap Map (what's duplicated where)

| Topic                                      | STRUCTURE_GUIDE | UPDATE_CHECKLIST |      LOG_TRACKING      | **Owner after cleanup** |
| ------------------------------------------ | :-------------: | :--------------: | :--------------------: | ----------------------- |
| Folder structure & tree                    |      FULL       |     REPEATED     |           -            | **STRUCTURE_GUIDE**     |
| Prefix naming conventions                  |   FULL table    |     REPEATED     |           -            | **STRUCTURE_GUIDE**     |
| Document lifecycle (plan→status→archive)   |      FULL       |     REPEATED     |           -            | **STRUCTURE_GUIDE**     |
| Category descriptions (6 categories)       |      FULL       |        -         |           -            | **STRUCTURE_GUIDE**     |
| Good/bad naming examples                   |      FULL       |        -         |           -            | **STRUCTURE_GUIDE**     |
| When to update what (trigger tables)       |     Tables      |  Larger tables   |           -            | **UPDATE_CHECKLIST**    |
| Quality gate commands                      |        -        |       FULL       |           -            | **UPDATE_CHECKLIST**    |
| Git/commit workflow                        |        -        |       FULL       |         brief          | **UPDATE_CHECKLIST**    |
| Session flow (workspace→gates→docs→commit) |        -        |       FULL       |           -            | **UPDATE_CHECKLIST**    |
| Situational checks                         |        -        |       FULL       |           -            | **UPDATE_CHECKLIST**    |
| COMMIT_LOG format/template                 |      Brief      |  Older template  |  **Better template**   | **LOG_TRACKING**        |
| Session log template                       |        -        |  brief mention   |   **Full template**    | **LOG_TRACKING**        |
| CHANGELOG template                         |        -        |  brief mention   |   **Full template**    | **LOG_TRACKING**        |
| Anti-overlap / single-source rules         |        -        |        -         |          FULL          | **LOG_TRACKING**        |
| Cross-reference convention (WORK-ID)       |        -        |        -         |          FULL          | **LOG_TRACKING**        |
| Never-modify rules                         |      Table      |  Repeated table  |        Rule #4         | **STRUCTURE_GUIDE**     |
| CHANGELOG vs COMMIT_LOG comparison         |      Brief      |        -         | FULL (ownership table) | **LOG_TRACKING**        |

---

## Plan: Trim Each File to Its Owned Domain

### 1. DOCUMENT_STRUCTURE_GUIDE.md — owns: **structure, naming, lifecycle, categories**

**Keep as-is (unique content):**

- Purpose section (lines 1-11)
- Prefix table (lines 15-26)
- Document lifecycle diagram (lines 28-44)
- Directory structure tree (lines 46-91)
- Category descriptions: planning, status, features, architecture, archive (lines 125-219)
- Good/bad naming examples (lines 220-240)
- Never-modify rules table (lines 114-121)
- Quick reference: starting/completing/finding work (lines 278-298)
- Best practices list (lines 260-276)

**Trim (duplicated elsewhere):**

- Lines 93-113: "When to Update Which Documents" (Always/Conditional tables) — **move to UPDATE_CHECKLIST** (it already has the fuller version). Replace with: `> For update triggers and session workflow, see docs/UPDATE_CHECKLIST.md`
- Lines 156-169: Logs category — **remove the COMMIT_LOG format details** and LOG-SESSION details. Replace with: `For log formats and templates, see docs/GUIDE-LOG_TRACKING.md`
- Lines 242-258: "CHANGELOG vs COMMIT_LOG" section — **remove entirely**, this is now fully owned by LOG_TRACKING. Add one-line reference.

**Estimated change**: ~303 lines → ~240 lines. Same detail, just deduped.

### 2. UPDATE_CHECKLIST.md — owns: **session workflow, quality gates, git workflow, update triggers**

**Keep as-is (unique content):**

- Session flow overview (lines 19-24)
- Workspace snapshot commands (lines 28-34)
- Quality gates table (lines 40-46)
- Step 1: Identify document type (lines 51-59) — brief routing, no duplication
- Step 3: Conditional update triggers table (lines 96-110) — the most complete version
- Lifecycle examples: starting feature, updating feature, architecture decision (lines 126-180)
- Git & release readiness (lines 184-218)
- Situational checks table (lines 221-231)
- Quick reference commands (lines 234-252)

**Trim (duplicated elsewhere):**

- Lines 9-14: "Key Principles" bullet list — **remove**, this is just a summary of STRUCTURE_GUIDE's prefix/lifecycle rules. Replace with: `> Naming conventions and lifecycle rules: see docs/DOCUMENT_STRUCTURE_GUIDE.md`
- Lines 62-93: "Step 2: Always Update" including COMMIT_LOG entry format template — **remove the template entirely**. Keep the 2-row "always update" table (COMMIT_LOG + STATUS), but replace the format template with: `> For COMMIT_LOG and session log templates, see docs/GUIDE-LOG_TRACKING.md`
- Lines 112-122: "Step 4: Never Modify" table — **remove**, exact duplicate of STRUCTURE_GUIDE. Replace with: `> Archive/immutability rules: see docs/DOCUMENT_STRUCTURE_GUIDE.md`
- Lines 256-270: "Integration with DOCUMENT_STRUCTURE_GUIDE.md" section — **remove**, this is a "see also" section that just restates the guide's content
- Lines 272-306: "Workflow Summary" ASCII diagram — **remove**, it restates the session flow from lines 19-24 in a different format

**Estimated change**: ~310 lines → ~200 lines. Quality gates, triggers, git workflow, and examples all preserved.

### 3. GUIDE-LOG_TRACKING.md — owns: **3 log types, templates, anti-overlap rules**

**Keep entirely as-is.** This file is new (March 2026), clean, and has no internal duplication. It already defines clear ownership boundaries for session logs, COMMIT_LOG, and CHANGELOG.

**One addition**: Add a header note linking to the other two files:

```markdown
> Related guides:
>
> - Folder structure, naming, lifecycle: `docs/DOCUMENT_STRUCTURE_GUIDE.md`
> - Session workflow, quality gates, update triggers: `docs/UPDATE_CHECKLIST.md`
```

**No lines removed. ~5 lines added.**

---

## Phase A: Renames & Moves (unchanged from prior plan)

### A1. Fix archive naming (add `✅-` prefix to 10 files)

```
archive/couples_expense_architecture_roadmap.md    → ✅-couples_expense_architecture_roadmap.md
archive/E2E_TESTID_MAPPING.md                      → ✅-E2E_TESTID_MAPPING.md
archive/Function Log.md                            → ✅-Function_Log.md
archive/mobile-runtime-debug-report.md             → ✅-mobile-runtime-debug-report.md
archive/PLAN-TASK_2.2_CLAUDE_IMPLEMENTATION.md     → ✅-PLAN-TASK_2.2_CLAUDE_IMPLEMENTATION.md
archive/PLANNING_500_LINE_VIOLATIONS_COMPLETED.md  → ✅-PLANNING_500_LINE_VIOLATIONS_COMPLETED.md
archive/REFACTORING_PLAN.md                        → ✅-REFACTORING_PLAN.md
archive/TESTING_INFRASTRUCTURE_ISSUE_REPORT.md     → ✅-TESTING_INFRASTRUCTURE_ISSUE_REPORT.md
archive/TESTING_STRATEGY.md                        → ✅-TESTING_STRATEGY.md
archive/USER_SETTINGS_REFACTOR_PLAN.md             → ✅-USER_SETTINGS_REFACTOR_PLAN.md
```

### A2. PAUSED — Move completed plans to archive

Pending further investigation. Skip for this iteration.

### A3. PAUSED — Move misplaced files

Pending further investigation. Skip for this iteration.

### A4. Fix log naming

```
logs/LOG_PHASE3_TESTING_REPORT.md            → logs/LOG-PHASE3_TESTING_REPORT.md
```

---

## Phase D: Create docs/README.md + Rewrite CLAUDE.md

### D1. Create `docs/README.md` — universal entry point (~50 lines)

Content:

- "Quick Start — What to Read First" routing table (you're doing X → read Y)
- Qualitative project status (e.g. "Mobile: complete", "API: complete", "Web: deferred") — **no hardcoded test counts** (they go stale fast; check live with `pnpm test`)
- Folder structure summary (one-line per folder)
- "Conventions" section pointing to the 3 meta-docs with their owned domains:
  - Structure & naming → DOCUMENT_STRUCTURE_GUIDE.md
  - Session workflow & quality gates → UPDATE_CHECKLIST.md
  - Log system (session, commit, changelog) → GUIDE-LOG_TRACKING.md
- "Current progress" section → points to `docs/status/STATUS-CURRENT_AND_NEXT_STEPS.md`

### D2. Rewrite CLAUDE.md (lean, not single source of truth)

- Fix stale "API 15% complete" → qualitative status (no hardcoded counts)
- Replace verbose "Current Project State" with compact qualitative block
- Replace "Key Documentation" section with: "Start with `docs/README.md`"
- Add reference to GUIDE-LOG_TRACKING.md in Development Guidelines
- Keep Commands and Architecture sections (useful, compact)

### D3. DROPPED — Keep STATUS-CURRENT_AND_NEXT_STEPS.md as-is

This file serves as a state-check doc for both human and AI to review current progress. No rename or trim needed.

---

## Verification

### V1. Cross-references exist between all 3 meta-docs (each must reference the other two)

```bash
# Each file must contain references to the other two
rg -c "GUIDE-LOG_TRACKING" docs/DOCUMENT_STRUCTURE_GUIDE.md docs/UPDATE_CHECKLIST.md
# Expected: ≥1 match per file

rg -c "DOCUMENT_STRUCTURE_GUIDE" docs/UPDATE_CHECKLIST.md docs/GUIDE-LOG_TRACKING.md
# Expected: ≥1 match per file

rg -c "UPDATE_CHECKLIST" docs/DOCUMENT_STRUCTURE_GUIDE.md docs/GUIDE-LOG_TRACKING.md
# Expected: ≥1 match per file
```

### V2. No duplicate log templates (templates only in LOG_TRACKING)

```bash
# COMMIT_LOG entry template markers should NOT exist in the other two files
rg -c "COMMIT_HASH|Major Changes|Files Modified|Test Status" docs/DOCUMENT_STRUCTURE_GUIDE.md docs/UPDATE_CHECKLIST.md
# Expected: 0 matches per file

# Session log template markers should NOT exist outside LOG_TRACKING
rg -c "Context In|Context Out|Work Performed" docs/DOCUMENT_STRUCTURE_GUIDE.md docs/UPDATE_CHECKLIST.md
# Expected: 0 matches per file
```

### V3. No duplicate never-modify rules

```bash
# "Never modify" / archive immutability rules should be in STRUCTURE_GUIDE only
rg -c "Never modify once archived|historical records.*never edit" docs/UPDATE_CHECKLIST.md
# Expected: 0 matches (replaced with cross-reference)
```

### V4. Archive naming consistency

```bash
# All archive files must start with ✅-
ls docs/archive/ | while read f; do
  case "$f" in ✅-*|.DS_Store) ;; *) echo "MISSING PREFIX: $f" ;; esac
done
# Expected: no output
```

### V5. Explicit link validation — all cross-referenced files exist

```bash
# Extract all docs/ paths referenced in the 3 meta-docs + README + CLAUDE.md
rg -o 'docs/[a-zA-Z0-9_./-]+\.md' docs/DOCUMENT_STRUCTURE_GUIDE.md docs/UPDATE_CHECKLIST.md docs/GUIDE-LOG_TRACKING.md docs/README.md CLAUDE.md 2>/dev/null | \
  cut -d: -f2 | sort -u | while read path; do
    test -f "$path" || echo "BROKEN LINK: $path"
  done
# Expected: no output
```

### V6. No hardcoded test counts in README.md

```bash
rg -c "[0-9]+/[0-9]+ tests|[0-9]+/[0-9]+ passing" docs/README.md
# Expected: 0 matches
```

### V7. README.md exists and has expected sections

```bash
test -f docs/README.md && echo "EXISTS" || echo "MISSING"
rg -c "Quick Start|Folder Structure|Conventions" docs/README.md
# Expected: ≥1 match each
```

---

## Execution Order

1. **Phase A1 + A4** — git mv archive renames + log fix (safe, preserves history)
2. **Trim DOCUMENT_STRUCTURE_GUIDE.md** — remove duplicated sections, add cross-references
3. **Trim UPDATE_CHECKLIST.md** — remove duplicated sections, add cross-references
4. **Add cross-reference header to GUIDE-LOG_TRACKING.md** (minimal change)
5. **Create docs/README.md** — entry point (no hardcoded test counts)
6. **Rewrite CLAUDE.md** — lean, fix stale status, qualitative only
7. **Run verification V1–V7**

---

## Critical Files

| File                                    | Action                                                               |
| --------------------------------------- | -------------------------------------------------------------------- |
| `docs/DOCUMENT_STRUCTURE_GUIDE.md`      | EDIT — remove ~60 lines of duplicated content, add cross-references  |
| `docs/UPDATE_CHECKLIST.md`              | EDIT — remove ~110 lines of duplicated content, add cross-references |
| `docs/GUIDE-LOG_TRACKING.md`            | EDIT — add ~5 lines of cross-reference header                        |
| `docs/README.md`                        | CREATE — universal entry point (~50 lines, no hardcoded counts)      |
| `/Users/htchen/code_base/app/CLAUDE.md` | REWRITE — lean, fix stale status, point to README                    |
