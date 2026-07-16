## Why

The repository agent guide still advertises retired tooling, omits the decision
point for most executable workflow commands, and reintroduces an obsolete
500-line refactoring mandate. The documentation entry point also duplicates the
placement guide while legacy plans, status reports, logs, and notes remain mixed
with the canonical document system.

The maintainer explicitly requested a truthful command-and-skill routing guide,
an overview-oriented documentation entry point, the no-churn source-size rule,
and content-preserving archival of documents outside the current system.

## What Changes

- Rewrite `AGENTS.md` so it contains no retired-tool references and explicitly
  states when to use each supported OpenSpec planning skill and every public
  `pnpm workflow` command or subcommand.
- State that focused TypeScript modules are preferred, while source MUST NOT be
  changed, split, or refactored solely because it exceeds 500 lines.
- Rewrite `docs/README.md` as an honest product and repository overview; retain
  placement and mutation rules in `docs/DOCUMENT_STRUCTURE_GUIDE.md`.
- Move the approved noncanonical root notes and legacy `planning/`, `status/`,
  `logs/`, and singular `template/` trees into `docs/archive/legacy/`, preserving
  their relative paths and bytes.
- Add `/memo/` to `.gitignore` so the maintainer's local discussion board remains
  outside Git and workflow controlled-untracked state.
- Update current references, repository contracts, and the registered formatting
  scope for the moved files while leaving CI-anchored document authority unchanged.

## Scope

The change is limited to repository instructions, documentation, the exact
archive manifest, `.gitignore`, repository contract tests, and
`workflow/checks.json`. It does not modify application behavior, dependencies,
databases, APIs, or archived file content.

## Non-Goals

- Deleting or rewriting historical files after archival.
- Archiving canonical `architecture/`, `features/`, `guides/`, `issues/`,
  `research/`, or `templates/` content.
- Changing the executable workflow model or CI-anchored authority policies.
- Refactoring production source because of line count.

## Capabilities

### New Capabilities

- `repository-knowledge-governance`: Defines truthful agent routing, the project
  overview, canonical document boundaries, safe legacy archival, the no-churn
  source-size rule, and the ignored local memo board.

### Modified Capabilities

None.

## Impact

Affected surfaces are `AGENTS.md`, `.gitignore`, current documents under
`docs/`, `workflow/checks.json`, repository contract tests, and exactly 35
legacy files renamed into `docs/archive/legacy/`. No runtime product code or
external service is affected.
