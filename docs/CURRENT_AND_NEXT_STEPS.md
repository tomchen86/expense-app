# Current and Next Steps

This generated handoff contains semantic project state only. Its sources are the active OpenSpec change and structured issue data.

## Current Change

`integrate-openspec-with-workflow`

## Current Task

`6.1` — Recompute task, plan, and archive validity in hooks and the stable `workflow-assurance` CI job, including dependency/schema/asset drift, forbidden lifecycle assets, bypass cases, archive replay, and UTC-date normalization.

## Next Task

`6.2` — Add a disposable-repository end-to-end rehearsal covering planning validation, plan commit, managed task completion, archive, idempotency, and cross-date CI replay without claiming that the real post-merge pilot has run.

## Current Focus

Recompute task, plan, and archive validity in hooks and the stable `workflow-assurance` CI job, including dependency/schema/asset drift, forbidden lifecycle assets, bypass cases, archive replay, and UTC-date normalization.

## Known Blockers

- `ISS-003` — Activate workflow-assurance branch rules
- `ISS-205` — Recover the web application source boundary

## References

- [Roadmap](ROADMAP.md)
- [Active change](../openspec/changes/integrate-openspec-with-workflow/)
- [Workflow assurance delta](../openspec/changes/integrate-openspec-with-workflow/specs/workflow-assurance/spec.md)
- [Issue log](ISSUE_LOG.md)
- [System architecture](architecture/ARCHITECTURE.md)
