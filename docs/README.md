# Documentation Entry Point

This directory separates current project truth, normative requirements,
change planning, reference material, and immutable history.

## Read First

| Need                                            | Canonical source                                             |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Current priorities                              | [`ROADMAP.md`](ROADMAP.md)                                   |
| Current state, handoff, and exact next step     | [`CURRENT_AND_NEXT_STEPS.md`](CURRENT_AND_NEXT_STEPS.md)     |
| Documentation placement and mutation rules      | [`DOCUMENT_STRUCTURE_GUIDE.md`](DOCUMENT_STRUCTURE_GUIDE.md) |
| Normative system requirements                   | [`../openspec/specs/`](../openspec/specs/)                   |
| Active proposal, design, delta specs, and tasks | [`../openspec/changes/`](../openspec/changes/)               |
| System architecture                             | [`architecture/`](architecture/)                             |
| Feature implementation references               | [`features/`](features/)                                     |
| Open issues                                     | [`ISSUE_LOG.md`](ISSUE_LOG.md)                               |
| Delivered user-visible outcomes                 | [`CHANGELOG.md`](CHANGELOG.md)                               |

`WORKFLOW.md` is planned but intentionally not created during the current
bootstrap. Until its reviewed replacement exists, `UPDATE_CHECKLIST.md` is a
legacy operational reference only; verify every command against the repository
and `AGENTS.md` before running it.

## Source Boundaries

- `openspec/specs/**` is the only normative requirements source.
- `openspec/changes/<change-id>/**` is the only active change-planning and task
  source. `guard.json` adds machine execution policy without repeating task
  descriptions.
- The repository workflow engine owns runtime sessions, Git facts, diff scope,
  check evidence, and completion authorization.
- Architecture and feature documents are read freely but updated only through
  explicitly scoped, reviewed work.
- `docs/research/<topic>.md` is background material, never current truth.
- Existing `planning/`, `status/`, and `logs/` files are legacy inputs until
  individually migrated. Do not infer current state from them.
- Spectra remains installed but is not used by the repository workflow.

## Target Structure

```text
docs/
├── README.md
├── ROADMAP.md
├── CURRENT_AND_NEXT_STEPS.md
├── CHANGELOG.md
├── ISSUE_LOG.md
├── DOCUMENT_STRUCTURE_GUIDE.md
├── WORKFLOW.md                 # planned, not created yet
├── issues/
├── architecture/
├── features/
├── guides/
├── research/
├── templates/
└── archive/
```

See `DOCUMENT_STRUCTURE_GUIDE.md` for mutation policies and migration rules.
