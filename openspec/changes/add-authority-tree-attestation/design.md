## Context

The bootstrap pilot created a human-signed authority commit
`3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d`. GitHub's required rebase merge
then placed an unsigned commit
`263f1bdd9cd7cc417eb2db62c1b81df3c98641d0` on `main`. Their result trees and
their parent trees are equal, and their managed messages identify the same
change and grant, but the commit object signed by the maintainer is not the
object reachable from `main`.

The same rewrite affected grant bases used by the pilot. The historical audit
tags reference original commits while replay now starts from protected-main
commits. GitHub branch governance must remain strict, current-base, no-bypass,
and rebase-only, so preserving an identical commit SHA on `main` is not an
available invariant.

Trust is split across three boundaries:

- the protected branch decides which rewritten commit is authoritative;
- retained Git objects and protected tags preserve the signed original and its
  human-signed statement;
- base-owned workflow code and trust material decide whether the mapping is
  acceptable. Candidate code or candidate-added signers cannot validate their
  own evidence.

## Goals / Non-Goals

**Goals:**

- Bind each protected-main authority commit to one retained signed original
  without weakening rebase-only merge governance.
- Prove both the resulting state and the transition source state are identical,
  and preserve the authority's canonical managed identity.
- Map historical grant `baseCommit` identities to protected-main equivalents by
  the same rules.
- Make missing, conflicting, ambiguous, or candidate-self-authorized evidence
  fail closed in base-owned replay.
- Provide a human-present command and a concise publication handoff instead of
  requiring hand-authored JSON or Git tag objects.

**Non-Goals:**

- Enabling the `workflow-sealing` environment or changing GitHub branch merge
  rules.
- Rotating the signing key or changing `workflow/maintainer-policy.json` to
  `sealed`.
- Treating tree equality alone as sufficient authority.
- Importing an external SLSA service, transparency log, or new cryptographic
  dependency.
- Rewriting or replacing the already published grant envelopes.

## Decisions

### 1. Attest transition identity, not commit identity

An authority mapping contains an original commit `O` and protected-main commit
`M`. Verification requires all of the following:

- `tree(O) == tree(M)`;
- both commits have exactly one parent and
  `tree(parent(O)) == tree(parent(M))`;
- their complete commit messages are byte-identical and parse as the same
  canonical authority transition (`Change`, `Transition`, and `Grant`);
- `O` has a valid SSH commit signature from the grant signer under trusted
  policy, and its protected grant envelope remains valid at `O`'s commit time;
- `M` is on the protected branch's first-parent history and `O` is retained by
  the attestation tag.

Result-tree equality proves the checked state survived the rebase. Parent-tree
equality proves the same diff was applied. Exact message equality preserves the
human-signed authority identity that a tree does not contain.

Using only `tree(O) == tree(M)` was rejected because the same state can be
reached from a different source tree or advertised with different authority
trailers. Requiring identical commit SHAs was rejected because it is
incompatible with the required rebase merge.

### 2. Store one canonical signed envelope in a protected tag

`pnpm workflow maintainer attest` creates a versioned canonical envelope using
the existing interactive SSH signer boundary. The primary mapping's grant ID
determines the immutable tag name
`refs/tags/workflow-attestation/<grant-id>`, and the annotated tag targets `O`
so the signed original remains reachable.

The signed payload binds the stable repository identity and origin, protected
branch name, primary authority mapping, explicit grant-base mappings, issue
time, signer identity, and the policy/trust material used for verification.
The signature namespace is distinct from grant issuance. Exact-key parsing,
canonical serialization, bounded sizes, full object IDs, sorted unique mapping
sets, and exact tag headers prevent ambiguous encodings.

The command accepts `O`, `M`, and any additional grant-base pairs. It derives
the primary grant and parent pair from the authority commits, discovers the
protected grant tags bound to each original base, validates every pair before
signing, creates only the local tag, and returns one exact `git push` command.
It requires a clean worktree, a controlling TTY, the configured human-present
signer, and a fetched protected-main ref containing every claimed main commit.

A repository file was rejected as the evidence store because adding the
evidence would itself require another commit and would not retain `O`. An
unsigned lightweight tag was rejected because it cannot bind the mapping or
signer.

### 3. Verify grant bases with the same mapping primitive

Each grant-base entry names an original base, a protected-main equivalent, and
the sorted grant IDs whose signed payloads reference that original base. The
verifier requires equal result trees, equal parent trees, byte-identical
canonical managed messages, main reachability, exact audit-tag targets, and
matching `baseCommit` fields. A grant that is now expired may be replayed only
as history: its signed issuance bounds remain valid and any successful authority
commit must have been created inside them.

The migration envelope will carry these observed pilot pairs rather than
hard-coding them in policy or source:

- `440c0d4307a7a7eff65c1eb52ba9bd54a2ee8a35` ↔
  `58383bd05717e8df3400e6b55ac00f74aede5a16`;
- `edad1c109b2f51b1d91fd9eb230a001ac24534e7` ↔
  `0c1bdb85c9cdd908611db86e922ad49481662f3c`;
- primary authority `3f9cc46ec6018b1e02d3db1553af1ca3a00c2e9d`
  ↔ `263f1bdd9cd7cc417eb2db62c1b81df3c98641d0`.

Implicit search for any same-tree commit was rejected because it can become
ambiguous and does not record which protected identity the human approved.

### 4. Replay from base-owned code and fail closed

The trusted workflow code loaded from the pull-request base scans the base's
first-parent history for authority trailers before candidate commits are
evaluated. Every such main commit must resolve to exactly one protected
attestation whose tag, payload, signature, original commit, authority grant,
and explicit base mappings all verify. Duplicate originals, duplicate main
targets, conflicting mappings, missing objects, malformed tags, mismatched
trees/messages, invalid signatures, and main-unreachable targets fail closed.

Both the original authority signature and the attestation signature must remain
valid under the trusted signer lineage. A future sealing change must retain the
pilot signer as a historical verification key (or add a separately specified
old-key-authorized cross-signing mechanism) so key rotation cannot erase
provenance. Candidate-added trust is never considered while validating that
candidate.

The implementation PR is evaluated by the previous base-owned verifier. Once
it merges, the new verifier intentionally blocks the next PR until the
historical migration tag is protected, published, and replayable. This creates
a narrow explicit migration gate rather than a silent compatibility exception.

### 5. Keep remote controls and sealing as separately proven gates

The repository can verify an attestation tag's object and signature, but Git
history alone cannot prove the GitHub ruleset protecting
`workflow-attestation/**`. Pilot evidence therefore records the effective tag
ruleset and remote replay separately. The repository remains `bootstrap` after
this change. Environment binding, hardware-signer confirmation or rotation,
trust-root hardening, and the one-way sealed transition remain separately
approved work.

## Risks / Trade-offs

- **[Missing migration tag blocks all later PRs]** → Merge implementation only
  when the maintainer is available to protect and publish the pilot tag; retain
  the previous verifier on the implementation PR base and document recovery.
- **[A same-tree commit represents different authority]** → Require equal
  parent trees, byte-identical messages, canonical trailers, the exact grant,
  and the original SSH signature.
- **[A tag is replaced or duplicated]** → Use a grant-derived immutable name,
  exact tag headers, uniqueness checks, and a GitHub no-bypass tag ruleset.
- **[Historical grants are expired at replay time]** → Validate their canonical
  signatures and original time window, but do not require an old grant to remain
  currently unexpired.
- **[Signer rotation invalidates history]** → Make sealed verification require
  the historical signer in the sealed trust lineage unless a later governed
  cross-signing design replaces that requirement.
- **[History scanning grows]** → Scan only canonical authority commits on the
  protected first-parent history and keep the verifier deterministic; optimize
  only after measured cost.

## Migration Plan

1. Commit this OpenSpec plan and refresh the generated handoff through a normal
   scoped task.
2. Add RED contract/integration cases for canonical parsing, human-only
   issuance, tree/parent/message mismatches, uniqueness, historical expiry, and
   grant-base replay; implement until all workflow checks pass.
3. Merge the implementation PR while the old base-owned verifier remains the
   authority for that PR.
4. Configure and read back no-bypass protection for
   `workflow-attestation/**`.
5. From an updated clean controlling worktree, create the pilot envelope for
   the three observed mappings, publish its tag, and run base-owned replay.
6. Complete the post-merge evidence task, merge it, confirm the following
   archive PR passes the new verifier, and archive the change.
7. Plan environment binding, signer confirmation/rotation, immutable-path
   hardening, and the one-way sealed transition separately.

Rollback before step 3 is ordinary managed task rollback. After the verifier is
on `main`, do not weaken or bypass it: repair a malformed/missing tag through
the documented maintainer-controlled tag publication path. A published
conflicting protected tag is an administrator recovery event, not an automatic
rewrite.

## Open Questions

No implementation-blocking questions remain. The later sealing change must
choose whether the current encrypted human-present key remains an active signer
or a historical verification-only key when a hardware signer is added.

