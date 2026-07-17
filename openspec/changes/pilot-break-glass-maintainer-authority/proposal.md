## Why

Break-glass maintainer mode is merged and its local integration coverage is
green, but the repository deliberately remains bootstrap-only until a real
maintainer-owned pilot proves human signing, protected audit-tag publication,
terminal grant cleanup, signed authority commit creation, recovery, and
base-owned GitHub assurance against the configured repository.

## What Changes

- Run separate human-signed grants for inspection and idempotent revocation, a
  one-minute expiry rejection, and cleanup after a harmless pre-commit failure.
- Use a fresh one-use grant to make one semantically neutral ordering-only edit
  to `workflow/checks.json`, then create the isolated signed
  `authority-maintenance` commit and prove recovery is idempotent.
- Record local and remote evidence in a canonical research document without
  storing private keys, passphrases, reusable grant tokens, or runtime state.
- Keep the repository in `bootstrap`; signer rotation and the one-way `sealed`
  transition remain separate reviewed authority changes.

## Scope

The authority commit may change only `workflow/checks.json`. Ordinary tasks may
change only the pilot evidence document, the Roadmap after remote proof exists,
and the generated handoff. No application, dependency, database, API, workflow
verifier, trusted key, maintainer policy, or phase transition is in scope.

## Non-Goals

- Changing check commands, membership, database policy, or product behavior.
- Simulating a process crash or corrupting a real grant/session store.
- Rotating the trusted signer or switching from `bootstrap` to `sealed`.
- Treating local success as proof of GitHub rules, tags, or CI.

## Capabilities

### Modified Capabilities

- `break-glass-maintainer-mode`: Add real-repository bootstrap pilot evidence
  for the already specified human grant, authority commit, recovery, and CI
  contract.

## Impact

The permanent authority diff is an ordering-only change to
`workflow/checks.json`; the remaining tracked impact is audit documentation and
the normal generated handoff. All checks are non-database checks.
