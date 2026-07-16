## 1. Web Tree Conversion

- [x] 1.1 Add a failing transitional contract for removal of the empty
      `apps/web` worktree path, remove the malformed gitlink without pre-staging
      it, retain checkout compatibility until the replacement exists, and let
      workflow finish authorize the deletion commit with all registered
      non-database checks.
- [ ] 1.2 Replace the transitional contract with a failing permanent contract
      for ordinary `apps/web` Git index entries and credential-free exact-head
      checkout, add the documented placeholder directory, remove the transient
      checkout compatibility phases, and prove structural Git, frozen-install,
      targeted contract, and authoritative non-database checks.
