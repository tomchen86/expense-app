# Current and Next Steps

This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and structured issue data.

## Current Change

`separate-openspec-asset-validation`

## Current Task

`3.1` — Follow RED -> GREEN -> REFACTOR to build the tool-neutral schema-v2 manifest, single-run Codex/Claude source generation, three-stage digest model, all-target delivery/closure rules, hardened forbidden-authority checks, deterministic generator, and formatter-independent read-only checker alongside the still-live Codex asset surface.

## Next Task

`3.2` — Follow RED -> GREEN -> REFACTOR to atomically cut the live repository over from `codex-assets` to `openspec-assets`: switch CLI/integration consumers, make missing or renamed manifests fail closed in hooks and CI, migrate/regenerate Codex, Claude, `.agents`, and prompt targets, remove the old modules/home, update full-integration fixtures and regressions, and align active agent/workflow guidance without changing `workflow/checks.json`.

## Current Focus

Follow RED -> GREEN -> REFACTOR to build the tool-neutral schema-v2 manifest, single-run Codex/Claude source generation, three-stage digest model, all-target delivery/closure rules, hardened forbidden-authority checks, deterministic generator, and formatter-independent read-only checker alongside the still-live Codex asset surface.

## Known Blockers

- `ISS-003` — Activate workflow-assurance branch rules
- `ISS-205` — Recover the web application source boundary

## References

- [Roadmap](ROADMAP.md)
- [Change records](../openspec/changes/)
- [Base specifications](../openspec/specs/)
- [Issue log](ISSUE_LOG.md)
- [System architecture](architecture/ARCHITECTURE.md)
