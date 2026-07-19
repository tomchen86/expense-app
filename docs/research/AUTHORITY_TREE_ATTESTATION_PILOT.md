# Authority Tree Attestation Pilot Evidence

_Recorded: July 19, 2026_

This document records the exact evidence for tasks 4.1 and 4.2 of the
`add-authority-tree-attestation` change: the protected-tag configuration, the
human-signed pilot attestation for the three observed original/main mappings,
and the successful base-owned replay that cleared the intentional migration
gate. It is evidence, not authority; the verifier remains the base-owned
workflow code, and the repository remains **bootstrap-only**.

## Implementation delivery

- Implementation PR: `#57` (`work/add-authority-tree-attestation`), merged
  2026-07-18T07:49:13Z by `tomchen86-bot` through the protected path: required
  `workflow-assurance` success, up-to-date base, rebase merge, no ruleset
  exception or bypass.
- Managed original commits `866b043` (task 1.1), `1ebaffe` (2.1), `1442f2f`
  (2.2), `f2aefc6` (2.3), `b34dab2` (3.1) were rebase-rewritten onto `main`
  ending at `fa50b1c93f99707fa1eeefc333bbda9239c118d6`. These are ordinary
  task commits; only authority-maintenance commits require attestation.

## Remote tag protection read-back

Repository rulesets active at pilot time (REST `GET /repos/{owner}/{repo}/rulesets`):

| Ruleset                             | Target | Enforcement |
| ----------------------------------- | ------ | ----------- |
| `protect-main-workflow-assurance`   | branch | active      |
| `protect-workflow-grant-audit-tags` | tag    | active      |
| `protect-workflow-attestation-tags` | tag    | active      |

The `workflow-attestation/**` tag ruleset was created by the maintainer in the
GitHub UI before the pilot tag was published, denying creation, update, and
deletion with maintainer-only bypass. Full bypass-actor detail requires
repository administration and is intentionally not readable by the
write-scoped automation identity; the maintainer verified it in the UI.

## Human-signed pilot attestation

Issued by the maintainer from a clean fetched worktree at detached
`origin/main`, on a controlling terminal, with the trusted encrypted signer:

```bash
pnpm workflow maintainer attest \
  --original 3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d \
  --main     263f1bdd9cd7cc417eb2db62c1b81df3c98641d0 \
  --base 440c0d4307a7a7eff65c1eb52ba9bd54a2ee8a35=58383bd05717e8df3400e6b55ac00f74aede5a16 \
  --base edad1c109b2f51b1d91fd9eb230a001ac24534e7=0c1bdb85c9cdd908611db86e922ad49481662f3c \
  --json
```

The tag was pushed by the maintainer's own SSH identity (not the automation
identity, which the tag ruleset correctly rejects):

- Tag ref: `refs/tags/workflow-attestation/402b4c86-4b97-4c69-8c5c-bba5995b4387`
- Tag object: `e3c84482163a93c001b9b8d76606894ea4fc0d53` (identical local and
  remote by `git ls-remote`)
- Tag target: `3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d` — the signed original
  authority commit, permanently retained by the tag
- Signature namespace: `expense-app.workflow.authority-attestation.v1`
  (distinct from grant issuance)

### Attested mappings

| Role              | Original (signed)                          | Protected-main (rebased)                   |
| ----------------- | ------------------------------------------ | ------------------------------------------ |
| Primary authority | `3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d` | `263f1bdd9cd7cc417eb2db62c1b81df3c98641d0` |
| Grant base (plan) | `440c0d4307a7a7eff65c1eb52ba9bd54a2ee8a35` | `58383bd05717e8df3400e6b55ac00f74aede5a16` |
| Grant base (task) | `edad1c109b2f51b1d91fd9eb230a001ac24534e7` | `0c1bdb85c9cdd908611db86e922ad49481662f3c` |

Every pair was validated before signing: equal result trees, equal
single-parent trees, byte-identical canonical managed messages, the exact
grant binding, and the original SSH commit signature under trusted policy.
The grant-base mappings carry the sorted grant IDs bound to
`440c0d4…` (the four published pilot grants) as discovered from the protected
`workflow-grant/**` tags.

## Base-owned replay result

`verifyBaseAuthorityAttestations` executed against
`main = fa50b1c93f99707fa1eeefc333bbda9239c118d6` after the tag was published:

```json
{
  "attestedAuthorities": [
    {
      "grantId": "402b4c86-4b97-4c69-8c5c-bba5995b4387",
      "changeId": "pilot-break-glass-maintainer-authority",
      "originalCommit": "3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d",
      "mainCommit": "263f1bdd9cd7cc417eb2db62c1b81df3c98641d0"
    }
  ]
}
```

Exactly one authority transition exists on protected first-parent history and
it resolves to exactly one valid protected attestation. Before the tag was
published, the same replay failed closed with `CI_ATTESTATION_MISSING`; that
red window between the verifier merge and this publication was the intended
migration gate, and it was cleared by maintainer tag publication — not by
disabling or bypassing any required check.

## Bootstrap-only remainder

This pilot does not declare sealed enforcement. Still separately required
before the one-way `bootstrap` → `sealed` transition:

1. Bind and verify the protected `workflow-sealing` environment to a tracked
   workflow.
2. Confirm or rotate to a human-presence hardware signer while the parent
   policy still trusts the current encrypted software key; retain the pilot
   signer in the sealed trust lineage so this history stays verifiable.
3. Review `sealedImmutablePaths`, then perform the sealing transition through
   an old-key-authorized authority commit and attest its rebased result
   through this same mechanism.

The pull request that carries this evidence document is itself the first
post-gate pull request; its base-owned `workflow-assurance` result is the
CI-grade confirmation recorded for task 4.2 after merge.
