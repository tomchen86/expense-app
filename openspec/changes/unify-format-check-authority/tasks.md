## 1. Registered Check Authority

- [x] 1.1 Add failing workflow integration coverage, then implement the
      fail-closed `run-check <check-id>` command by reusing the registered pinned
      runner and document its evidence-only authority boundary.
- [x] 1.2 Add a failing repository routing contract, then make the existing
      `format:check` package entry point delegate to `run-check workflow-format`
      so GitHub, local verification, managed checks, and replay share the
      unchanged registry definition.
