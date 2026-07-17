# Roadmap

_Last verified: July 17, 2026_

This document owns project priority. Detailed implementation tasks belong only
in the linked OpenSpec change.

## Now

### Finish repository workflow adoption

- Preserve the completed break-glass implementation and real bootstrap-pilot
  evidence from PRs #51 and #54. PR #54 passed all normal checks plus the
  base-owned `workflow-assurance` check without a ruleset exception.
- Keep break-glass maintainer mode explicitly **bootstrap-only**. The pilot
  confirmed the protected `workflow-grant/**` tags, strict
  no-bypass/up-to-date main rules, and base-owned assurance, but also showed
  that rebase merge rewrites the human-signed authority commit to an unsigned
  main commit and that the `workflow-sealing` environment is not yet bound to a
  tracked workflow.
- Before sealing, complete a separate managed repair and pilot for durable
  authority-commit merge semantics, bind and verify the protected environment,
  and confirm or rotate to a human-presence hardware signer. Keep the separate
  ordinary plan/task/archive pilot requirement in `docs/WORKFLOW.md` satisfied;
  disposable-repository and interrupted-commit rehearsals remain test evidence.
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

1. Remove fallback JWT secrets and make non-test API startup fail closed
   (`ISS-111`).
2. Make group balances honor `splitBetween` and enforce owner-only group
   mutations (`ISS-108`, `ISS-109`).
3. Make expense category selection use live category state (`ISS-105`,
   `ISS-107`).
4. Define the mobile/API contract boundary, including identifiers, token
   lifecycle, money units, and response adapters (`ISS-203`, `ISS-204`).
5. Add explicit mobile persistence; current Zustand domain state is process
   memory only (`ISS-112`).

## Next

- Add mobile expense search, date filtering, and user-selectable sorting on top
  of the API's existing query support (`ISS-002`).
- Define the persistence provider contract before exposing a local/cloud toggle
  (`ISS-201`, then `ISS-001`).
- Protect default categories on the API and add refresh-token revocation
  (`ISS-110`, `ISS-206`).
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
