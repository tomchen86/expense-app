## Context

The workflow engine deliberately anchors existing policy and rejects ordinary
task edits that would redefine their own authority. That is correct for routine
work but leaves no governed bootstrap or emergency path. The local boundary is
the Git common directory shared by all linked worktrees; the remote boundary is
GitHub CI evaluating an untrusted candidate tree against the merge-base.

This change installs the mechanism through ordinary reviewed task commits. It
does not use its own break-glass path during bootstrap. After merge, every
authority-maintenance commit is evaluated by the engine and trust policy from
its parent/base, while the pull-request job runs the verifier from the trusted
base checkout. Candidate changes therefore cannot authorize themselves.

## Goals / Non-Goals

**Goals:**

- Require a fresh human-present SSH signature for one exact authority change.
- Bind grants to a stable repository identity, canonical remote, full base
  commit, change ID, exact paths, reason, expiry, and one use.
- Share reservation and consumption state safely across linked worktrees.
- Preserve every existing schema, path, runner, document, secret, database,
  branch, and CI check.
- Produce a signed fourth managed commit kind and verify it independently in
  CI using only parent/base trust material.
- Provide fail-closed recovery, explicit revocation, replay detection, key
  rotation, and an auditable one-way bootstrap-to-sealed transition.

**Non-Goals:**

- No product, API, mobile, web, or database behavior.
- No unattended signer, environment bypass, force flag, repository boolean,
  broad grant glob, multi-use v1 grant, or ordinary task escape hatch.
- No automatic push, merge, GitHub ruleset mutation, or repository-admin
  recovery automation.

## Decisions

### 1. Use a versioned trusted-base policy and SSH signatures

`workflow/maintainer-policy.json` is schema validated and contains the stable
GitHub repository identifier, canonical origin, phase, eligible bootstrap
paths, immutable sealed paths, trusted signer identities/public keys, SSH
signature namespaces, audit-tag prefix, and required check IDs. The first
version trusts the existing `tomchen86` ED25519 public key.

Every authority operation pins the policy blob from the grant base commit.
CI loads that same policy from the authority commit's parent. A candidate
policy can become effective only after a valid old-policy-authorized commit is
merged. In sealed phase, immutable verifier and trust-loader paths are denied
even when named by a grant. A key rotation is therefore an old-key-signed
policy change; a candidate key cannot trust itself.

SSH was chosen because OpenSSH is already available and supplies detached data
signing plus Git commit signing without another runtime dependency. The
production provider resolves the configured signing-key file, removes agent
and askpass variables, requires controlling input/output TTYs, and accepts only
a FIDO/security-key signer or an encrypted private key that must prompt on the
controlling terminal. An unencrypted software key and a non-TTY process are
rejected before a grant is written. Tests inject an in-process provider only
at the module boundary; no CLI or environment flag exposes that injection.

### 2. Canonicalize and sign the complete grant envelope

The v1 payload has a fixed field order and UTF-8/LF serialization. It includes
`version`, UUID `grantId`, policy-derived repository identity and origin, full
base OID, change ID, sorted unique exact paths, issued/expiry timestamps,
`maxUses: 1`, bounded reason, signer identity, and the parent policy blob OID.
The detached SSH signature covers the complete payload under a dedicated
namespace. Verification reconstructs the canonical bytes and rejects unknown
fields, altered order-independent JSON values, clock reversal, TTL over 30
minutes, non-one use, or an untrusted signer.

Grant paths must be repository-relative tracked regular files eligible under
the parent policy. Path validation rejects absolute paths, traversal, control
characters, backslashes, glob syntax, directories, symlink segments, missing
files, exact-case mismatches, and case-fold collisions. Eligibility policy may
use reviewed directory prefixes, but a signed grant never does.

### 3. Keep bearer state local and publish only a signed audit envelope

Available tokens, reservations, terminal consumed/revoked records, and commit
journals live below
`<git-common-dir>/workflow-engine/maintainer-grants/` with `0700` directories,
`0600` files, atomic write/rename/fsync, and the existing repository lifecycle
lock. No token appears in the worktree or commit.

Grant issuance also creates an immutable annotated audit tag at
`refs/tags/workflow-grant/<grant-id>` whose message is exactly the signed,
non-secret envelope. The command does not push; it reports the exact tag ref
that the maintainer must publish. GitHub must protect that tag namespace. CI
fetches the exact tag, verifies its envelope signature against parent policy,
and does not treat the tag object's own metadata or candidate files as trust.
This provides a portable protected audit store without a reusable bearer
token or candidate-controlled secret.

### 4. Use a separate authority state machine

`authority-start` validates the clean `work/<change-id>` branch, exact HEAD,
policy, audit tag, signature, time, change contract, exact paths, and absence of
other lifecycle work, then atomically moves the local grant from available to
reserved and writes an authority session pinned to all inputs.

`authority-check` revalidates the reservation, base, policy, exact changed
paths, signer, expiry, and repository projection. It runs the union of normal
policy-required checks and every check required by the active OpenSpec change.
It writes content-addressed evidence but never completes task checkboxes.

`authority-commit` requires current evidence, at least one granted path changed,
no other path, an unchanged index, and a still-valid reservation. It creates a
signed commit through Git plumbing with exactly:

```text
Change: <change-id>
Transition: authority-maintenance
Grant: <grant-id>
```

The form is mutually exclusive with `Task`, `plan`, and `archive`. The change's
ordinary tasks are not completed by this transition; the change must describe
the authority work and may be archived only after its separately defined
completion policy is satisfied.

Any start/check/commit failure after reservation terminally revokes that use,
closes the session, and releases locks. `maintainer revoke` is idempotent;
`maintainer inspect` is read-only and redacts local filesystem secrets.

### 5. Journal commit creation before compare-and-swap ref update

Before commit creation, the engine writes and fsyncs a journal containing the
grant, session, base, expected tree, message digest, and state `preparing`.
After `git commit-tree` returns the signed commit OID, the journal advances to
`commit-created`, then the engine performs `git update-ref` with the exact old
HEAD. After ref success it advances to `ref-updated`, writes the terminal
consumed record, deletes the reservation/token, and closes the session.

Recovery never makes a grant available again. It verifies journal content,
commit signature, parent, tree, trailers, and current ref. A matching created
commit can receive the one pending compare-and-swap; a matching updated ref is
finalized as consumed; every ambiguous or divergent state is revoked and
requires a new grant. Repeated cleanup is idempotent.

### 6. Run authority verification from the pull-request base

The assurance workflow moves to `pull_request_target` with read-only contents,
checks out the candidate SHA without credentials, and separately checks out
the exact base SHA. It installs locked dependencies without scripts and invokes
the base engine against the candidate repository. The base verifier parses the
candidate Git objects but loads maintainer policy, trusted keys, immutable
paths, and authority verification code from the parent/base checkout.

For each authority commit, CI verifies one parent equal to the grant base,
canonical trailers, commit SSH signature, grant envelope signature and tag,
repository identity, policy blob, expiry at commit and current PR evaluation,
exact diff, unique grant claim across the range, phase transition, and complete
normal check set. Mixed or duplicate claims fail closed. Ordinary task, plan,
and archive semantics remain unchanged.

The implementation PR is the one bootstrap exception: because its base has no
maintainer policy or base verifier, it remains an ordinary managed change under
the existing `pull_request` assurance. Once merged, the base-owned
`pull_request_target` definition governs later PRs.

### 7. Seal through an old-key-authorized authority commit

Bootstrap policy permits exact grants for reviewed workflow JSON/schema files
and engine authority code. Sealing is a normal authority-maintenance commit
that changes `phase` from `bootstrap` to `sealed`, is signed by an existing
trusted key, and passes a GitHub protected-environment approval. Reversion to
bootstrap is always invalid. In sealed mode, verifier, policy loader, signer
loader, and immutable-path enforcement files cannot be granted. Lost-key
recovery remains a repository-admin, out-of-band event with separately retained
audit evidence.

## Risks / Trade-offs

- **[Bootstrap cannot prove itself with code that does not yet exist]** → The
  implementation PR contains no authority commit and uses the existing managed
  lifecycle; base-owned verification starts only after merge.
- **[A normal ED25519 key might be usable without human presence]** → Reject
  unencrypted software keys, clear SSH agent/askpass paths, and require a TTY;
  prefer a FIDO `*-sk` key before sealing.
- **[Audit tags can be deleted by a repository administrator]** → Require a
  protected tag namespace, preserve the envelope externally for incident
  review, and treat admin bypass as the final recovery authority.
- **[A 30-minute grant can expire while CI queues]** → CI fails closed; issue a
  new grant and isolated authority commit rather than extending or replaying
  the old grant.
- **[Base-engine execution constrains future verifier evolution]** → Upgrade in
  one valid authority commit under the previous verifier; new behavior becomes
  active only after merge.
- **[Crash recovery is filesystem- and Git-dependent]** → Use common-directory
  locking, atomic renames, fsync, exact old-OID ref updates, and terminal
  revocation for every ambiguous state.

## Migration Plan

1. Merge this ordinary managed change with the bootstrap policy and trusted
   public key; do not issue an authority grant inside the same PR.
2. Protect `workflow-grant/**` tags and configure the sealed approval
   environment in GitHub.
3. Run a non-destructive bootstrap pilot against one exact authority file,
   including revocation, expiry, failure cleanup, CI, and recovery evidence.
4. Rotate to or confirm a hardware-backed signer if the bootstrap key is not
   human-presence-bound.
5. Create and merge an authority commit changing the phase to `sealed` after
   protected-environment approval.
6. Rollback before sealing by reverting the implementation through the normal
   managed workflow. After sealing, rollback requires a valid old-policy grant
   and cannot remove immutable trust-root enforcement.

## Open Questions

None for implementation. GitHub tag protection and protected-environment
activation are maintainer-owned post-merge operations and remain explicit
pilot evidence rather than repository claims.
