# Document Structure Guide

_Last updated: September 23, 2025_

## Purpose
This guide is the companion to `docs/UPDATE_CHECKLIST.md`. Use it to understand which documents exist, what they capture, and when each one should change. When the checklist says “update docs,” consult this table to decide which files apply.

## How to Use
1. Finish a task or session.
2. Run the steps in `docs/UPDATE_CHECKLIST.md`.
3. When you reach the documentation step, skim the tables below to confirm which files require updates (Always → Conditional → Never).
4. When workflows change, update this guide together with the checklist so they stay synchronized.

---

## Document Catalogue & Update Triggers

### Always Update
These files reflect current work and must change whenever their subject changes.
| Document | Purpose | Trigger | Notes |
|----------|---------|---------|-------|
| `docs/FUNCTION_LOG.md` | Backlog + requirement status ledger | Any feature/test status change | Update status, priority, and test coverage columns. |
| `docs/CHANGELOG.md` | High-level log of shipped changes | Any user-facing or structural change | Keep entries concise and link to detailed logs. |

### Conditional Updates
Update these when their trigger occurs.
| Category | Document | Purpose | Trigger | Notes |
|----------|----------|---------|---------|-------|
| Planning | `docs/planning/ROADMAP.md` | Phase sequencing & milestones | Roadmap or phase scope shifts | Keep high-level dates and priorities aligned. |
| Planning | `docs/planning/PHASE_[N]_*_PLAN.md` | Deep dive for active phase | Starting, adjusting, or completing a phase | Archive to `docs/archive/` when finished. |
| Planning | `docs/planning/TASK_[N].[N]_*_PLAN.md` | Detailed task blueprint | Only during initial planning | Immutable once work starts. |
| Execution | `docs/TASK_[N].[N]_COMPLETION_LOG.md` | Task execution notes | Worked on that task during session | Log subtasks, files, blockers. |
| Execution | `docs/SESSION_SUMMARY_[YYYY-MM-DD].md` | Cross-task insights | Strategic decisions, retro thoughts, big blockers | One file per session as needed. |
| Testing | `docs/Testing/TESTING_STRATEGY.md` | Canonical testing approach | New approach, tooling, or coverage category | Keep consistent with roadmap scopes. |
| Testing | `docs/Testing/TESTING_IMPROVEMENT_PLAN.md` | Active coverage improvements | When prioritizing new coverage work | Reference same dates as Function Log. |
| Testing | `docs/Testing/PHASE3_TESTING_REPORT.md` | Snapshot of Phase 3 testing state | When new metrics arrive | Treat as living report during phase. |
| Architecture | `docs/ARCHITECTURE.md` | System-level diagrams, contracts | Any cross-app contract change | Align with TypeScript shared types. |
| Architecture | `docs/ARCHITECTURE_DECISION_RECORDS.md` | ADR log | New decision or decision change | Append new entries; never rewrite history. |
| Risk & Ops | `docs/RISK_ASSESSMENT.md` | Risk register | Identify or resolve a material risk | Update status and mitigation owner. |
| Risk & Ops | `docs/PERFORMANCE_METRICS.md` | SLAs & performance targets | Targets change or new metrics tracked | Sync with monitoring setup. |
| Tooling | `docs/TOOL_INTEGRATION_GUIDE.md` | Automation + tooling setup | CI/CD or tooling workflow changes | Note new scripts or integrations. |
| Tooling | `docs/UPDATE_CHECKLIST.md`, `docs/DOCUMENT_STRUCTURE_GUIDE.md` | Package management & dev workflow | Package manager changes, install process updates | Keep pnpm-only standard in sync. |
| Environments | `.env.example`, deployment notes | Environment variables & deploy steps | Env var added/removed or deploy flow changes | Ensure secrets never leak. |
| AI Guidance | `docs/CLAUDE.md`, `docs/UPDATE_CHECKLIST.md`, `docs/DOCUMENT_STRUCTURE_GUIDE.md` | Working agreements for AI/human collaboration | Whenever process or expectations change | Update all three in tandem. |

### Never Modify (Archive Only)
These documents capture historical truth. Create new siblings or archive entries instead of editing.
| Document Type | Examples | Replacement Action |
|---------------|----------|--------------------|
| Archived planning | `docs/archive/*` | Leave untouched; link from active docs if needed. |
| Task/phase plans | `TASK_*_PLAN.md`, `PHASE_*_PLAN.md` once work starts | Create completion logs for updates. |
| Closed ADRs | `docs/ARCHITECTURE_DECISION_RECORDS.md` past entries | Append new ADR numbers rather than editing prior decisions. |
| Past session summaries | `SESSION_SUMMARY_*.md` | Author a new summary for fresh insights. |

---

## Naming & Location Conventions
- Planning files live under `docs/planning/` using the pattern shown above.
- Testing docs sit beneath `docs/Testing/` and mirror the strategy → improvement plan → report hierarchy.
- Historical files move into `docs/archive/` with a `_COMPLETED` or `_ARCHIVED_YYYY-MM-DD` suffix.
- Session logs use ISO dates (`SESSION_SUMMARY_2025-09-23.md`).

---

## Document Lifecycle Rules
1. **Create** a new document only when no existing file fits (prefer updating current docs).
2. **Archive** by moving to `docs/archive/` once a phase/task/plan is complete and adding `_COMPLETED` to the name.
3. **Cross-reference** major updates in `docs/CHANGELOG.md` and `docs/FUNCTION_LOG.md` to keep the high-level index current.
4. **Review cadence**: skim this guide monthly or when the checklist changes to ensure both stay aligned.

---

## Checklist Pairing
Whenever you edit this guide or the checklist:
- Update both documents in the same PR/commit.
- Note the change in `docs/CHANGELOG.md` under Documentation.
- Add a reminder in the relevant session summary or task completion log so future you knows why the process shifted.

Maintain consistency here so AI agents always know which documents to touch and which to treat as write-once history.
