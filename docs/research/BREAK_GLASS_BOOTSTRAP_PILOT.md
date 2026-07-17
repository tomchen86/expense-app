# Break-Glass Bootstrap Pilot

## Status

The real bootstrap pilot completed its protected remote path on 2026-07-17
UTC through pull request [#54](https://github.com/tomchen86/expense-app/pull/54).
All normal checks and the base-owned `workflow-assurance` check passed before
the PR was merged through the active main ruleset. The repository remains in
`bootstrap`; this pilot proves the configured authority path but does not
authorize sealing.

This was a non-database pilot. It changed no product code, dependency, check
command, trusted signer, verifier, maintainer policy, or phase. The only
authority-maintenance diff reordered two existing entries in
`workflow/checks.json`; a normalized comparison of the parsed JSON before and
after returned `semanticEquality: true`.

TDD exemption: this task records evidence only. The executable behavior was
exercised by the real pilot, the repository's maintainer-mode integration
tests, and all five pinned non-database checks.

## Trust and Baseline

- Change: `pilot-break-glass-maintainer-authority`
- Managed branch: `work/pilot-break-glass-maintainer-authority`
- Trusted signer identity: `tomchen86`
- Trusted signer fingerprint:
  `SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U`
- Initial planning commit: `440c0d4307a7a7eff65c1eb52ba9bd54a2ee8a35`
- Corrective planning commit after the managed-document probe:
  `ffb9fbf2788b79459a7119766b08a9a80ae8268b`
- Managed handoff-baseline task commit:
  `edad1c109b2f51b1d91fd9eb230a001ac24534e7`
- Successful authority base:
  `edad1c109b2f51b1d91fd9eb230a001ac24534e7`

GitHub's required rebase merge rewrote each PR commit onto `main`. The original
PR identities above remain the identities checked by `workflow-assurance`; the
corresponding main identities are:

| Transition            | PR identity                                | Main identity                              |
| --------------------- | ------------------------------------------ | ------------------------------------------ |
| Initial plan          | `440c0d4307a7a7eff65c1eb52ba9bd54a2ee8a35` | `58383bd`                                  |
| Corrective plan       | `ffb9fbf2788b79459a7119766b08a9a80ae8268b` | `b752854`                                  |
| Handoff baseline      | `edad1c109b2f51b1d91fd9eb230a001ac24534e7` | `0c1bdb8`                                  |
| Authority maintenance | `3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d` | `263f1bdd9cd7cc417eb2db62c1b81df3c98641d0` |
| Local evidence        | `2d5e84f6877381031a9e02832ca8e895b6141563` | `278ba02dd7c8648aa6b35616028726c2d347bbe9` |

The human issued every grant and created the authority commit from a
controlling terminal using the configured passphrase-protected SSH key. No
private key, passphrase, reusable bearer token, or grant-store path is retained
here.

## Negative Grant Evidence

### Explicit and idempotent revocation

- Grant: `0eadc18e-a772-41af-a4e1-e7befc6a2660`
- Audit ref:
  `refs/tags/workflow-grant/0eadc18e-a772-41af-a4e1-e7befc6a2660`
- Observed transition: `available` to `revoked`
- Repeating `maintainer revoke` returned the same `revoked` terminal state.
- Terminal reason: `Explicit maintainer revocation`

### One-minute expiry

- Grant: `fb2eda28-54f5-4133-9ea5-92e6732f48d1`
- Audit ref:
  `refs/tags/workflow-grant/fb2eda28-54f5-4133-9ea5-92e6732f48d1`
- Issued: `2026-07-17T02:38:35.100Z`
- Expired: `2026-07-17T02:39:35.100Z`
- Failure session:
  `session-20260717023955051-54c7f518-dca6-4a9a-a50e-2ba7b3cb19aa`
- `authority-start` failed with `MAINTAINER_GRANT_EXPIRED` after expiry.
- The grant became `revoked` and could not become available again.

### Harmless no-diff check failure

- Grant: `efc6ab40-e5e5-4f4b-b7d3-6b0b57d4d741`
- Audit ref:
  `refs/tags/workflow-grant/efc6ab40-e5e5-4f4b-b7d3-6b0b57d4d741`
- Session:
  `session-20260717025330281-e29c193e-ed80-4cff-8b8a-dcc3ad03b78c`
- `authority-start` reserved the grant on the exact clean base.
- `authority-check` failed with `AUTHORITY_SCOPE_INVALID` because there was no
  changed granted path.
- The reservation closed and the grant became `revoked`.

### Managed-document fail-closed probe and plan repair

- Grant: `049a929b-2b42-47f1-bbbb-3327e8df4350`
- Audit ref:
  `refs/tags/workflow-grant/049a929b-2b42-47f1-bbbb-3327e8df4350`
- Session:
  `session-20260717025630499-d6247548-342f-4e83-9edc-e366da1753fd`
- The ordering-only edit was within the exact grant scope, but
  `managed-documents` found that the planning transition had made the semantic
  handoff stale.
- `authority-check` failed with `CHECK_FAILED` for `managed-documents`; the
  grant became `revoked`.
- With explicit maintainer approval, the sole leftover ordering edit was
  restored. The OpenSpec plan was revised to add Task 1.1, which rendered the
  handoff through the authorized command and passed the full task check and
  final verification before commit `edad1c109b2f51b1d91fd9eb230a001ac24534e7`.

No negative-path grant or failed reservation was reused.

## Successful Authority Evidence

- Grant: `402b4c86-4b97-4c69-8c5c-bba5995b4387`
- Exact protected audit ref:
  `refs/tags/workflow-grant/402b4c86-4b97-4c69-8c5c-bba5995b4387`
- Session:
  `session-20260717032350258-077922a5-19df-42b2-ab4f-eb103776d468`
- Allowed and changed path: `workflow/checks.json`
- Authority-check report:
  `cd104783cf40a1cc14e818d0854e58358094f68b12ff4a4c0bc7a1b3b12f2109`
- Signed authority commit:
  `3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d`
- Parent: `edad1c109b2f51b1d91fd9eb230a001ac24534e7`
- Terminal grant state: `consumed`
- Terminal reason: `Signed authority commit accepted`

The authority check passed these base-pinned checks with
`destructiveDatabase: false`:

- `managed-documents`
- `workflow-format`
- `workflow-lint`
- `workflow-tests`
- `workflow-typecheck`

The commit object contains an SSH signature and exactly these engine-owned
trailers:

```text
Change: pilot-break-glass-maintainer-authority
Transition: authority-maintenance
Grant: 402b4c86-4b97-4c69-8c5c-bba5995b4387
```

Two consecutive `authority-recover` calls verified the trusted-policy journal
and returned the same commit, the same exact changed path, and
`journalState: consumed`. Recovery did not create another commit or make the
grant available.

## Audit-Tag Anomaly

While publishing the successful grant, the destination ref was accidentally
truncated once. The following extra remote ref therefore exists:

```text
refs/tags/workflow-grant/402b4c86-4b97-4c69-8c5c-bba5995b438
```

It and the exact grant ref both point to annotated tag object
`16a6fe3553876cf07c79e4031777c2a4f7edfe09`. The truncated ref is not an exact
grant ID and supplied no authority. It was deliberately not deleted, replaced,
or reused; retaining it preserves the audit anomaly under the protected tag
ruleset.

## Remote Pull Request and CI Evidence

- Pull request: [#54](https://github.com/tomchen86/expense-app/pull/54)
- Exact PR head: `2d5e84f6877381031a9e02832ca8e895b6141563`
- Base-owned Workflow Assurance run:
  [29553270612](https://github.com/tomchen86/expense-app/actions/runs/29553270612)
- Assurance event: `pull_request_target`
- Assurance run start: `2026-07-17T03:48:12Z`
- Assurance completion: `2026-07-17T03:52:17Z`
- Assurance conclusion: `success`
- Protected merge time: `2026-07-17T03:52:54Z`
- Main identity after the rebase merge:
  `278ba02dd7c8648aa6b35616028726c2d347bbe9`

The exact PR head passed all six reported checks:

| Check                | Result    | Duration |
| -------------------- | --------- | -------- |
| `workflow-assurance` | `success` | 4m01s    |
| `API lint & tests`   | `success` | 1m50s    |
| `Mobile checks`      | `success` | 35s      |
| `Web lint & build`   | `success` | 32s      |
| `prettier`           | `success` | 40s      |
| `claude-review`      | `success` | 34s      |

The assurance job imported the protected maintainer audit tags and began
recomputation at `2026-07-17T03:48:46Z`, before the successful grant expired at
`2026-07-17T03:52:01.035Z`. The run completed successfully 16 seconds after
expiry; this records that evaluation was admitted while the grant was valid,
not that an expired grant was reused.

## Protected-State Read-Back

The post-merge GitHub API read-back returned:

- Main ruleset `18963372`, `protect-main-workflow-assurance`: `active`, scoped
  to the default branch, with no bypass actors. It requires pull requests,
  linear history, rebase-only merge, thread resolution, and the strict
  up-to-date `workflow-assurance` status check. Code-owner review is disabled
  for the current solo-maintainer mode.
- Audit-tag ruleset `19080010`, `protect-workflow-grant-audit-tags`: `active`,
  scoped to `refs/tags/workflow-grant/**`, with creation, update, and deletion
  restricted and no configured bypass actors in the ruleset response.
- The exact successful audit ref still points to annotated tag object
  `16a6fe3553876cf07c79e4031777c2a4f7edfe09`.
- The retained truncated anomaly ref also points to that object; it remains
  non-authoritative because its ref name is not the exact grant ID.
- Protected environment `workflow-sealing` has ID `18291408883` and requires
  reviewer `tomchen86` (GitHub user ID `111215589`). No tracked GitHub Actions
  workflow currently declares that environment, so it is configured but is
  not yet an effective sealing gate.

## Rebase Signature Finding

The original authority commit
`3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d` contains the expected SSH
signature. GitHub reports that signature as `unknown_key`, while the
repository-owned verifier trusted it through the pinned signer policy and the
base-owned `workflow-assurance` run passed.

The required rebase merge then created main commit
`263f1bdd9cd7cc417eb2db62c1b81df3c98641d0`. GitHub reports that rewritten
commit as `unsigned`. The protected PR and audit tag retain the evidence that
CI evaluated the original signed commit, but the current rebase-only policy
does not retain the human signature in main history. Sealing must not proceed
until a separate reviewed change defines and proves compatible merge semantics
or otherwise makes the signed authority identity durable without weakening
the base-owned checks.

## Remaining Bootstrap-to-Sealed Boundary

This pilot is complete and may be archived, but the repository remains
bootstrap-only. Before a separate one-way sealing change may proceed:

1. Resolve and pilot the rebase-signature durability finding.
2. Bind the sealing workflow to the protected `workflow-sealing` environment
   and verify its approval behavior.
3. Confirm or rotate to a human-presence hardware signer while the parent
   policy remains in bootstrap.
4. Complete or retain the separate ordinary plan/task/archive pilot evidence
   required by `docs/WORKFLOW.md`.

No pilot grant, tag, commit, check result, or environment configuration is by
itself authority to change `workflow/maintainer-policy.json` from `bootstrap`
to `sealed`.
