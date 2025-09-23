# Phase 3 Testing & Quality Improvements

_Last updated: 2025-09-22 20:52 AEST_

## Summary
Phase 3 focuses on hardening the mobile testing pipeline through stronger coverage enforcement, performance visibility, and CI/CD feedback. The foundational tooling is now in place, though coverage thresholds are **not yet met** and require follow-up test authoring.

## Completed Work
- **Coverage Governance**
  - Raised global Jest thresholds to 80% branches / 85% lines, functions, and statements with 95%+ targets for the `src/store` folder.
  - Expanded coverage reporters to include `html-spa` for easier navigation of uncovered lines.
  - Added granular pnpm scripts for unit, integration, component, performance, and coverage runs.
- **Performance Benchmarks**
  - Introduced `src/__tests__/performance/store-performance.test.ts` to track insertion latency, aggregation throughput, and heap growth for the expense store.
  - Exposed `pnpm run test:performance` for on-demand benchmarking.
- **Bundle Analysis Readiness**
  - Created `apps/mobile/webpack.config.js` with a gated `BundleAnalyzerPlugin` that writes reports to `apps/mobile/reports/` when `ANALYZE_BUNDLE=true` (or `--analyze=true`).
- **CI/CD Enhancements**
  - Replaced the single-job workflow with an OS + test-type matrix (unit/integration/component) and a dedicated coverage job that uploads Artifacts/Codecov results while warning on coverage regressions.
  - Updated the summary comment to surface coverage status alongside other quality gates.
- **Developer Workflow**
  - Enabled Husky and added a pre-commit hook to run `pnpm run test:unit:fast`, `pnpm run lint:fix`, and `pnpm run typecheck` inside `apps/mobile`.
  - Added `lint:fix` to accelerate minor formatting fixes during development.

## Current Status
- Latest local `pnpm run test:unit -- --maxWorkers=2` ✅
- Latest local `pnpm run test:performance` ✅
- Latest local `pnpm run test:coverage:html` ❌ (fails coverage thresholds at ~19% coverage)
- Coverage job in CI will warn until test suites are expanded to satisfy the new targets.

## Risks & Follow-Up
1. **Coverage Debt**: Major features remain untested; coverage thresholds will keep failing until the test suites from Phase 1 & 2 plans are implemented.
2. **Performance Baseline Sensitivity**: Benchmarks are tuned for current hardware; large regressions should still be caught, but future state changes may warrant tightening the limits.
3. **Bundle Analysis Adoption**: `webpack.config.js` is ready, but reports are only generated when explicitly requested—teams should incorporate it into release readiness if bundle size becomes a concern.
4. **Pre-commit Duration**: Running lint+typecheck per commit may feel heavy; consider caching or selective runs if it slows contributors.

## Recommended Next Steps
1. Backfill store/component/screen tests to lift coverage above the enforced thresholds.
2. Create integration tests for user-critical flows (Add Expense, Group Balances, Insights navigation) to meet Phase 2 commitments.
3. Document how to run the new bundle analyzer and interpret performance benchmarks in developer onboarding materials.
4. Monitor CI runtime after a few runs; adjust matrix granularity if overall build time regresses.

---
Prepared by Codex (Phase 3 execution support).
