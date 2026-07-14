# Tasks

## 1. Bootstrap Ownership and Guard Kernel

- [x] 1.1 Align repository instructions, canonical documentation entry points,
      and planning documents with the single-source model.
- [x] 1.2 Create the zero-runtime-dependency workflow CLI, configuration,
      schemas, and
      OpenSpec change validation.
- [x] 1.3 Add unit and disposable-Git integration tests; record bootstrap
      verification evidence.

Bootstrap evidence recorded on 2026-07-14 under the one-time exception in
`design.md`:

- `pnpm run workflow:typecheck` — passed.
- `pnpm exec eslint packages/workflow-engine/src packages/workflow-engine/test`
  — passed.
- `pnpm run workflow:test` — 9/9 passed.
- `pnpm run workflow validate-change establish-executable-ai-workflow --json`
  — passed.
- `pnpm run workflow doctor --json` — diagnostic succeeded and reported the
  protected `main` branch, dirty baseline, and absent base specs.
- A real `start` request on `main` returned `PROTECTED_BRANCH` with guard exit
  code 10 and created no `.git/workflow-engine` runtime directory.

## 2. Verification and Completion Authority

- [ ] 2.1 Execute allowlisted check IDs through pinned Node/package runners,
      enforce disposable database policy, and make destructive API test target
      selection fail closed without development fallback.
- [ ] 2.2 Add immutable reports and evidence-authorized `complete-task`,
      `finish`, staging, and commit transitions with exact `Change:`/`Task:`
      trailers and Git-backed status lookup.

## 3. Controlled Documentation

- [ ] 3.1 Seed structured issue data and implement lossless issue add/update/
      close/render commands before locking `ISSUE_LOG.md`.
- [ ] 3.2 Generate the six-field semantic `CURRENT_AND_NEXT_STEPS.md` handoff
      from controlled change state without persisting commit hashes, runtime
      session facts, or execution history.
- [ ] 3.3 Add scoped, reviewed architecture and feature refresh proposals.

## 4. Repository Enforcement

- [ ] 4.1 Delegate local Git hooks to the engine without copying guard logic or
      using `eval`.
- [ ] 4.2 Add authoritative CI verification and protect workflow policy paths.

## 5. Workflow Adoption

- [ ] 5.1 Audit legacy requirements into capability OpenSpec specs.
- [ ] 5.2 Review and create `docs/WORKFLOW.md`, then separately approve legacy
      document archival.
- [ ] 5.3 Evaluate a controlled AI adapter and filesystem sandbox only after the
      local engine and CI boundaries are stable.
