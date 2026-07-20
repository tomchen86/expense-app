## Why

The bootstrap change `establish-executable-ai-workflow` cannot archive: its
planning tree carries `requirement-audit.md`, a bootstrap-era artifact that
predates the canonical planning-tree whitelist, and the whitelist now blocks
every legal exit — archive rejects the tree, `plan-commit` rejects the
deletion, task commits may not touch another change's planning tree, and the
path is not authority-eligible. Separately, the registered `workflow-format`
check pins the literal path `openspec/changes/establish-executable-ai-workflow`
in its command, and a contract test asserts that exact command, so retiring
the directory needs a transition-tolerant assertion before the
maintainer-authority `checks.json` edit can pass its own checks.

## What Changes

- Allow planning transitions to **delete** non-canonical files inside the
  named change's own tree. Additions and modifications of non-canonical files
  remain rejected; deletions outside the change tree remain rejected. CI plan
  replay applies the same deletion-only rule.
- Make the `workflow-format` contract assertion transition-tolerant: it
  accepts exactly the current registered command or the same command without
  the archived bootstrap path, and no other form.
- Keep the follow-up operations out of scope: the maintainer-authority
  `checks.json` edit, the noise-file deletion via `plan-commit`, and the
  bootstrap change's archive are grant and transition operations, not tasks.

Non-goals: widening planning-tree additions, changing archive validation, or
altering any check definition in this change.

## Capabilities

### New Capabilities

- `planning-tree-hygiene`: Planning transitions can retire non-canonical
  planning-tree noise through deletion-only revisions, and bootstrap format
  scope retirement is transition-tolerant.

### Modified Capabilities

None.

## Impact

- Affected engine source: `planning-paths.ts`, `planning-transition.ts`,
  `ci-planning.ts`.
- Affected tests: planning transition contract/integration suites,
  `ci-planning.integration.test.ts`, and `contracts.test.ts`.
- Unblocks the archive of `establish-executable-ai-workflow`; no application
  code, schema, policy, or check definition changes.
