## Context

`auth-flow.spec.ts` delegates response-time enforcement to `PerformanceAssertions.testEndpointPerformance()`. The login case passes 400 ms to that helper, then evaluates the returned metric again against 300 ms. GitHub Actions measured 323.06 ms and 321.18 ms in consecutive runs, so the undeclared second limit reproducibly blocks unrelated governance changes even though the declared integration budget passes.

The API suite writes to PostgreSQL. A local targeted run is permitted only with an explicitly disposable `TEST_DATABASE_URL`; the GitHub API job provides that database boundary. OpenSpec plans the repair, the workflow guard limits task edits, and GitHub CI remains the integration-test authority.

## Goals / Non-Goals

**Goals:**

- Preserve the login integration case's explicit 400 ms response-time budget.
- Ensure one measured request has one response-time authority.
- Restore meaningful required-check behavior without bypassing API CI.
- Keep the task test-only and reviewable as an independent prerequisite change.

**Non-Goals:**

- Change authentication implementation or API behavior.
- Relax the declared 400 ms integration budget.
- Change other endpoint budgets, performance helpers, or production objectives.
- Run database-writing tests against any non-disposable database.

## Decisions

### Use the helper argument as the single authority

The login case will keep `testEndpointPerformance(..., 400)` and stop destructuring or asserting the returned metric solely for a second threshold. The helper already fails the test when the request reaches 400 ms, so removing the duplicate does not remove performance enforcement.

Alternative: change the inline assertion from 300 ms to 400 ms. Rejected because it retains two authorities that can drift later and adds no evidence beyond the helper.

Alternative: raise both limits. Rejected because CI passes the declared 400 ms budget and there is no evidence for a broader latency-policy change.

### Treat the existing CI failures as RED evidence

The two PR #49 API runs supply reproducible RED evidence at 323.06 ms and 321.18 ms. The test-only change will be checked locally with non-destructive registered checks. The targeted database-writing test will run only when an explicitly disposable database is available; otherwise GitHub's disposable PostgreSQL job supplies GREEN evidence before merge.

Alternative: provision or infer a local database fallback. Rejected because repository policy forbids database-writing tests without an explicitly disposable target.

### Keep trust boundaries explicit

The task guard will allow only `apps/api/src/__tests__/api/integration/auth-flow.spec.ts`. Its registered checks will verify formatting and the repository's non-destructive API database-target policy. Full API integration evidence remains a remote required check, and any repeated failure will block merge rather than be bypassed.

## Risks / Trade-offs

- [Risk] A real login slowdown between 300 ms and 400 ms is no longer rejected by the conflicting inline assertion. → Mitigation: 400 ms was already the case's declared integration budget and remains enforced by the helper; a stricter target requires a separate measured policy change.
- [Risk] A GitHub runner could still exceed 400 ms. → Mitigation: the helper will fail normally, preserving a meaningful regression signal.
- [Risk] Local GREEN evidence may be limited by the absence of a disposable PostgreSQL target. → Mitigation: run only non-destructive local checks and require the GitHub API job before merge.

## Migration Plan

1. Commit the planning artifacts through `workflow plan-commit`.
2. Start the single task and remove only the duplicate inline metric assertion/destructuring.
3. Run the task's registered non-destructive checks.
4. Push the completed managed change and require GitHub API CI to pass with its disposable database.
5. Merge, update PR #49 onto the new base, and rerun its checks.

Rollback is a revert of the managed task commit. Reintroducing a stricter performance budget would require a new change that declares one authoritative threshold and supplies measurement evidence.

## Open Questions

None.
