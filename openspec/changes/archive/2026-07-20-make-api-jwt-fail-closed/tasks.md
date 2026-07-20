## 1. Managed Baseline

- [x] 1.1 Refresh the generated semantic handoff for this active change and prove the managed-document baseline is clean before implementation begins.

## 2. Fail-Closed JWT Secrets

- [x] 2.1 Follow RED -> GREEN -> REFACTOR to introduce the fail-closed JWT secret resolver, wire module registration, guard verification, service refresh/signing, and app config through it, remove every inline fallback, give the test setup explicit secrets, and pin the forbidden literals with a regression test.
