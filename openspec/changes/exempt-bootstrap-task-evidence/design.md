## Context

`archive-eligibility.ts` and `ci-archive.ts` both call `findExactTaskCommits`
and require exactly one canonical trailer commit per completed task. The
bootstrap change predates that convention: its early work landed in commits
without task trailers (tasks 1.1, 1.2) or across several trailered commits
(task 2.1). History behind the protected branch is immutable, so the
requirement can never be satisfied retroactively, and the change's archive is
the only remaining blocked transition.

## Goals / Non-Goals

**Goals:**

- Derive a per-change evidence epoch from Git alone and exempt only
  pre-epoch task completions.
- Keep the exempt set provably empty for every change born through a
  canonical plan introduction.
- Apply one shared derivation in live eligibility and CI replay.

**Non-Goals:**

- Pinned commit tables or change-ID special cases.
- Weakening evidence, ancestry, or task-history rules inside the canonical
  regime.

## Decisions

### Epoch = the change's earliest canonical plan commit

A commit qualifies as canonical planning only by byte-exact managed message
(`Plan <change-id>` plus trailers), the same rule CI replay enforces. The
earliest such commit reachable from the evaluation tip defines the epoch; the
tasks already completed in its **before** tree form the exempt set. Ordinary
introductions must contain only unchecked tasks (`PLANNING_TASK_STATE_INVALID`
otherwise) and a change tree cannot reach main without its introduction, so
post-bootstrap changes always yield an empty exempt set. The bootstrap
change's first canonical plan commit is its repair revision, whose before
tree already carried every task checked — precisely the history the rule
describes.

Alternative: pin a bootstrap evidence table (ci-bootstrap style). Rejected —
permanent one-off code and a second authority for facts Git already states.

Alternative: tolerate zero-or-many evidence generally. Rejected — it guts
the invariant for every future change.

### Exempt tasks degrade to unrecorded, never to unverified

An exempt task with exactly one canonical commit keeps full recording and
reachability assertions. With zero or several, the task contributes no
recorded commit; nothing else about the archive weakens. Recording an
ambiguous set would assert provenance the history cannot support.

## Risks / Trade-offs

- **[A future change tries to smuggle pre-checked tasks]** → its tree can
  only enter main through a plan introduction whose tasks must be unchecked;
  a checked task in the introduction fails planning validation, so the
  exempt set stays empty.
- **[Live and replay drift]** → both sides call the same exported helper
  with their respective tips (HEAD, archive parent).
