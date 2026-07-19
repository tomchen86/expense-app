## Context

The repository currently has two conflicting agent-facing surfaces. The tracked
`.agents/skills/spectra-*` directories advertise a Spectra lifecycle, while the
repository instructions designate OpenSpec planning artifacts plus
`pnpm workflow` as the only authoritative execution path. The canonical
OpenSpec planning skills already exist under `.codex/skills/`, but are not
mirrored into `.agents/skills/`.

The maintainer explicitly approved deleting the ten Spectra-generated skill
files, keeping the two OpenSpec skills, and removing two untracked nested
Spectra metadata files after merge. The tracked root `.spectra.yaml` is outside
that deletion approval and remains historical compatibility data.

The trust boundary is the tracked Git tree reviewed and committed by the
repository-owned workflow. Skill prose and retained compatibility data do not
grant execution authority. `pnpm workflow`, its registered checks, and the
repository contract test provide the machine-verifiable evidence.

## Goals / Non-Goals

**Goals:**

- Replace the tracked Spectra agent-skill surface with reviewed OpenSpec
  planning-skill mirrors.
- Make documentation consistently describe OpenSpec as planning-only and the
  workflow engine as execution authority.
- Fail repository checks when Spectra execution assets, divergent mirrors,
  nested Spectra metadata, or contradictory instructions return.
- Keep the managed change narrow enough to review and roll back independently.

**Non-Goals:**

- Remove or reinterpret the tracked root `.spectra.yaml`.
- Change application behavior, dependencies, databases, or workflow-engine
  lifecycle behavior.
- Change the canonical `.codex/skills/openspec-*` sources.
- Invoke Spectra or use Spectra lifecycle state during the migration.

## Decisions

### Treat tracked files as the authoritative agent surface

The ten tracked Spectra skill files will be deleted rather than ignored. An
ignore rule cannot neutralize already tracked instructions and would leave the
conflicting agent interface reviewable as active repository content. The
tracked root `.spectra.yaml` remains, but instructions will identify it as
historical-only data without execution authority.

### Mirror the reviewed OpenSpec planning skills exactly

`.codex/skills/openspec-explore/SKILL.md` and
`.codex/skills/openspec-propose/SKILL.md` remain canonical. Their `.agents`
counterparts will be byte-identical, and a repository contract will compare
their content. Independent copies with similar prose were rejected because
they could drift while still appearing valid to reviewers or agents.

### Enforce the migration with an existing repository contract suite

The workflow-engine contract suite will gain one RED -> GREEN test covering
the allowed skill surface, mirror integrity, absence of nested Spectra
metadata, and the key documentation boundary. This keeps the evidence in an
already registered, non-database check instead of introducing a new script or
dependency. A failing invariant stops the registered workflow checks and CI;
it does not attempt to repair the checkout automatically.

The configuration and documentation edits are TDD-exempt, but the enforceable
repository invariant is not: the contract must fail against the pre-migration
tree before the files are changed and pass afterward. The guard limits the task
to the ten approved deletions, two OpenSpec mirrors, three governance documents,
and the contract test. Workflow check reports and Git scope validation are the
evidence that the guard was respected.

### Remove untracked nested metadata only in the maintainer worktree

The files `openspec/.spectra.yaml` and `openspec/specs/.spectra.yaml` are not
tracked and therefore are not part of the managed commit. The contract rejects
them if they appear in a checked workspace, while the final post-merge cleanup
removes the existing local copies from the maintainer's main worktree. This
separates reviewed tracked changes from local debris without widening the
commit.

## Risks / Trade-offs

- **[Risk] An external tool regenerates Spectra skills or nested metadata** ->
  The repository contract fails with the offending path and prevents a green
  managed check.
- **[Risk] The two OpenSpec skill copies drift** -> The contract compares the
  complete file contents and directs maintainers back to the canonical
  `.codex` source.
- **[Risk] Retaining the root Spectra config looks like continued support** ->
  `AGENTS.md`, `.agents/README.md`, and the Roadmap explicitly classify it as
  historical-only and deny it execution authority.
- **[Trade-off] The test checks selected governance language** -> This catches
  the known contradiction without trying to turn all prose into a brittle
  snapshot.

## Migration Plan

1. Add the repository contract and record its expected failure on the current
   Spectra skill surface.
2. Delete the ten approved Spectra skill files, add the two exact OpenSpec
   mirrors, and align the three governance documents.
3. Run the targeted contract and all guard-required workflow checks, then
   commit through the managed task lifecycle.
4. Push, obtain the required `workflow-assurance` result, and merge.
5. Synchronize the maintainer's main worktree, remove the two untracked nested
   metadata files, and verify the tree is clean while the personal memo folder
   remains ignored.

Rollback is a managed revert of the migration commit. A rollback must not
restore Spectra execution authority without a new maintainer-approved change.

## Open Questions

None. The deletion set, retained root metadata, replacement skills, and local
cleanup boundary have all been explicitly resolved.
