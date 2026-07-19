## 1. Engine Test Fixture Independence

- [ ] 1.1 Refresh the generated semantic handoff for this active change and prove the managed-document baseline is clean before implementation begins.
- [ ] 1.2 Rewrite the adapter and managed-contract integration tests to build synthetic change fixtures in temporary repositories, preserving every existing assertion, with the recorded PR #62 failure as RED evidence and a full-bundle pass on both the current and archive trees as GREEN evidence.
