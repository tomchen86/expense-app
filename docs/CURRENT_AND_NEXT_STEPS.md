# Current and Next Steps

This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and structured issue data.

## Current Change

`make-api-jwt-fail-closed`

## Current Task

`2.1` — Follow RED -> GREEN -> REFACTOR to introduce the fail-closed JWT secret resolver, wire module registration, guard verification, service refresh/signing, and app config through it, remove every inline fallback, give the test setup explicit secrets, and pin the forbidden literals with a regression test.

## Next Task

None.

## Current Focus

Follow RED -> GREEN -> REFACTOR to introduce the fail-closed JWT secret resolver, wire module registration, guard verification, service refresh/signing, and app config through it, remove every inline fallback, give the test setup explicit secrets, and pin the forbidden literals with a regression test.

## Known Blockers

- `ISS-003` — Activate workflow-assurance branch rules
- `ISS-205` — Recover the web application source boundary

## References

- [Roadmap](ROADMAP.md)
- [Change records](../openspec/changes/)
- [Base specifications](../openspec/specs/)
- [Issue log](ISSUE_LOG.md)
- [System architecture](architecture/ARCHITECTURE.md)
