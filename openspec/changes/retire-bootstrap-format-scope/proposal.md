## Why

The registered `workflow-format` check still pins the literal path
`openspec/changes/establish-executable-ai-workflow` in its command, so the
bootstrap change's planning tree cannot leave the repository: archiving it
would make the required format check fail on a missing path. `checks.json` is
maintainer authority, so the edit must travel through a break-glass grant and
an SSH-signed authority commit, with the rebased result attested afterward.
The transition-tolerant contract assertion landed in
`retire-bootstrap-planning-noise`, so both command forms are already green.

## What Changes

- One maintainer authority commit removes the
  `openspec/changes/establish-executable-ai-workflow` entry from the
  registered `workflow-format` command in `workflow/checks.json`. Nothing else
  in the registry changes.
- Task 1.1 refreshes the generated handoff before the authority session runs
  so every pinned normal check evaluates a clean managed-document baseline.
- After the pull request merges, the maintainer attests the rebased authority
  commit through the existing `workflow-attestation/**` path.

Non-goals: changing any other check definition, engine source, policy file, or
the bootstrap change's planning tree (its noise deletion is a separate
`plan-commit` operation).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ci-check-authority`: The registered `workflow-format` scope excludes
  archived bootstrap planning trees.

## Impact

- Affected authority file: `workflow/checks.json` (grant-scoped).
- Affected documents: `docs/CURRENT_AND_NEXT_STEPS.md` (generated handoff).
- Unblocks the archive of `establish-executable-ai-workflow`.
