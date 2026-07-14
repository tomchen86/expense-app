# Roadmap

_Last verified: July 15, 2026_

This document owns project priority. Detailed implementation tasks belong only
in the linked OpenSpec change.

## Now

### Finish repository workflow adoption

- Complete Section 5 of
  `openspec/changes/establish-executable-ai-workflow/`: publish audited base
  capability specs, document the workflow, and evaluate the AI adapter boundary.
- Keep Spectra installed for compatibility but outside every execution path.
- Activate the remote GitHub ruleset only after the workflow is present on the
  default branch: require `workflow-assurance`, an up-to-date base, code-owner
  approval with stale dismissal, and no bypass (`ISS-003`).
- Do not archive legacy documents until the maintainer gives the separate
  approval required by Task 5.2.

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

- Recover the missing `apps/web` submodule declaration and source before making
  any web capability claim (`ISS-205`).
- Add conflict telemetry and production monitoring only after sync and a
  deployed API exist (`ISS-202`).
- Keep framework-only test migrations in the icebox until they solve a measured
  delivery problem (`ISS-208`, `ISS-209`).

## Legacy Roadmap

`docs/planning/ROADMAP.md` is retained as a 2025 historical planning snapshot.
It contains known stale product-state claims and is not a current source of
truth.
