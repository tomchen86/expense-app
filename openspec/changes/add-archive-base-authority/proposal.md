## Why

Archive eligibility resolves its verification base from
`config.protectedBranches[0]` as a **bare local branch ref**
(`archive-eligibility.ts:85`). Long-lived clones proved the failure twice:
a stale local `main` makes every task commit unreachable
(`ARCHIVE_TASK_COMMIT_UNREACHABLE`) until someone force-moves the branch —
the root cause of every `git branch -f main origin/main` workaround this
program has needed.

The repository already solved this class of problem, two days after the
original T1.3 memo was written: `maintainer-attestation.ts:90` resolves the
protected branch as `refs/remotes/origin/<branch>` (a remote-tracking ref)
precisely because local branches go stale, and `ci-attestation.ts` reads
protected branches from the base tree the same way. Archive eligibility is
the last consumer still trusting a bare local ref. The fix is to align it
with the existing precedent, not to invent a parallel mechanism.

## What Changes

- Extract the protected-base ref spelling into one shared helper
  (`protectedBranchRef`) so `refs/remotes/origin/<branch>` is defined in a
  single place. Both `maintainer-attestation.ts` and `archive-eligibility.ts`
  consume it — eliminating the divergence rather than adding a second copy.
- Archive eligibility resolves the base as the remote-tracking ref, so base
  freshness no longer depends on local branch upkeep. Resolution stays
  fail-closed: a missing or unresolvable `refs/remotes/origin/<branch>`
  keeps failing with `ARCHIVE_BASE_UNRESOLVED`.
- Archive test fixtures establish `refs/remotes/origin/<branch>` at the
  integration-base tip, mirroring today's local-`main` base into the ref the
  engine now reads, so existing archive semantics are preserved exactly.

This **supersedes** the original proposal's `archiveBaseRef` config field:
the field would have been a new authority artifact requiring a break-glass
edit and, absent, would have kept the bare local ref — leaving the staleness
bug unfixed by default and ignoring the attestation precedent. Aligning to
the remote-tracking ref fixes staleness by default with no config surface
and no grant.

Non-goals: a per-repository configurable base, multi-protected-branch
selection, CI archive replay changes (replay binds to the archive parent,
not the live base), or any silent local-ref fallback.

## Capabilities

### Modified Capabilities

- `repository-governance`: the archive verification base resolves from the
  protected branch's remote-tracking ref, consistent with maintainer
  attestation, instead of a stale-prone bare local ref.

### New Capabilities

None.

## Impact

- Affected engine source: `packages/workflow-engine/src/git.ts` (shared
  helper), `packages/workflow-engine/src/archive-eligibility.ts`,
  `packages/workflow-engine/src/maintainer-attestation.ts`.
- Affected tests: the archive-commit-building integration fixtures
  (`fixture.ts` helper plus `archive-eligibility`, `archive-transition`,
  `archive-transformation`, `ci-archive`, `workflow-rehearsal` integration
  suites).
- Baseline task also recorded the ISS-111 closure in the managed issue log
  (guarded issue paths; deferred from make-api-jwt-fail-closed).
- No config schema change, no authority-file edit, no break-glass grant.
