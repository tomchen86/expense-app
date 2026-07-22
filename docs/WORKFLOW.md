# Repository Workflow

_Last reviewed: July 17, 2026_

This repository plans changes with OpenSpec and executes them with the
repository-owned `pnpm workflow` engine. Spectra is retained only for
compatibility and historical reference; it is not an execution path.

## Ownership Model

| Concern                                        | Authoritative source                            |
| ---------------------------------------------- | ----------------------------------------------- |
| Current requirements                           | `openspec/specs/<capability>/spec.md`           |
| Proposed requirement deltas, design, and tasks | `openspec/changes/<change-id>/`                 |
| Per-task path scope and required check IDs     | `openspec/changes/<change-id>/guard.json`       |
| Project priority                               | `docs/ROADMAP.md`                               |
| Current handoff                                | generated `docs/CURRENT_AND_NEXT_STEPS.md`      |
| Structured issues                              | `docs/issues/issues.yaml`                       |
| Runtime sessions, locks, and reports           | the Git common directory, managed by the engine |
| Commit and branch history                      | Git                                             |

Markdown does not authorize completion. A checked task, handoff update, staged
index, or commit is valid only when the workflow engine produces it from
current evidence.

## Managed Transition Matrix

| Kind      | Exact trailers                                                               | Public authority                          |
| --------- | ---------------------------------------------------------------------------- | ----------------------------------------- |
| Task      | `Change: <id>` and `Task: <task-id>`                                         | session `complete-task`/`finish`/`commit` |
| Plan      | `Change: <id>` and `Transition: plan`                                        | `pnpm workflow plan-commit <id>`          |
| Archive   | `Change: <id>` and `Transition: archive`                                     | `pnpm workflow archive <id>`              |
| Authority | `Change: <id>`, `Transition: authority-maintenance`, and `Grant: <grant-id>` | human-only authority lifecycle            |

The forms are mutually exclusive. A plan or archive commit has no `Task:`
trailer, a task commit has no `Transition:` trailer, and none may be mixed with
extra managed trailers. Do not hand-author the trailers or use raw `git commit`
for one of these transitions.

## Before Starting

1. Read `AGENTS.md`, `docs/ROADMAP.md`, and
   `docs/CURRENT_AND_NEXT_STEPS.md`.
2. Read the active change's proposal, design, delta specs, tasks, and
   `guard.json`.
3. For production behavior or a bug fix, identify or add the test that will
   fail for the intended reason before changing implementation code. Record the
   reason when a documentation-only, formatting-only, dependency-only, or
   time-boxed research task is exempt from RED -> GREEN -> REFACTOR.
4. Work on the configured `work/<change-id>` branch with a clean worktree. A
   detached HEAD, protected branch, or other branch name is not eligible.
5. Diagnose the repository and validate the tracked change:

   ```bash
   pnpm workflow doctor --json
   pnpm workflow validate-change <change-id> --json
   ```

`doctor` is diagnostic. It can exit successfully while reporting warnings, so
read its output. A successful diagnostic does not grant permission to skip any
later transition.

### Bootstrap and routine maintenance

Run `pnpm install` from the repository root to install the exact lockfile and
the repository hooks through the root `prepare` script. Do not substitute a
global or floating OpenSpec binary. After install or toolchain maintenance,
run:

```bash
pnpm workflow doctor --json
pnpm workflow openspec-assets check --json
pnpm workflow documents validate --json
```

Treat dependency, schema provenance, generated-asset, hook, or managed-document
drift as a reviewed change. Remote repository rules remain maintainer-owned and
must be verified separately; a local hook or checked-in workflow file does not
prove that `workflow-assurance` is required for merge.

## Planning Lifecycle

OpenSpec owns proposal, design, delta-spec, task, and artifact-graph creation.
It does not authorize implementation or Git transitions. Create or revise the
artifacts on the exact `work/<change-id>` branch, keep every task unchecked,
then submit the planning-only diff with:

```bash
pnpm workflow validate-change <change-id> --json
pnpm workflow plan-commit <change-id> --json
```

`plan-commit` rejects implementation files, normative base specs, archives,
task-checkbox changes, an active session, wrong branches, and unrelated
planning paths. It validates the pinned OpenSpec graph and repository contract,
records current evidence, stages the exact planning paths, and creates the plan
form from the transition matrix. A later planning revision uses the same
command and invalidates stale task evidence.

Repository planning assets are limited to the exact exposed skill names
`openspec-explore` and `openspec-propose` across Codex, Claude Code, and the
`.agents` mirror, with reviewed Codex prompt copies and a schema-v2 digest
manifest under `workflow/openspec-assets/`. Use `openspec-explore` for
read-only investigation and requirement clarification. Use `openspec-propose`
to create a complete proposal, design, delta specs, tasks, and `guard.json`.
Do not infer a slash command or alias from an internal prompt filename. If a
running tool does not expose the skills, use the pinned OpenSpec planning CLI
directly and record the discovery result in the post-merge pilot.

## Managed Task Lifecycle

### 1. Start the selected current task

```bash
pnpm workflow start <change-id> --task <task-id> --json
```

Choose the current task named by the handoff and keep the returned session ID.
Start fails closed for a protected branch, dirty baseline, unknown or already
completed task, an active session for the same change, or invalid change
contract. Task ordering is authorized later by completion reconciliation and
CI, not by session creation. The session snapshots the change contract,
allowed paths, required check IDs, and their policy digests.

### 2. Implement within the session boundary

- Change only paths allowed for that task.
- Treat `guard.json` as machine policy, not a place for task prose.
- Do not edit task checkboxes or the generated handoff.
- Do not stage or commit managed work manually.
- Do not change policy to legitimize a diff that the starting policy rejected.
- The engine does not stash, reset, or delete working-tree files on your
  behalf.
- Never run a destructive API test without an explicitly disposable
  `TEST_DATABASE_URL`; development-database fallback is forbidden.

Inspect a session or resolve semantic task-to-commit history with:

```bash
pnpm workflow status <session-id> --json
```

### 3. Produce current check evidence

```bash
pnpm workflow check <session-id> --json
```

The engine rejects out-of-scope paths and executes only the task's configured
check IDs through their pinned runners. Reports bind the current diff
fingerprint, policy, artifact, required-check and runner digests, and passing
outcomes; each report is itself content-addressed. Any later content change
makes earlier evidence stale, so run `check` again after a correction.

### 4. Let the engine complete, stage, and commit

Run these transitions in order:

```bash
pnpm workflow complete-task <session-id> --json
pnpm workflow finish <session-id> --json
pnpm workflow commit <session-id> --message "Imperative subject" --json
```

- `complete-task` accepts only current passing evidence, updates the exact task
  checkbox, and regenerates controlled documents such as the semantic handoff.
- `finish` verifies the completion projection, reruns the required checks, and
  stages the exact authorized tree.
- `commit` rejects index drift and creates the commit with exact
  `Change: <change-id>` and `Task: <task-id>` trailers.

The commit subject must be one trimmed line without control characters or
trailers. If commit ref advancement is interrupted after the commit object is
created, rerun the same `commit` command so the engine can reconcile it.

Do not write a commit hash into `CURRENT_AND_NEXT_STEPS.md` or create a
hash-only metadata commit. Use Git or `workflow status` when a hash is needed.

### 5. Abort only when abandoning the session

```bash
pnpm workflow abort <session-id> --reason "Concrete reason" --json
```

Abort is available only before the session has a completion, finish, or commit
report. It records the reason and releases the session; it does not discard or
reset working-tree changes.

## Archive Lifecycle

Archive is a separate managed transition, not a synthetic task. Every task
must already be completed by exactly one canonical task commit reachable from
the first configured protected branch. There must be no active session or
unowned worktree/index change. After the task commits have been merged into
that configured base, create a clean archive branch from the updated base and
run:

```bash
pnpm workflow validate-change <change-id> --json
pnpm workflow archive <change-id> --json
```

The engine runs the exact pinned OpenSpec archive operation only in a detached
temporary worktree. It validates the returned JSON and roots, archive date,
delta outcomes, rebuilt specs, modes, digests, and exact patch before touching
the real worktree. It then compare-and-swap commits the archive form from the
transition matrix. A repeated `archive` call is an idempotency check: it may
return only the one already-archived identity accepted by the engine.

Do not run `openspec archive` directly, manually move the change directory,
stage an archive, or use an OpenSpec apply/sync/bulk lifecycle interface.

## Pull Request Assurance

The authoritative verifier receives exact commit objects:

```bash
pnpm workflow ci --base <base-commit> --head <head-commit> --json
```

It requires an ancestor base and clean checkout, verifies every managed commit
against task order, trailers, path scope, anchored policy, and task-state
projection, then recomputes required checks. Runtime reports from a developer
session are not trusted as CI evidence.

`.github/workflows/workflow-assurance.yml` invokes this verifier for pull
requests. Repository rules must separately require pull requests, the
`workflow-assurance` check, an up-to-date base, and no bypass. Code-owner
approval with stale-review dismissal is additionally required only when at
least two independent eligible human maintainers exist. Until those remote
rules are configured, local and workflow-file enforcement must not be described
as merge authority.

## Break-Glass Maintainer Mode

Break-glass maintenance is a human-only fourth commit kind for changing exact
workflow authority files when the ordinary task lifecycle must remain closed.
It is not a bypass for product code, ordinary documents, failed checks, task
completion, plan commits, or archives. The engine keeps local grants,
reservations, terminal records, sessions, and commit journals in the Git common
directory shared by linked worktrees; none is a reusable worktree credential.

The checked-in implementation starts in `bootstrap`. Describe it as
**bootstrap-only**, and do not claim sealed enforcement, until a maintainer has
independently verified every remote prerequisite below:

- protect the `workflow-grant/**` tag namespace against creation, update, and
  deletion by unapproved actors while retaining administrator audit recovery;
- protect the `workflow-attestation/**` tag namespace with the same no-bypass
  creation, update, and deletion rules so published authority attestations
  cannot be replaced or removed by unapproved actors;
- require pull requests, an up-to-date base, the real `workflow-assurance`
  check, and no bypass on the configured protected branch;
- configure and verify the protected environment/approval gate that will be
  required before the sealing PR can merge; and
- retain the signed, non-secret audit envelope outside the local grant store so
  a repository administrator can investigate a deleted or disputed remote tag.

A checked-in workflow, a local hook, or a successful local replay does not
prove any of these GitHub settings. The implementation PR is the one bootstrap
exception: its base does not contain the verifier, so it remains an ordinary
managed change. After that PR merges, `pull_request_target` loads the exact base
workflow and trust material, checks the candidate separately without persisted
credentials, and imports only the base repository's protected grant tags.

### Human signer and repository prerequisites

Perform grant issuance and authority commit creation directly from a
controlling interactive terminal. Redirected or unattended use is rejected.
The exact base policy must trust the configured key. Use a passphrase-encrypted
SSH private key or a human-presence FIDO `*-sk` key; an unencrypted software
key, SSH agent, askpass program, environment force switch, or candidate-added
key cannot create authority.

Configure the repository-local Git signer before issuing a grant:

```bash
git config --local gpg.format ssh
git config --local user.signingkey ~/.ssh/<trusted-maintainer-key>
```

`user.signingkey` must resolve to an absolute regular file (a `~/` path is
accepted), its fingerprint must match a signer in the exact base
`workflow/maintainer-policy.json`, and normal Git author name/email must also be
configured. Keep the worktree clean, use the canonical origin, and create an
ordinary reviewed OpenSpec change plus planning commit on the exact
`work/<change-id>` branch before issuing authority.

### Maintainer command reference

| Command                                                                                                                                             | Use and boundary                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm workflow maintainer grant --change <id> --paths <exact-path> [--paths <exact-path> ...] --reason <text> [--ttl <minutes>m] [--uses 1] --json` | Interactively sign one grant bound to the current full base commit, base policy blob, repository, change, sorted exact eligible paths, reason, signer, expiry, and one use. The default and maximum TTL are 30 minutes.                             |
| `pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] --json`                                         | Interactively sign one canonical authority attestation binding a rebase-rewritten protected-main authority commit to its retained signed original, then create the immutable `workflow-attestation/<grant-id>` tag targeting the original.          |
| `pnpm workflow maintainer inspect [grant-id] --json`                                                                                                | Read redacted available, reserved, consumed, or revoked local state. It grants no authority and exposes no private signing material.                                                                                                                |
| `pnpm workflow maintainer revoke <grant-id> --json`                                                                                                 | Terminally revoke an available or reserved grant. Repeating it is cleanup-safe; a consumed or revoked grant never becomes available again.                                                                                                          |
| `pnpm workflow authority-start <change-id> --grant <grant-id> --json`                                                                               | Atomically reserve the grant on its exact clean base and `work/<change-id>` branch, then pin policy, contract, signer, exact paths, and the complete normal check set.                                                                              |
| `pnpm workflow authority-check <session-id> --json`                                                                                                 | Require at least one changed granted path, reject every ungranted path, run all base-pinned normal checks, and record current content-addressed evidence. Any later edit makes it stale.                                                            |
| `pnpm workflow authority-commit <session-id> --message "Imperative subject" --json`                                                                 | Revalidate human presence and the same signer, stage only the exact diff, create one SSH-signed authority-maintenance commit with engine-owned trailers, advance the ref, and consume the grant. There is no authority `complete-task` or `finish`. |
| `pnpm workflow authority-recover <session-id> --json`                                                                                               | Resume only a durable authority-commit journal. It may complete the exact pending old-OID ref update or idempotent consumption; ambiguity terminally revokes the use.                                                                               |
| `pnpm workflow authority-abort <session-id> --reason "Concrete reason" --json`                                                                      | Cancel an active session before commit journaling and terminally revoke the reservation. It does not discard or reset worktree edits.                                                                                                               |

Grant issuance creates both the local single-use token and an annotated audit
tag. Run the exact `publishCommand` returned by the command immediately; it has
this form:

```bash
git push origin refs/tags/workflow-grant/<grant-id>:refs/tags/workflow-grant/<grant-id>
```

Do not delete or replace the tag after revocation, failure, expiry, or
consumption. The envelope is non-secret audit evidence, and CI requires the
exact protected tag. Do not extend, copy, or reuse an expired grant; issue a
new grant from the new exact base.

### Authority execution sequence

Use one grant for one authority commit:

```bash
pnpm workflow maintainer grant --change <change-id> \
  --paths <exact-authority-path> --reason "Reviewed reason" --json
git push origin refs/tags/workflow-grant/<grant-id>:refs/tags/workflow-grant/<grant-id>
pnpm workflow maintainer inspect <grant-id> --json
pnpm workflow authority-start <change-id> --grant <grant-id> --json
# Edit at least one and only the exact granted paths.
pnpm workflow authority-check <session-id> --json
pnpm workflow authority-commit <session-id> \
  --message "Imperative authority subject" --json
pnpm workflow maintainer inspect <grant-id> --json
```

Push the branch, open a PR, and require the base-owned
`workflow-assurance` result. CI verifies the grant and commit signatures, audit
tag, parent/base, policy blob, repository identity, expiry both at commit time
and PR evaluation time, exact diff, single claim across the PR range, phase
transition, and every normal check. If CI queues past expiry, issue a new grant
and new isolated authority commit; never amend, replay, or relax the old one.

Any failure after reservation closes the session and terminally revokes that
use. `authority-abort` is for an active session that has not started commit
journaling. `authority-recover` is only for a journal created by
`authority-commit`; it is not a retry for a failed check, expired grant, dirty
branch, missing tag, signature error, or divergent tree. Preserve the error,
inspect the session and grant, and obtain explicit maintainer approval before
discarding any leftover edits. A lost trusted key, missing/altered journal,
divergent branch, or damaged trust root is a repository-admin, out-of-band
recovery event with separately retained audit evidence—not a workflow command
or AI-accessible override.

### Authority tree attestation

GitHub's required rebase merge rewrites every authority commit, so the
human-signed original is never the object reachable from the protected branch.
An authority attestation binds the rewritten protected-main commit back to its
retained signed original by transition identity, not commit identity: equal
result trees, equal single-parent trees, byte-identical canonical managed
messages, the exact grant, and a valid original commit signature.

Trust is split across three boundaries. The protected branch decides which
rewritten commit is authoritative; retained Git objects and protected tags
preserve the signed original and its human-signed statement; and base-owned
workflow code plus previously trusted signer material decide whether the
mapping is acceptable. A candidate commit can never validate its own evidence
or add its own trust.

After the authority PR merges, create the attestation from an updated, clean,
controlling worktree whose fetched protected branch contains every claimed
main commit:

```bash
pnpm workflow maintainer attest --original <original-commit> \
  --main <protected-main-commit> [--base <original-base>=<main-base> ...] --json
```

The command derives the primary grant from the authority trailers, validates
every mapping including the explicit grant-base pairs used by historical grant
replay, signs one canonical envelope in the distinct
`expense-app.workflow.authority-attestation.v1` namespace, and creates the
immutable annotated tag `refs/tags/workflow-attestation/<grant-id>` targeting
the signed original so it stays reachable. Run the exact returned
`publishCommand` immediately, exactly like a grant tag.

Base-owned `workflow-assurance` replays protected first-parent history before
candidate commits are evaluated: every authority commit on the base must
resolve to exactly one valid protected attestation, and every referenced
historical grant base must have a complete explicit mapping. Missing,
conflicting, duplicated, malformed, or candidate-supplied evidence fails
closed. This is an intentional migration gate: after the verifier merges, the
next pull request stays red until the historical pilot attestation tag is
protected, published, and replayable. Never re-disable the required check to
step around it.

Recovery is maintainer-controlled tag publication, not rewriting. A missing or
malformed local attestation tag is repaired by issuing and publishing the tag
again through this command. A published conflicting protected tag is a
repository-admin, out-of-band recovery event, never an automatic rewrite.
Environment binding, hardware-signer confirmation or rotation, immutable-path
hardening, and the one-way sealed transition remain separately approved work;
the repository stays bootstrap-only until they are proven.

### Bootstrap pilot and one-way sealing

After this implementation is merged, first verify the remote prerequisites and
run a dedicated, non-database bootstrap pilot from the updated configured base:

1. Create and plan-commit a small OpenSpec change for one harmless exact file
   already allowed by `bootstrapEligiblePaths`. Do not put product work or the
   phase transition in this pilot.
2. With separate grants, record read-only inspection, idempotent explicit
   revocation, a one-minute expiry rejection, and terminal cleanup after a
   deliberate pre-commit failure. Never reuse those grant IDs or delete their
   audit tags.
3. Issue and publish a fresh grant for the successful pilot, run the full
   authority sequence, then call `authority-recover` on the consumed session to
   prove idempotent journal finalization. Interrupted commit points remain
   integration-test evidence; do not deliberately crash or corrupt a real
   repository.
4. Push the pilot PR and record the exact commands, semantic change/grant IDs,
   audit-tag publication, check results, commit-signature verification, and
   base-owned `workflow-assurance` result. Merge only through the configured
   remote rules.
5. Confirm or rotate to a human-presence hardware signer while the parent
   policy is still in bootstrap. A new signer is trusted only after an
   old-key-authorized authority commit merges.

Only after that evidence and protected-environment approval may a separate
authority-maintenance change set `phase` from `bootstrap` to `sealed`. The
grant must be signed by a signer trusted in the parent policy and must target
the exact policy file. The transition is one-way: CI rejects
`sealed` → `bootstrap`, removal of immutable paths or required checks, and any
sealed grant that targets the verifier, policy/signer loader, policy itself, or
other `sealedImmutablePaths`. Review the sealed path list before the transition
because later maintenance of those paths requires repository-admin,
out-of-band recovery; there is no force flag.

Before sealing, rollback means a separately reviewed ordinary managed revert
of this integration. After sealing, ordinary eligible non-immutable authority
paths may still use a valid old-policy grant, but the immutable trust root
cannot be rolled back through maintainer mode.

### Standalone registered checks

Use the evidence-only entry point below when local verification or an external
CI job must execute exactly one non-destructive check from
`workflow/checks.json`:

```bash
pnpm workflow run-check <check-id> --json
```

The command requires a clean checkout, resolves the named registry entry,
executes it through the same pinned runner used by managed checks and replay,
binds the result to current HEAD, and rejects checkout mutation. It fails before
execution for an unknown or destructive check. Its structured result is check
evidence only: it cannot authorize task completion, staging, commit, archive,
or a merge.

CI and package-script adapters must delegate to this command instead of copying
a registered command or maintaining another path scope. In particular,
formatting verification resolves `workflow-format`; the registry entry remains
the sole authority for its Prettier paths.

## Controlled Issues and Documents

### Issues

`docs/issues/issues.yaml` is the editable structured source even though its
extension is YAML; it must remain JSON-compatible. `docs/ISSUE_LOG.md` is a
deterministic generated view and must not be edited or formatted by hand.

```bash
pnpm workflow issue add --id <ISS-nnn> --category <category> --title <title> \
  --status <status> --priority <priority> --notes <notes> --json
pnpm workflow issue update <ISS-nnn> --field <field> --value <value> --json
pnpm workflow issue close <ISS-nnn> --date <YYYY-MM-DD> --notes <notes> --json
pnpm workflow issue render --json
pnpm workflow issue validate --json
```

After every issue mutation, render and validate the generated log. An optional
requirement link on `issue add` requires both `--requirement-label` and
`--requirement-href`. Repeat `--reference` for multiple references.

Accepted categories are `feature`, `bug`, and `enhancement`; statuses are
`proposed`, `in-progress`, `done`, `blocked`, and `icebox`; priorities are
`Now`, `Next`, and `Later`. `issue update` supports `title`, `status`,
`priority`, and `notes`. Feature IDs use `ISS-000` through `ISS-099`, bug IDs
use `ISS-100` through `ISS-199`, and enhancement IDs use `ISS-200` through
`ISS-999`.

### Managed and curated documents

Validate generated/managed documents with:

```bash
pnpm workflow documents validate --json
pnpm workflow handoff validate --json
```

The handoff is generated from controlled change and issue state. Use
`pnpm workflow handoff render --json` only inside an authorized task scope.

Curated section refreshes under `docs/architecture/**` and `docs/features/**`
use separate propose, inspect, review, and apply records:

```bash
pnpm workflow document-refresh propose --target <path> --section <heading> \
  --replacement <markdown> --json
pnpm workflow document-refresh show --proposal <proposal-id> --json
pnpm workflow document-refresh review --proposal <proposal-id> \
  --decision <approve-or-reject> --reviewer <identity> --json
pnpm workflow document-refresh apply --proposal <proposal-id> \
  --review <review-id> --json
```

Approval is bound to the exact proposal. A changed source document or policy
invalidates the apply operation.

## Failure Classes

| Exit | Meaning                                               |
| ---- | ----------------------------------------------------- |
| `1`  | unexpected internal failure                           |
| `2`  | invalid command or arguments                          |
| `10` | guard or policy rejection                             |
| `11` | lock or active-session conflict                       |
| `12` | unsafe environment, including database policy failure |
| `13` | check or validation failure                           |
| `14` | stale or tampered state                               |

Treat a nonzero exit as a stop condition. Correct the underlying input and
produce fresh evidence; do not bypass hooks, edit reports, or manually perform
the rejected transition.

## Recovery and Rollback

- If implementation changes after `check`, rerun `check`; old evidence is
  intentionally stale.
- If `finish` fails, inspect `git status` and `workflow status`, correct only
  the authorized input, and rerun the managed transition. Do not reset, stash,
  hand-stage, edit reports, or create a replacement commit.
- If commit ref advancement is interrupted, rerun the same managed command.
  The engine reconciles only the exact report/tree/commit identity.
- If planning or archive validation fails, preserve the error and worktree
  state. Archive upstream failures remain isolated; real-worktree drift or an
  ownership mismatch is a stop condition, not permission for manual repair.
- Before a successful real pilot, rollback of this integration requires a
  separately reviewed logical revert. Keep OpenSpec artifacts readable as
  Markdown/JSON, do not archive a partial migration, and do not delete
  user/global state.
- After the pilot, change OpenSpec, schema, workflow policy, or generated-asset
  contracts only through a new proposal with compatibility tests.

## OpenSpec Upgrade Procedure

Every OpenSpec upgrade is a separate reviewed change. In that change:

1. Update `@fission-ai/openspec` to one exact version in `package.json` and the
   matching integrity-pinned `pnpm-lock.yaml` resolution. Keep
   `allowBuilds['@fission-ai/openspec']` explicitly `false`.
2. Inspect the installed public CLI and packaged `schemas/spec-driven` source.
   Review and update the `expense-app` schema fork and
   `openspec/schemas/expense-app/provenance.json`; do not deep-import internals
   or copy the archive merge implementation.
3. Regenerate and compare the planning-only tool-plural OpenSpec assets:

   ```bash
   pnpm workflow openspec-assets generate --json
   pnpm workflow openspec-assets check --json
   ```

4. Run `pnpm workflow doctor --json`, validate every affected active change,
   and run the workflow tests, typecheck, lint, and format checks through the
   change's registered checks.
5. Require CI to recompute dependency, schema provenance, generated assets,
   planning, tasks, and archive replay from Git. Do not weaken a validator to
   accept unexplained upstream drift.

## Maintainer-Owned Post-Merge Pilot

The disposable repository rehearsal proves the implementation path but is not
the real pilot. Support remains undeclared until a maintainer performs this
gate after the integration is merged and reachable from the configured base:

1. Update the configured base locally and create a new small, non-database
   OpenSpec change with one task and a harmless, tightly scoped repository
   change. Use a new `work/<pilot-change-id>` branch. Create planning artifacts
   with the pinned OpenSpec interface; use a Codex skill only if that running UI
   visibly exposes it.
2. Validate its complete planning tree and create the plan commit:

   ```bash
   pnpm workflow validate-change <pilot-change-id> --json
   pnpm workflow plan-commit <pilot-change-id> --json
   ```

3. Execute its one task with the full managed sequence:

   ```bash
   pnpm workflow start <pilot-change-id> --task <task-id> --json
   pnpm workflow check <session-id> --json
   pnpm workflow complete-task <session-id> --json
   pnpm workflow finish <session-id> --json
   pnpm workflow commit <session-id> --message "Complete pilot task" --json
   ```

   Record the semantic change/task IDs, exact commands, check outcomes, and
   observed Codex skill-discovery surface in the pilot review; do not put
   commit hashes in the semantic handoff.

4. Merge the task commit into the configured base through normal review, then
   create a fresh archive branch from the updated base and run the following
   command twice:

   ```bash
   pnpm workflow archive <pilot-change-id> --json
   ```

   The second result must be `already-archived` for the same identity.

5. Open the archive change for review and require the real
   `workflow-assurance` PR check. For a local replay, pass the exact archive
   parent and archive head:

   ```bash
   pnpm workflow ci --base <base-commit> --head <head-commit> --json
   ```

6. Verify that CI succeeds without developer runtime reports and that only the
   UTC date prefix varies if the replay crosses a day. Declare support only
   after all results are recorded and the required remote rule is confirmed.

Do not perform this pilot inside the integration branch, describe the
disposable rehearsal as the pilot, or invent a Codex invocation the UI did not
surface.

## Archived Legacy Material

Superseded checklists, plans, status reports, logs, and templates are preserved
under `docs/archive/legacy/` using their former path below `docs/`. They are
immutable historical inputs and never override this workflow or current
canonical documents. Editing, restoring, renaming, or deleting archived
material requires new explicit maintainer approval.
