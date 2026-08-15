# Roadmap

_Last verified: August 15, 2026_

This document owns project priority. Detailed implementation tasks belong only
in the linked OpenSpec change.

## Now

### Finish repository workflow adoption

- Treat the investigation-first wrapper, governed explore/propose surfaces,
  stable assurance-claim registry, and projected single-pass finalization
  substrate as the T1.5 delivery boundary. The tool-plural `workflow-engine`
  skill now routes the final T2 implementation/recovery/finalize/archive
  surface without granting authority; operational adoption still depends on
  the real post-merge pilot below.
- Keep T2.3 as the owner of exact-diff AI review, coverage composition,
  crash-safe durable finalize recovery, and the commit transaction. Keep T2.4
  as the owner of exact-byte mechanical closure. The pulled-forward
  `finalize-task` path provides one checked prospective tree and caught
  ordinary-failure rollback only; it is not crash-safe, fully atomic, or an
  automatic commit.
- Treat the T2.3 pre-merge composition gap as implemented: exact base/head CI
  now derives canonical required coverage, proves the effective planning
  generation for every included task, reuses current PlanReview and terminal
  TaskDiffReview results, persists a content-addressed
  `PreMergeAssuranceNode`, and requests only uncovered/integration coverage.
  The fully covered ordinary single-task path is regression-tested at zero
  provider calls. The typed integration-review handoff remains advisory and
  does not replace deterministic CI or remote merge policy.
- Treat the T2.5 whole-round authority-plan transaction as implemented but not
  yet piloted: exact intent/dry-run, immutable status/resume revisions, local
  approve-and-apply recovery, remote merge observation, attestation, publish
  observation, and terminal friction evidence compose the existing human-only
  ceremonies without giving the engine signing, push, or merge authority. A
  real maintainer round is still required before claiming operational
  acceptance or sealed enforcement.
- When a current contract is synthesized from historical references, every
  owner-required historical capability needs an explicit disposition:
  delivered with evidence, superseded by a named decision, still open, or
  explicitly descoped by the owner. Neither assurance escalation nor
  simplification may silently erase an owner decision.
- Treat a healthy Codex/Claude read-only run as an empirical observation, not
  structural provider availability. `C-AVAILABILITY` is delivered by the
  verifier-accepted real ordinary-path record at
  `workflow/provider-availability-pilots/c-availability-2026-08-15.json`:
  both providers succeeded with unchanged governed projections, zero grants,
  and zero human actions. The record contains no raw provider output; its cost
  fields are policy reservation upper bounds, not billed usage.
- Preserve the completed break-glass implementation and real bootstrap-pilot
  evidence from PRs #51 and #54. PR #54 passed all normal checks plus the
  base-owned `workflow-assurance` check without a ruleset exception.
- Keep break-glass maintainer mode explicitly **bootstrap-only**. The pilot
  confirmed the protected `workflow-grant/**` tags, strict
  no-bypass/up-to-date main rules, and base-owned assurance, but also showed
  that rebase merge rewrites the human-signed authority commit to an unsigned
  main commit and that the `workflow-sealing` environment is not yet bound to a
  tracked workflow.
- Bind every rebase-rewritten authority commit to its retained signed original
  through protected `workflow-attestation/**` tags and base-owned first-parent
  replay. Publishing and protecting the historical pilot attestation is the
  explicit migration gate: the next pull request after the verifier merges
  stays red until that tag is replayable.
- Before sealing, publish the historical attestation migration tag, bind and
  verify the protected environment, and confirm or rotate to a human-presence
  hardware signer. Keep the separate ordinary plan/task/archive pilot
  requirement in `docs/WORKFLOW.md` satisfied; disposable-repository and
  interrupted-commit rehearsals remain test evidence.
- Keep support undeclared until the pilot proves plan, task, archive,
  authority grant/revoke/expiry/cleanup, idempotent recovery, repository-local
  Codex discovery observation, protected audit-tag publication, and real
  base-owned `workflow-assurance` replay from the configured base.
- Confirm or rotate to a human-presence hardware signer while still in
  bootstrap, then use a separately approved old-key-authorized authority commit
  for the one-way `bootstrap` → `sealed` transition. Lost-key or immutable
  trust-root recovery remains repository-admin and out-of-band.
- Keep the retained root Spectra configuration historical-only; keep
  Spectra-generated agent skills removed and every Spectra command, adapter,
  and lifecycle state outside all execution paths.
- Activate the remote GitHub ruleset only after the base-owned workflow is
  present on the default branch: require pull requests,
  `workflow-assurance`, an up-to-date base, and no bypass. Require code-owner
  approval with stale-review dismissal only when at least two independent
  eligible human maintainers exist (`ISS-003`).
- Complete the approved `refresh-agent-document-governance-v2` managed change to
  move noncanonical legacy documents into the immutable archive and update
  current references.

### Correct product integrity gaps before mobile/API integration

1. Define the mobile/API contract boundary, including identifiers, token
   lifecycle, money units, and response adapters (`ISS-203`, `ISS-204`).
2. Add explicit mobile persistence; current Zustand domain state is process
   memory only (`ISS-112`).

## Next

- Add mobile expense search, date filtering, and user-selectable sorting on top
  of the API's existing query support (`ISS-002`).
- Define the persistence provider contract before exposing a local/cloud toggle
  (`ISS-201`, then `ISS-001`).
- Add refresh-token revocation (`ISS-206`).
- Replace global group-name alerts with inline validation and add router-level
  mobile integration tests (`ISS-101`, `ISS-106`).

## Later

- Plan and implement a web surface from the tracked `apps/web` placeholder only
  when it becomes a product priority; do not make a web capability claim before
  then (`ISS-205`).
- Add conflict telemetry and production monitoring only after sync and a
  deployed API exist (`ISS-202`).
- Keep framework-only test migrations in the icebox until they solve a measured
  delivery problem (`ISS-208`, `ISS-209`).

## Legacy Roadmap

`docs/archive/legacy/planning/ROADMAP.md` is the preserved 2025 historical
planning snapshot. It contains known stale product-state claims and is not a
current source of truth.
