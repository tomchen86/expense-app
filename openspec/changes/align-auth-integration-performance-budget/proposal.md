## Why

The post-merge workflow pilot is blocked by a reproducible CI false failure: the login integration test first enforces its declared 400 ms budget through `PerformanceAssertions.testEndpointPerformance()` and then applies a conflicting inline 300 ms assertion to the same measurement. Aligning the test with one declared budget supports the [Roadmap requirement to enable required checks without bypass](../../../docs/ROADMAP.md#finish-repository-workflow-adoption).

## What Changes

- Make the configured `testEndpointPerformance()` limit the single authority for a measured integration request.
- Remove the conflicting duplicate 300 ms assertion from the login integration case while retaining its existing 400 ms budget.
- Record the two observed GitHub CI failures as RED evidence and verify the same targeted test through an explicitly disposable database environment or GitHub CI.
- Keep production authentication behavior, API source, and every other performance budget unchanged.

Scope is limited to the affected authentication integration test and its managed planning artifacts. Non-goals include optimizing login implementation, changing production latency objectives, weakening the 400 ms integration budget, or editing unrelated tests.

## Capabilities

### New Capabilities

- `integration-performance-test-authority`: Defines one authoritative response-time budget per measured integration request and requires CI-safe regression evidence.

### Modified Capabilities

None.

## Impact

- Affected test: `apps/api/src/__tests__/api/integration/auth-flow.spec.ts`.
- Affected systems: GitHub API test gating and the repository's managed-change delivery path.
- API contracts, application code, dependencies, database schema, and runtime behavior are unchanged.
