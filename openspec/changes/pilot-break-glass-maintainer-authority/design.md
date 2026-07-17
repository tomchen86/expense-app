## Context

The repository now has base-owned `pull_request_target` assurance, a strict
no-bypass main ruleset, a scoped `workflow-grant/**` tag ruleset, and a protected
`workflow-sealing` environment. The executable maintainer path is intentionally
closed to agents: grant issuance and authority commit creation require a
controlling terminal and the trusted human SSH signer.

The pilot must exercise the real remote boundary without making a meaningful
authority change. Reordering existing top-level check definitions preserves the
same parsed check map and canonical commands while still producing one exact
tracked file diff for the grant.

## Goals / Non-Goals

**Goals:**

- Prove interactive grant issuance, protected tag publication, inspection,
  revocation, expiry, failure cleanup, one signed commit, and recovery.
- Keep every grant single-use, exact-path, short-lived, and separately auditable.
- Require all five non-database workflow checks locally and in base-owned CI.
- Record enough non-secret evidence to reproduce the audit.

**Non-Goals:**

- Do not alter check semantics, policy phase, signer trust, product code, or a
  database.
- Do not deliberately interrupt commit creation; integration tests already own
  crash-point evidence.
- Do not archive the change until post-merge GitHub evidence is recorded.

## Decisions

### Use separate grants for every negative and successful path

Inspection/revocation, expiry, deliberate no-diff check failure, and successful
authority creation use distinct grant IDs. Every audit tag remains published;
no expired, revoked, or consumed grant is reused or deleted.

### Use an ordering-only checks-file edit

The successful authority commit changes only the order of existing top-level
entries in `workflow/checks.json`. JSON semantics, check IDs, commands, database
flags, and canonical historical definitions remain unchanged. The task-level
evidence is documentation-only and is TDD-exempt; executable behavior is
already covered by the maintainer integration suite and all pinned checks still
run in the real pilot.

### Split local and remote evidence across two ordinary tasks

Task 1.1 records local grant states, signed commit verification, and recovery
before the PR is pushed. Task 1.2 remains unchecked until the PR has passed the
strict remote rules and merged; it then records remote URLs/results and the
read-back of protected state. Only after Task 1.2 may this pilot be archived.

## Risks / Trade-offs

- **[Grant expires while CI queues]** → Use a fresh successful grant, push
  immediately, and issue a new isolated grant/commit if CI evaluates after
  expiry; never amend or extend the old grant.
- **[Ordering edit is mistaken for a semantic change]** → Record before/after
  parsed check IDs and require all historical definitions and checks to pass.
- **[Audit tag can be altered by an administrator]** → Keep the scoped tag
  ruleset active and retain the signed non-secret envelope outside reusable
  local token state.
- **[AI attempts the signing step]** → Stop at the prepared clean branch and
  require the maintainer to type the signing commands in a controlling terminal.

## Migration Plan

1. Plan-commit this change on the exact managed branch.
2. Run the negative grant lifecycle probes with separate published audit tags.
3. Run the successful grant, exact edit, checks, signed authority commit, and
   idempotent recovery from the maintainer's terminal.
4. Complete Task 1.1, push the PR immediately, and require strict
   `workflow-assurance` plus normal CI.
5. After merge, complete Task 1.2 with remote evidence and archive normally.

Rollback before the authority commit is grant revocation and branch
abandonment. After merge, any semantic rollback requires a separately planned
managed or authority change; never rewrite the signed audit history.

## Open Questions

None.
