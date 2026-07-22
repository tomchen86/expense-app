## Why

The Roadmap's [repository workflow adoption](../../../docs/ROADMAP.md#finish-repository-workflow-adoption) work still has two coupled trust authorities: generated planning assets are checked by Prettier as well as by their manifest, and only Codex receives manifest-governed native skills. The current integration also skips validation when the manifest is missing and does not reject every lifecycle or Spectra command already forbidden by the normative planning-only contract.

## What Changes

- **BREAKING** Rename the public `codex-assets` workflow command and `workflow/codex-assets/` home to tool-neutral `openspec-assets` names; keep `install-prompts --codex-home` as the explicitly Codex-specific installer.
- Generate the reviewed `openspec-explore` and `openspec-propose` workflows for Codex and Claude Code in one isolated, pinned OpenSpec invocation, deliver native skills to both tools, and keep the existing `.agents` copies as byte-identical governed mirrors. Claude slash commands and every apply/update/sync/archive workflow remain unexposed.
- Version the manifest contract so it records raw source, reviewed overlay, and final delivered-byte digests for every Codex, Claude, `.agents`, and prompt target.
- Make `openspec-assets check` read-only and independent of Prettier while failing closed on a missing manifest, generator or overlay drift, unexpected paths, target drift, and all forbidden lifecycle, store, Spectra, or tool-specific authority.
- Register `openspec-assets` as a non-destructive workflow check and narrow `workflow-format` to human-maintained workflow policy/schema files. The exact `workflow/checks.json` transition remains human-only and uses a signed authority commit.
- Add RED-first coverage for plural generation, manifest absence, all delivery closures, forbidden pinned lifecycle commands, Spectra, formatter independence, and the authority sequence that introduces then activates a new check definition.

Scope is limited to repository planning assets, their workflow-engine generator and validators, check/CI assurance, tests, and active governance documentation. It does not change application behavior, dependencies, OpenSpec lifecycle authority, or database policy.

Non-goals include exposing any OpenSpec workflow beyond explore/propose, installing Claude assets outside the repository, writing a real Codex or Claude home during generation/tests/CI, rewriting archived change records, or allowing an agent to issue the maintainer grant or signed authority commit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `openspec-workflow-integration`: Generalize the planning-only asset interface across Codex, Claude, `.agents`, and prompt targets; separate source/overlay/final-byte validation from formatting; and require manifest and forbidden-authority checks to fail closed.
- `agent-skill-governance`: Bring the existing `.agents` compatibility mirrors under the same generated manifest and delivery-closure contract while preserving byte identity with canonical Codex skills.
- `ci-check-authority`: Register generated OpenSpec validation independently from the canonical human-maintained formatting scope and activate the new check through a later guard reference.
- `break-glass-maintainer-mode`: Define the signed transition semantics for adding an initially unused check definition while changing an existing required definition.
- `planning-tree-hygiene`: Replace the retired bootstrap-only format-command compatibility window with an exact old/new transition for the generated-asset scope change, then require only the new form after activation.

## Impact

- Workflow engine generation, validation, integration hooks/CI, CLI dispatch, authority replay regression coverage, and repository contracts under `packages/workflow-engine/`.
- Generated and mirrored assets under `.codex/skills/`, `.claude/skills/`, `.agents/skills/`, and `workflow/openspec-assets/`.
- Public workflow guidance in `AGENTS.md`, `.agents/README.md`, and `docs/WORKFLOW.md`.
- One later human-signed authority commit changing only `workflow/checks.json`, followed by a planning revision and a final managed activation task that requires the new check.
- No API, mobile, web, dependency, or database changes; no destructive database tests are required.
