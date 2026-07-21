## ADDED Requirements

### Requirement: Archive base resolves from the protected remote-tracking ref

Archive eligibility SHALL resolve its verification base from the first
protected branch's remote-tracking ref (`refs/remotes/origin/<branch>`),
using the same protected-base ref spelling as maintainer attestation.
Resolution MUST remain fail-closed, and CI archive replay — which binds to
the archive parent — MUST be unaffected.

#### Scenario: Stale local branch no longer blocks archive

- GIVEN the local protected branch is behind the remote-tracking ref
- AND every canonical task commit is reachable from the remote-tracking ref
- WHEN archive eligibility runs
- THEN the base resolves from the remote-tracking ref
- AND the archive is not blocked by the stale local branch

#### Scenario: Unresolvable base fails closed

- GIVEN the protected branch's remote-tracking ref does not resolve to a
  commit
- WHEN archive eligibility runs
- THEN it fails with the archive base resolution error

#### Scenario: Task commit off the base is still rejected

- GIVEN a canonical task commit is not reachable from the protected
  remote-tracking ref
- WHEN archive eligibility runs
- THEN it fails closed on unreachable task evidence

#### Scenario: One shared spelling across authority paths

- GIVEN maintainer attestation and archive eligibility both resolve the
  protected base
- WHEN either resolves the protected branch ref
- THEN both use the identical `refs/remotes/origin/<branch>` spelling from a
  single shared definition
