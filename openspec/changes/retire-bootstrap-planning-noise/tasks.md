## 1. Managed Baseline

- [ ] 1.1 Refresh the generated semantic handoff for this active change and prove the managed-document baseline is clean before implementation begins.

## 2. Planning Tree Hygiene

- [ ] 2.1 Follow RED -> GREEN -> REFACTOR to allow deletion-only planning revisions of non-canonical files inside the named change tree, in both live transitions and CI plan replay, while additions and modifications remain rejected.
- [ ] 2.2 Make the workflow-format contract assertion accept exactly the current registered command or the same command without the archived bootstrap path, and no other form.
