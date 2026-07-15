# Tasks

Phase 0 is the explicitly authorized dependency-and-planning baseline recorded
in `design.md`; it is not a retroactive executable task.

Each behavior task completes RED → GREEN → REFACTOR within one managed task. A
RED-only commit cannot satisfy workflow completion checks.

## 1. Portable Test and OpenSpec Process Boundary

- [x] 1.1 Reproduce the package-filter CWD regression and OpenSpec reserved
      `changes/archive` misclassification from the root workflow suite, then
      make repository resolution module-relative and active-change enumeration
      OpenSpec-compatible so root/package-scoped tests pass with the same set.
- [x] 1.2 Add contract tests and implement the typed, shell-free OpenSpec 1.6.0
      adapter with exact binary resolution, isolated environment,
      timeout/output limits, strict JSON/stderr handling, and canonical
      root/path validation.
- [ ] 1.3 Extend workflow doctor with pinned-version, package provenance,
      root/store, schema-payload, and OpenSpec diagnostics without trusting
      process exit status alone.

## 2. Planning Transition Authority

- [ ] 2.1 Add planning-transition contract tests and implement the planning
      commit command with a content-addressed report, planning-only diff checks,
      exact staging, compare-and-swap commit construction, and exclusive
      `Change:` plus `Transition: plan` trailers.
- [ ] 2.2 Extend hooks and CI for planning introductions/revisions,
      active-session exclusion, stale-evidence invalidation, exact
      bootstrap-exception verification, and rejection of code, checkbox,
      base-spec, archive, other-change, or mixed-trailer diffs.

## 3. Project Schema and Combined Validation

- [ ] 3.1 Fork the pinned `spec-driven` schema to project-local `expense-app`,
      add the apply-required guard artifact, configure the project default, and
      implement strict schema, guard, task, check-ID, path, provenance, and
      payload validation without changing this change's metadata in the task
      commit.

After Task 3.1 and with no active session, use the delivered planning transition
to migrate only this change's `.openspec.yaml` from `spec-driven` to
`expense-app`. This is a planning revision, not a checkbox task, and it must be
committed before Task 3.2 starts.

- [ ] 3.2 Combine OpenSpec status and strict change validation with repository
      policy, full regular-file/mode digests, stable diagnostics, and one
      validated contract consumed consistently by session start, check, and
      finish.

## 4. Planning-Only Codex Integration

- [ ] 4.1 Generate only reviewed OpenSpec explore/propose assets in isolated
      temporary homes, apply the repository overlay, record source/overlay
      digests, add check-only drift validation, and implement an explicit
      non-overwriting planning-prompt installer without writing to a real Codex
      home during tests.

## 5. Workflow-Owned Archive

- [ ] 5.1 Add archive eligibility tests and implement canonical identity,
      completion evidence, base reachability, active-session, worktree,
      artifact, destination, mode, and exclusive-lock preconditions using
      existing workflow primitives.
- [ ] 5.2 Execute the exact pinned OpenSpec archive operation only in an
      isolated detached temporary worktree and verify JSON roots, UTC
      destination, delta targets, rebuilt specs, full-index patch paths, modes,
      digests, and partial-failure isolation before real-worktree mutation.
- [ ] 5.3 Add archive reports, fingerprint rechecks, verified patch application,
      exact staging/commit authorization, `Transition: archive` trailers,
      fault/concurrency coverage, and workflow-owned already-archived
      detection.

## 6. Recomputed Repository Assurance

- [ ] 6.1 Recompute task, plan, and archive validity in hooks and the stable
      `workflow-assurance` CI job, including dependency/schema/asset drift,
      forbidden lifecycle assets, bypass cases, archive replay, and UTC-date
      normalization.
- [ ] 6.2 Add a disposable-repository end-to-end rehearsal covering planning
      validation, plan commit, managed task completion, archive, idempotency,
      and cross-date CI replay without claiming that the real post-merge pilot
      has run.

## 7. Documentation and Pilot Handoff

- [ ] 7.1 Update active repository guidance, the task/plan/archive trailer
      matrix, OpenSpec upgrade procedure, observed Codex discovery status,
      Spectra compatibility boundary, semantic handoff, and exact instructions
      for the separate post-merge pilot without commit hashes or unsupported
      invocation claims.

## 8. Post-Merge Pilot Gate

The real pilot is intentionally not an executable task of this change. After
this integration is merged and reachable from the configured base, create a
separate small non-database OpenSpec change, execute and archive it through the
delivered workflow, replay it in CI, and only then declare the integration
supported.
