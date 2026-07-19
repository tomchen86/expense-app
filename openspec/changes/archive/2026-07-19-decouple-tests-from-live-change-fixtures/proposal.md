## Why

Archiving `integrate-openspec-with-workflow` is blocked: five engine tests in
`openspec-adapter.integration.test.ts` and
`managed-change-contract.integration.test.ts` load that live change from the
repository as their fixture. On the archive tree the change directory moves to
`openspec/changes/archive/`, the fixture disappears, and `workflow-tests`
fails (7 failures reproduced locally and in the PR #62 `workflow-assurance`
run). Tests that depend on mutable planning state make every archive of their
fixture change impossible, which contradicts the managed lifecycle itself.

## What Changes

- Rewrite the affected adapter and managed-contract tests to build
  self-contained synthetic change fixtures in temporary repositories instead
  of reading `openspec/changes/integrate-openspec-with-workflow`.
- Preserve every existing assertion target: real pinned OpenSpec CLI
  validation, schema enforcement, status/change parity, contract readiness
  binding, diagnostic ordering, and mutation rejection.
- Record the PR #62 CI failure and the local archive-tree reproduction as the
  RED evidence that motivates the rewrite.
- Change no engine source, no check registry, and no other tests.

Non-goals: archiving `integrate-openspec-with-workflow` itself (a follow-up
archive transition once this merges), changing adapter or contract behavior,
and relaxing any validation the tests assert.

## Capabilities

### New Capabilities

- `engine-test-fixture-independence`: Engine test suites must not depend on
  mutable repository planning state; fixtures are synthetic and
  archive-proof.

### Modified Capabilities

None.

## Impact

- Affected tests: `packages/workflow-engine/test/openspec-adapter.integration.test.ts`,
  `packages/workflow-engine/test/managed-change-contract.integration.test.ts`.
- Affected systems: `workflow-tests` check, CI assurance replay, and the
  archive path for `integrate-openspec-with-workflow`.
- Engine source, schemas, policies, and application code are unchanged.
