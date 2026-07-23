# Current and Next Steps

This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and structured issue data.

## Current Change

`establish-investigation-first-planning`

## Current Task

`4.2` — Follow RED -> GREEN -> REFACTOR to introduce the non-default `expense-app-v2` schema registry, engine-owned `investigation.json`/`execution.json`/`plan-review.json` templates and validators, schema-aware change-contract loading, and legacy/v2 schema fixtures without adding the activation marker or changing the project default.

## Next Task

`4.3` — Follow RED -> GREEN -> REFACTOR to make planning-path, planning-transition, local archive, and transformation contracts select the explicit legacy or v2 artifact grammar and replay both fixture generations while activation remains disabled.

## Current Focus

Follow RED -> GREEN -> REFACTOR to introduce the non-default `expense-app-v2` schema registry, engine-owned `investigation.json`/`execution.json`/`plan-review.json` templates and validators, schema-aware change-contract loading, and legacy/v2 schema fixtures without adding the activation marker or changing the project default.

## Known Blockers

- `ISS-003` — Activate workflow-assurance branch rules
- `ISS-205` — Recover the web application source boundary

## References

- [Roadmap](ROADMAP.md)
- [Change records](../openspec/changes/)
- [Base specifications](../openspec/specs/)
- [Issue log](ISSUE_LOG.md)
- [System architecture](architecture/ARCHITECTURE.md)
