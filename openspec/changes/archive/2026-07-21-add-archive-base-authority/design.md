## Context

`archive-eligibility.ts` sets `baseRef = config.protectedBranches[0]` and
`resolveBase` runs `rev-parse --verify <baseRef>^{commit}` — so the base is
the local branch `main`, whose freshness is nobody's contract. Two archive
attempts failed on stale clone-local `main`, each repaired by manual
`git branch -f main origin/main`.

`maintainer-attestation.ts` (landed 2026-07-19, after the T1.3 memo) already
resolves `refs/remotes/origin/${protectedBranches[0]}` and fails closed if
that ref is unreachable; `ci-attestation.ts` reads protected branches from
the base tree. The base-authority problem the memo describes was, by the
time we reached it, already solved everywhere except archive eligibility.
The original proposal missed this because its frame (add a config field)
predated the precedent.

## Goals / Non-Goals

**Goals:**

- One definition of the protected-base ref spelling, consumed by both the
  attestation and archive paths.
- Archive base freshness independent of local branch upkeep.
- Existing archive test semantics preserved: switching the ref the engine
  reads must not change which base any current test intends.

**Non-Goals:**

- A configurable `archiveBaseRef` field (superseded), multi-base support,
  CI archive replay changes, or any local-ref fallback.

## Decisions

### Share the ref spelling; keep each caller's verification

`protectedBranchRef(branch: string): string` returns
`refs/remotes/origin/${branch}` and lives in `git.ts` as a pure function.
`maintainer-attestation.ts` replaces its inline template with this call —
byte-identical output, so its downstream `protectedRef` usage, ancestry
checks, and error codes are untouched. `archive-eligibility.ts` builds
`baseRef` from it and keeps its own `resolveBase`
(`rev-parse --verify ^{commit}` + hash check + `ARCHIVE_BASE_UNRESOLVED`).
Sharing only the spelling — not the verification — fixes the divergence at
its actual source while leaving both callers' fail-closed contracts exactly
as they are.

Alternative: copy the origin-ref spelling inline into archive-eligibility.
Rejected — that recreates the very duplication that caused this bug; the
next consumer would again copy whichever form it found first.

Alternative: prefer origin, fall back to local main when absent. Rejected —
a fallback is the silent inference the memo forbids and would newly diverge
from attestation, which is strict origin-only.

### Fixtures mirror the local base into the remote-tracking ref

Every archive-commit-building fixture currently relies on "base = local
`main` at work-branch checkout". A shared `syncOriginMain` fixture helper
snapshots `main` into `refs/remotes/origin/main` at that same point, so the
ref the engine now reads holds exactly the commit the fixture always
intended as the base. Tests that deliberately place a task commit off the
base (unreachable cases) keep failing closed, because the snapshot is taken
before the work-branch divergence. No test's meaning changes; only the ref
name the engine consults does.

## Risks / Trade-offs

- **[Broad fixture surface]** → five integration suites build archive
  commits, but they funnel through a few fixture-builder helpers plus one
  shared `syncOriginMain`; the change is mechanical and each suite is gated
  by `session.integration.test.ts` under the required `workflow-tests`
  check.
- **[Touching the attestation authority path]** → the edit is a single
  ref-string construction with identical output, exercised by the existing
  `maintainer-attestation.integration.test.ts` under `contracts.test.ts`;
  no attestation behavior changes.
- **[Configured ref stale or wrong]** → resolution and ancestry checks fail
  closed exactly as before; the change alters which ref is consulted, never
  the verification standard.
