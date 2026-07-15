# Current and Next Steps

This generated handoff contains semantic project state only. Its sources are the active OpenSpec change and structured issue data.

## Current Change

`integrate-openspec-with-workflow`

## Current Task

`5.3` — Add archive reports, fingerprint rechecks, verified patch application, exact staging/commit authorization, `Transition: archive` trailers, fault/concurrency coverage, and workflow-owned already-archived detection.

## Next Task

`6.1` — Recompute task, plan, and archive validity in hooks and the stable `workflow-assurance` CI job, including dependency/schema/asset drift, forbidden lifecycle assets, bypass cases, archive replay, and UTC-date normalization.

## Current Focus

Add archive reports, fingerprint rechecks, verified patch application, exact staging/commit authorization, `Transition: archive` trailers, fault/concurrency coverage, and workflow-owned already-archived detection.

## Known Blockers

- `ISS-003` — Activate workflow-assurance branch rules
- `ISS-205` — Recover the web application source boundary

## References

- [Roadmap](ROADMAP.md)
- [Active change](../openspec/changes/integrate-openspec-with-workflow/)
- [Workflow assurance delta](../openspec/changes/integrate-openspec-with-workflow/specs/workflow-assurance/spec.md)
- [Issue log](ISSUE_LOG.md)
- [System architecture](architecture/ARCHITECTURE.md)
