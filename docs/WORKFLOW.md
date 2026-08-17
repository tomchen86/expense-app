# Repository Workflow

_Last reviewed: August 13, 2026_

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

| Kind      | Exact trailers                                                               | Public authority                 |
| --------- | ---------------------------------------------------------------------------- | -------------------------------- |
| Task      | `Change: <id>` and `Task: <task-id>`                                         | session `open-task`/`finalize`   |
| Plan      | `Change: <id>` and `Transition: plan`                                        | `pnpm workflow plan-commit <id>` |
| Archive   | `Change: <id>` and `Transition: archive`                                     | `pnpm workflow archive <id>`     |
| Authority | `Change: <id>`, `Transition: authority-maintenance`, and `Grant: <grant-id>` | human-only authority lifecycle   |

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

OpenSpec supplies authored-artifact instructions, while the repository-owned
wrapper owns investigation applicability, evidence, execution declaration,
PlanReview, managed-ledger projection, and the eventual planning transition.
Routine new plans and revisions made before task execution start on a clean
`work/<change-id>` branch with a normalized intent file:

```bash
pnpm workflow propose <change-id> --intent <intent.json> [--actor <id>] --json
pnpm workflow propose <change-id> --resume --input <envelope.json> --json
pnpm workflow status <investigation-or-task-id> --json
```

The normalized intent JSON has exactly the top-level keys `schemaVersion`,
`summary`, `explicitPaths`, `explicitSymbols`, `explicitConfigKeys`, and
`renamePairs`, with no extras. Set `schemaVersion` to `1`, use a non-empty
string for `summary`, use string arrays for `explicitPaths`, `explicitSymbols`,
and `explicitConfigKeys`, and give each rename pair exactly the string keys
`from` and `to`. Empty arrays are valid. Keep that input and later envelopes in
a temporary scratch location rather than tracked planning artifacts.

The first call seals the blind request before accepting main-agent terms and
returns a durable `state`, `nextAction`, and exact `inputSchema`. Preserve every
returned binding value and fill only the caller-owned work that schema asks
for. Later checkpoints can request main terms, grouping dispositions, WHY
answers, authored planning contributions, or reviewer challenge dispositions.
Once planning artifacts materialize, every response also carries a deterministic
`planDigest` projection of the proposal WHY, key decisions, touched files and
their protected invariants, and open questions. It is an operator-facing
summary of exact reviewed inputs, not a second authority artifact.

When an active task has entered `revising`, use these same `propose` and
`--resume` commands from any worktree in the repository. The engine resolves
the durable revising session, reuses its planning authority, and continuously
proves that preserved implementation bytes have not changed. Accepted
PlanReview returns `state: revision-plan-reviewed` with `nextAction:
resume-task`; it deliberately does not create a second plan commit. The exact
planning-only commit and same-session rebind remain owned by `resume-task`.
If term scan budgets require narrowing without a returned typed input schema,
stop: the current wrapper has no caller-owned narrowing checkpoint. Use
`work.authoredInstructions` for the authored OpenSpec graph; never
prompt-author or overwrite engine-owned
`investigation.json`, `execution.json`, `plan-review.json`, or managed-ledger
fields.

The tracked `investigation.json` may use schema v2 as a compact Git-backed
projection. In that form it keeps semantic/provider/WHY/review/seal evidence as
full immutable nodes and replaces only deterministic inventory, scan, hit,
group, disposition, and coverage envelopes with a replay recipe bound to the
exact baseline commit and tree. Consumers reconstruct the schema-v1 logical
DAG from the pinned Git objects and reject the artifact if an object is
missing, the commit no longer resolves to the recorded tree, or the recovered
node set differs in identity, count, digest, grouping, or provenance. The
working tree is never a fallback source. Existing schema-v1 full artifacts
remain valid, and a graph that cannot be reproduced exactly remains stored in
that full form.

Resume only with the latest typed envelope. Do not replay completed provider
work, transcribe reviewer terms, manufacture collaboration evidence, or bypass
`human-action-required`. When provider work is pending, `status` is read-only
and a later resume advances from the durable result. A new planning change is
ready only when the wrapper returns `state: planning-complete` and its managed
planning transition. A task revision instead returns
`state: revision-plan-reviewed`; its planning transition is created by the
following `resume-task`.

For a new plan, the wrapper invokes the existing `plan-commit` authority after
assembling and validating its prerequisites. `plan-commit` still rejects
implementation files,
normative base specs, archives, task-checkbox changes, active task sessions,
wrong branches, and unrelated planning paths; it is not the routine shortcut
around investigation-first planning. A later planning generation invalidates
stale task evidence.

Repository assets expose the exact skill names `openspec-explore`,
`openspec-propose`, and `workflow-engine` across Codex, Claude Code, and the
`.agents` mirror, with reviewed Codex prompt copies and a schema-v2 digest
manifest under `workflow/openspec-assets/`. Use `openspec-explore` for
read-only investigation and requirement clarification. Use `openspec-propose`
to drive the typed wrapper through managed planning. Use `workflow-engine`
after planning to route implementation, recovery, review, finalization, and
archive work to the final public command surface. Do not infer a slash command
or alias from an internal prompt filename.

The generated mirrors are byte-identical to their reviewed Codex source. A
skill is guidance, not authority: it cannot create mandates, grants,
attestations, task completion, managed Git transitions, protected Apply, or
remote publication. The governing executable command and any required human
checkpoint validate the exact current state.

### Investigation applicability is not task-execution exemption

A structured investigation exemption is a planning-applicability branch for
an exact reviewed scope. Its closed categories are documentation-only,
formatting-only, deterministic-generated-projection, and time-boxed-research,
and eligibility also requires `nonTrivialBehaviorReliance: none-declared`. It
omits the sealed scan, hit disposition, and WHY graph instead of manufacturing
empty evidence. `C-TERM-SCAN`, `C-WHY-BINDING`, and breadth/depth assurance are
inapplicable, not passed.

An investigation exemption does not waive PlanReview, task scope, execution
strategy, registered checks, CI replay, or managed Git transitions. A
task-execution exemption changes only the implementation strategy or TDD fact;
it does not create an investigation exemption or waive planning evidence.
`legacyBootstrap` is one named migration qualifier, not a reusable exemption
family or fourth execution strategy.

### Stable assurance claim registry

These IDs and hardness levels are the sole T1.5 vocabulary for documentation,
CLI summaries, tracked artifacts, and CI output. A surface may omit an
irrelevant claim, but it must preserve the registered hardness and owner and
must not invent a stronger synonym.

| Claim ID                  | Claim                                                                                                                               | Hardness                                                                        | Delivery / owner                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `C-TERM-SCAN`             | Every currently effective sealed term was scanned under the governed scan policy                                                    | Hard                                                                            | T1.5 sealed-investigation branch                                     |
| `C-TERM-SUPERSESSION`     | Engine-floor terms cannot be removed; an agent term leaves the effective set only by reviewed, reasoned, audit-visible supersession | Hard engine floor; audit-monotone but correctable agent contribution            | T1.5                                                                 |
| `C-TERM-COMPLETENESS`     | The effective term set is semantically complete                                                                                     | Soft and not provable                                                           | Residual, never delivered as hard                                    |
| `C-REVIEW-CURRENT`        | A review artifact exists, is immutable, and is current for its exact target                                                         | Hard                                                                            | T1.5                                                                 |
| `C-REVIEW-JUDGMENT`       | The reviewer judgment is correct                                                                                                    | Soft                                                                            | Human/agent judgment                                                 |
| `C-WHY-BINDING`           | Every required WHY field exists and is bound to exact source blobs                                                                  | Hard structure                                                                  | T1.5 sealed-investigation branch                                     |
| `C-WHY-TRUTH`             | The WHY explanation is true or proves understanding                                                                                 | Soft                                                                            | Human/agent judgment                                                 |
| `C-ARTIFACT-ORDER`        | Authoritative design materialization follows sealed investigation inputs                                                            | Hard artifact order; cognition order is not proved                              | T1.5 when investigation applies; exemption is separately labeled     |
| `C-SEMANTIC-INJECTION`    | `proposedTerms` is the only review-to-lifecycle semantic cost injection path and stays within aggregate budgets                     | Hard structural choke point and budgets; semantic usefulness is soft            | T1.5                                                                 |
| `C-EXACT-CLOSURE`         | Exact declared bytes are absent from the governed live closure scope                                                                | Hard                                                                            | T2.4 `mechanical-transform` engine evidence on exact candidate trees |
| `C-GRAPH-COMPLETENESS`    | All semantic consumers and dependency edges have been found                                                                         | Soft and not proved by grep or declared DAG structure                           | Residual, never delivered as hard                                    |
| `C-CANONICALIZATION`      | Canonical subjects preserve every assurance-relevant distinction                                                                    | Tested and fail-closed; residual implementation risk remains                    | T1.5 for planning subjects; later owners extend their subjects       |
| `C-COVERAGE-COMPOSITION`  | Composed review manifests cover exactly the claimed subject                                                                         | Hard algorithm over declared facts; semantic adequacy is soft                   | Future T2.3; not delivered by T1.5                                   |
| `C-CONVERGENCE`           | A reused descendant has a complete valid proof path to the current generation                                                       | Hard validator over declared graph; proof/canonicalizer defects remain residual | T1.5                                                                 |
| `C-PROVIDER-IDENTITY`     | Local provider identity from runtime hints or adapter assignment                                                                    | Soft                                                                            | T1.5 records assurance only                                          |
| `C-CONTAINMENT`           | A local provider is confined against the same OS user                                                                               | Soft without stronger isolation                                                 | Not delivered as hard                                                |
| `C-DEGRADED-INDEPENDENCE` | A collaboration grant recreates missing provider independence                                                                       | False; grant authorizes only visible degradation                                | T1.5                                                                 |
| `C-AVAILABILITY`          | The ordinary two-provider path meets wait, grant, latency, and cost budgets                                                         | Empirical pilot claim                                                           | T1.5 pilot, never structural proof                                   |

The registry separates hard presence/currentness from semantic judgment:
semantic completeness and WHY truth remain soft; provider identity and
same-user containment remain soft; reviewer judgment is advisory rather than
proved correct. T2.4 exact-byte closure applies only to deterministic
`mechanical-transform` contracts and does not claim graph completeness or
semantic equivalence. Degraded authorization does not recreate independence,
and availability remains empirical and not structural.

## Managed Task Lifecycle

The routine lifecycle is one repeated pair:

```text
propose → [ open-task → finalize ]×N → archive
```

Each pair produces one task-scoped commit. Per-task commits are the durable
provenance boundary for rollback, bisect, and concurrent-agent attribution;
they are not a reason to rerun the whole repository gate for every task.

### 1. Open the selected or next task

```bash
pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] --json
```

`open-task` carries the caller's intent; the engine selects the state-specific
transition. For an owned planning draft it durably commits the exact reviewed
plan and opens its task in one recoverable transaction. For an already
committed plan it first replays a canonical governing planning generation and
then opens the task directly. Omitting `--task` selects the first incomplete
task in the validated plan; `--task` remains available when the plan permits a
different order. Planning state does not change the authorization rule below.

Task authorization is conditional, not a ceremony for every change. The
engine evaluates `guard.json` task scope against the reviewed path-role
registry configured by `workflow/config.json`:

- ordinary product, documentation, and test scope opens without a mandate;
- scope matching a configured protected role requires one exact human-signed
  mandate at task ingress; an unlisted path is not implicitly protected;
- the engine evaluates the actual implementation diff again before completion;
  a protected diff cannot use ordinary `finalize`, even when its ingress
  mandate is current, and must follow the returned human-only V2
  approve-and-apply recovery;
- external effects and control-plane authority retain their separate, stronger
  policies.

The mandate authorizes bounded preparation. It is not exact Apply authority.
If planning begins with ordinary scope and later work needs a protected path,
the current operation fails closed instead of silently widening authority.

When `finalize` returns `PROTECTED_TASK_APPLY_REQUIRED`, run its exact `abort`
recovery first. Abort releases the task session without discarding the candidate
bytes. The maintainer then runs V2 `preflight` and `approve-and-apply` for that
exact candidate at a controlling terminal. After the protected authority commit
exists, reopen the still-incomplete task with the same active mandate and run
ordinary `finalize` to record only the task/document completion projection. The
two commits intentionally separate human-approved protected bytes from task
bookkeeping; neither commit alone claims both authorities.

`start` is a phase-1 deprecated compatibility command for callers that already
know the plan is committed. New callers do not inspect planning state to choose
between verbs.

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

### 3. Finalize the exact task tree

```bash
pnpm workflow finalize <session-id> --message "Imperative subject" --json
```

`finalize` rejects out-of-scope changes, projects the exact task checkbox and
controlled documents, runs the effective check policy against that candidate,
stages only the checked tree, and creates the task commit with engine-owned
trailers. Its durable transaction is replay-safe across ordinary interruption;
rerun the same command or follow `finalize-recover` when status requests it.

The effective checks are state-dependent:

1. An intermediate finalize runs only the task's targeted
   `guard.json.requiredChecks`. Planning should not use the full gate as a
   routine per-task default.
2. If this exact projection changes the plan from not-all-terminal to
   all-terminal, apply `workflow/config.json.allTasksTerminalChecks` while
   retaining every task check they do not explicitly cover. The repository
   `workflow-full-gate` covers `workflow-tests`, so the same eight shards do not
   run twice; typecheck, lint, format, document, database, and other
   independent task checks remain required when selected by the task.
3. `--full-gate` may request the same escalation early. There is no
   agent-controlled defer or skip flag; a reviewed waiver must use its normal
   policy path.

The trigger is the state transition, not a task number. Adding or reopening a
task rearms the terminal transition; waived and out-of-order tasks are handled
by their projected terminal state. Risk-specific heavy checks remain in each
task's `requiredChecks` and are independent of this final-change escalation.

When the terminal transition selects `workflow-full-gate`, the CLI announces:

```text
This finalize completes the change → running full gate.
```

The full-gate runner then prints its four startup hints, including the monitor,
machine-readable status, exact log paths, and the failure-query command:

```text
Monitor: pnpm workflow:test:status
Machine status: pnpm workflow:test:status --json
Full log: <exact stdout log path>
Failures: pnpm workflow:test:failures
```

The runner reuses a passing receipt only for the exact same projected tree and
generated/runner identity.

When the tracked documentation-closure activation marker is present in the
task baseline, the task whose projection closes the all-tasks-terminal set also
performs a whole-change documentation review. The engine derives that review
from the parent of the first managed task commit through the final projected
candidate, excluding only the task checkbox and generated completion
projections. It adds code-owned hints for likely documentation consumers, but
the authenticated TaskDiff reviewer must return exactly one disposition:

- `updated`, naming the changed documentation paths;
- `generated-verified`, naming the changed sources, generated documents, and
  check evidence;
- `no-impact`, with a concrete rationale and only when no documentation path
  changed; or
- `needs-changes`, naming exact `docs/**` or `README.md` remediation paths.

`needs-changes` does not grant a broad documentation wildcard. It adds only the
reviewer-named paths to that session, requires authenticated challenge closure,
and then requires fresh checks and a fresh TaskDiff review of the new candidate.
The original review digest and exact remediation paths remain in the final
closure record. Provider shortage uses the existing TaskDiff collaboration
grant path, including caller-supplied or direct-human review; rendered assurance
continues to report actual achieved independence rather than upgrading it.

The final task commit embeds the canonical documentation closure between its
subject and managed trailers. Commit recovery compares that message with the
content-addressed commit report, while CI and archive replay the whole-change
tree/path/digest binding directly from Git. Histories whose task baseline
predates activation remain valid and are not retroactively re-reviewed.

### Compatibility lifecycle

Existing integrations may still use:

```bash
pnpm workflow check <session-id> --json
pnpm workflow complete-task <session-id> --json
pnpm workflow finish <session-id> --json
pnpm workflow commit <session-id> --message "Imperative subject" --json
```

`finish` resolves the same additive terminal policy, so this longer route
cannot bypass the full gate. `finalize-task` is also retained as a deprecated
compatibility surface that performs the durable projection and leaves commit
separate:

```bash
pnpm workflow finalize-task <session-id> --json
pnpm workflow commit <session-id> --message "Imperative subject" --json
```

The commit subject must be one trimmed line without control characters or
trailers. If commit ref advancement is interrupted after the commit object is
created, rerun the same command so the engine can reconcile it.

Do not write a commit hash into `CURRENT_AND_NEXT_STEPS.md` or create a
hash-only metadata commit. Use Git or `workflow status` when a hash is needed.

### 4. Abort only when abandoning the session

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

For a reviewed v2 range, the verifier also constructs canonical
`RequiredPreMergeCoverage`, proves that each included task names the effective
reviewed planning generation, and composes current PlanReview and terminal
TaskDiffReview references into a content-addressed `PreMergeAssuranceNode`.
A fully covered ordinary single-task range creates and replays that node with
zero provider calls. Extra bytes or base context, multiple tasks, or another
integration question produce one minimal exact request containing only the
uncovered coverage plus referenced prior results.

The deterministic preparation is read-only and resumable. When a provider or
human review adapter has produced the exact typed
`integration-delta-review-submission.v1` envelope returned by the failure
details, resume with:

```bash
pnpm workflow ci --base <base-commit> --head <head-commit> \
  --input <integration-review.json> --json
```

The base/head binding is immutable: a different range, planning generation,
coverage manifest, or integration subject cannot reuse the stored node. Review
judgment remains advisory; deterministic CI, branch protection, and human
merge policy remain the hard shell. This command does not infer provider
identity from an environment variable or silently expand an uncovered subject.

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

### Whole-round authority plan

For a complete break-glass round, prefer the durable wrapper over manually
reassembling the primitives. An intent names one reviewed change/task/profile,
reason, commit subject, sorted exact mutations with before digests, and any
already-reviewed effects or evidence waivers. Preparation validates the
profile and exact bytes, renders the complete unified diff, and writes the
first journal revision before changing a target file:

```bash
pnpm workflow authority-plan prepare --intent <intent.json> --json
pnpm workflow authority-plan status <plan-id> --json
```

The engine then exposes one explicit state sequence:

```text
prepared → applying-local → local-applied → awaiting-attestation
         → attestation-issued → completed
```

Only the two signing transitions are human-only and require a controlling
interactive terminal:

```bash
pnpm workflow authority-plan approve-and-apply <plan-id> --json
# Human publishes the exact returned grant/audit tag and merges through the
# configured remote review path.
pnpm workflow authority-plan resume <plan-id> --json
pnpm workflow authority-plan attest <plan-id> --json
# Human publishes the exact returned attestation tag.
pnpm workflow authority-plan resume <plan-id> --json
```

`resume` only observes and journals: it never signs, pushes, opens or merges a
pull request, or substitutes a different intent. A crash after the local
authority commit replays that exact commit and grant rather than applying the
mutation twice. Completion requires both publication handoffs, the observed
protected-branch rewrite, and the second attestation ceremony. The low-level
maintainer commands below remain recovery and expert surfaces. This wrapper is
implemented and integration-tested; its required real human round remains a
separate pilot and the repository remains bootstrap-only until that pilot and
the remote prerequisites are independently verified.

For that real round, retain the terminal authority-plan status as the friction
record. It must report `operatorSigningCeremonies`, `publishedTagHandoffs`, and
`remoteMergeObserved`, plus every interruption/resume observed by the
operator. The expected healthy whole round has two signing ceremonies and two
publication handoffs; these are explicit human-custody boundaries, not routine
agent confirmations. Do not copy signer material or credentials into the
report.

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

| Command                                                                                                                                                                         | Use and boundary                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm workflow maintainer grant preflight --profile <profile-id> --json`                                                                                                        | Validate the reviewed V2 profile, current base, candidate paths, and checks without signing or mutating grant state.                                                                                                                       |
| `pnpm workflow maintainer grant approve-and-apply --change <id> --task <task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json\|none> --json` | Check, interactively sign, and atomically apply one immutable candidate under a short-lived one-shot V2 grant. The result includes the exact audit-tag `publishCommand` and post-merge `attestationRelayCommand`.                          |
| `pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> --json`                                                                              | Replace one terminal V2 attempt only after replaying its exact governed candidate and current recovery policy; it never broadens the original candidate.                                                                                   |
| `pnpm workflow maintainer attestation-relay --original <commit> --json`                                                                                                         | After a rebase merge, find the exact rewritten protected-main commit and any rewritten grant base, then emit the literal `maintainer attest` and SSH tag-publish commands. This command is read-only and never signs.                      |
| `pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] --json`                                                                     | Interactively sign one canonical authority attestation binding a rebase-rewritten protected-main authority commit to its retained signed original, then create the immutable `workflow-attestation/<grant-id>` tag targeting the original. |
| `pnpm workflow maintainer inspect [grant-id] --json`                                                                                                                            | Read redacted available, reserved, consumed, or revoked local state. It grants no authority and exposes no private signing material.                                                                                                       |
| `pnpm workflow maintainer revoke <grant-id> --reason <text> --json`                                                                                                             | Human-only terminal revocation of an available or reserved grant with a durable reason. Repeating it is cleanup-safe; a consumed or revoked grant never becomes available again.                                                           |

The legacy V1 `maintainer grant` issuer and `authority-start` session family
cannot authorize new work. Their signed envelopes, tags, terminal records, and
revocations remain readable so historical commits can still be verified and
audited; retained historical verification is not a signing fallback.

Grant issuance creates both the local single-use token and an annotated audit
tag. Run the exact `publishCommand` returned by the command immediately; it has
this form:

```bash
git push git@github.com:<owner>/<repository>.git refs/tags/workflow-grant/<grant-id>:refs/tags/workflow-grant/<grant-id>
```

Do not delete or replace the tag after revocation, failure, expiry, or
consumption. The envelope is non-secret audit evidence, and CI requires the
exact protected tag. Do not extend, copy, or reuse an expired grant for a new
authority operation; issue a new grant from the new exact base. Historical CI
replay may read an expired grant only when the signed authority commit itself
was created within that grant's original lifetime.

### Authority execution sequence

Use one atomic V2 approval for one exact authority candidate:

```bash
pnpm workflow maintainer grant approve-and-apply \
  --change <change-id> --task <task-id> --profile <profile-id> \
  --reason "Reviewed reason" --message "Imperative authority subject" \
  --effects-file none --json
# Run the exact publishCommand returned above.
pnpm workflow maintainer inspect <grant-id> --json
```

Push the branch, open a PR, and require the base-owned
`workflow-assurance` result. CI verifies the grant and commit signatures, audit
tag, parent/base, policy blob, repository identity, the commit timestamp against
the signed grant lifetime, exact diff, single claim across the PR range, phase
transition, and every normal check. A grant that expires after its signed commit
was created remains historical evidence, but it cannot authorize another
operation.

Any V2 failure after reservation follows its durable terminal or recovery
state. Replay the exact returned recovery command; use
`reissue-and-apply` only where the governing record explicitly permits it.
Legacy `authority-abort` and `authority-recover` are not alternate entry points
for new work. Preserve the error, inspect the grant, and obtain explicit
maintainer approval before discarding leftover edits. A lost trusted key,
missing or altered journal, divergent branch, or damaged trust root is a
repository-admin, out-of-band recovery event with separately retained audit
evidence—not a workflow command or AI-accessible override.

### Authority tree attestation

When a protected-branch merge retains the exact human-signed authority commit,
historical replay validates that commit directly against its parent policy and
grant; no attestation is needed. A rebase merge instead rewrites the commit OID
and signature. In that case, an authority attestation binds the rewritten
protected-main commit back to its retained signed original by transition
identity, not commit identity: equal result trees, equal single-parent trees,
byte-identical canonical managed messages, the exact grant, and a valid original
commit signature.

Trust is split across three boundaries. The protected branch decides which
rewritten commit is authoritative; retained Git objects and protected tags
preserve the signed original and its human-signed statement; and base-owned
workflow code plus previously trusted signer material decide whether the
mapping is acceptable. A candidate commit can never validate its own evidence
or add its own trust.

After the authority PR merges, update the protected remote-tracking ref and run
the exact `attestationRelayCommand` returned by approve-and-apply (or by a
recovered low-level authority commit). The relay derives the rewritten main and
base OIDs without shell substitution and returns one literal signing command:

```bash
pnpm workflow maintainer attestation-relay --original <literal-original-commit> --json
# Run the exact attestCommand returned above at the controlling TTY.
# Then run the exact SSH publishCommand returned by maintainer attest.
```

The relay derives the primary grant from the legacy authority trailers or the
current V2 application receipt. The signing command validates every mapping,
including the explicit grant-base pairs used by historical grant replay, signs
one canonical envelope in the distinct
`expense-app.workflow.authority-attestation.v1` namespace, and creates the
immutable annotated tag `refs/tags/workflow-attestation/<grant-id>` targeting
the signed original so it stays reachable. Run the exact returned
`publishCommand` immediately, exactly like a grant tag.

Base-owned `workflow-assurance` replays protected first-parent history before
candidate commits are evaluated: every authority commit on the base must either
remain the directly valid signed original or resolve to exactly one valid
protected attestation, and every historical grant base referenced by a rewritten
commit must have a complete explicit mapping. Missing, conflicting, duplicated,
malformed, or candidate-supplied evidence fails closed. This is an intentional
migration gate: after the verifier merges, the next pull request stays red until
each historical authority commit is directly replayable or its attestation tag
is protected, published, and replayable. Never re-disable the required check to
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
   covered by a reviewed V2 profile. Do not put product work or the phase
   transition in this pilot.
2. Record V2 preflight, read-only inspection, idempotent explicit revocation,
   expiry rejection, and terminal cleanup after a deliberate pre-apply
   failure. Never reuse those grant IDs or delete their audit tags.
3. Run `approve-and-apply` for the successful exact candidate and publish its
   returned audit tag. Replay only the exact returned recovery state to prove
   idempotency. Interrupted commit points remain integration-test evidence; do
   not deliberately crash or corrupt a real repository.
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

## Execution Recovery, Metrics, and Evidence Retention

The V2 execution core keeps provider failures inside one durable Job and
records every replacement as a distinct Attempt. Operators can inspect that
state and process due automatic work without creating an unbounded daemon:

| Command                                                                          | Purpose                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm workflow job list --json`                                                  | List durable execution jobs.                                                          |
| `pnpm workflow job status <job-id> --json`                                       | Show Attempt lineage, blockers, and the accepted result.                              |
| `pnpm workflow job retry-request <job-id> --timeout <ms> --json`                 | Create a scoped execution-budget grant request.                                       |
| `pnpm workflow job retry <job-id> --grant <grant-id> --json`                     | Start the exact approved replacement Attempt.                                         |
| `pnpm workflow job retry-pump --limit <count> --json`                            | Process at most the requested number of due replacement or read-only probe schedules. |
| `pnpm workflow job retry-schedules --json`                                       | Inspect durable retry schedules.                                                      |
| `pnpm workflow job retry-receipts [schedule-id] --json`                          | Inspect immutable retry/probe processing receipts.                                    |
| `pnpm workflow metrics show --json`                                              | Read production resilience, speed, governance, and storage metrics.                   |
| `pnpm workflow retention inspect --json`                                         | Inspect evidence retention state.                                                     |
| `pnpm workflow retention sweep --limit <count> --json`                           | Run one bounded TTL pruning pass.                                                     |
| `pnpm workflow retention pin <workflow-id> <evidence-id> --reason <text> --json` | Human-only exact-evidence pin with a durable reason.                                  |

The production worker performs only a bounded retry and pruning sweep per
terminal invocation. Automatic maintenance never pins evidence, and pruning
must preserve evidence referenced by the current manifest or an active result.

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
`pnpm workflow handoff validate --json` for read-only diagnostics. Write-capable
rendering is internal to the lifecycle transition that owns the projection.

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

This curated-section CAS is distinct from final-task documentation closure.
Ordinary product changes update documentation inside their managed task and are
reviewed with the whole change; `document-refresh` remains the narrow tool for
an exact replacement of an already managed curated section.

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

## Full-Gate Economy and Progress

Use targeted tests during RED/GREEN iteration. Run the coherent workflow-engine
gate once with `pnpm workflow:test`. The wrapper runs one Node test coordinator
over eight deterministic shard entrypoints with concurrency bounded at four.
The tracked shard manifest owns every physical workflow-engine test exactly
once, including the test bodies in the two legacy aggregate roots and nested
runner suites. Adding, removing, or reassigning a test requires regenerating and
validating that manifest; an incomplete or duplicate inventory fails closed.
Validate tracked ownership and generated wrapper bytes with:

```bash
node --experimental-strip-types scripts/generate-workflow-test-shards.ts --check
```

To rebalance after a representative completed gate, regenerate from that run's
complete telemetry sidecar and exact run ID, then review the manifest and wrapper
diff before running the next coherent gate:

```bash
node --experimental-strip-types scripts/generate-workflow-test-shards.ts \
  --telemetry <test-telemetry.jsonl> --run-id <run-id>
```

At startup, the wrapper prints four one-time hints: the human monitor command,
its `--json` machine form, the absolute full-log path, and the failure-summary
command. Poll the latest snapshot with `pnpm workflow:test:status`, use
`pnpm workflow:test:status --json` for structured output, inspect bounded current
failures with `pnpm workflow:test:failures`, and inspect observational per-test
timings with `pnpm workflow:test:timings`. Raw stdout/stderr and the telemetry
sidecar remain in private files under `.git/workflow-engine/full-gate/`;
routine polling never replays the full test output into chat context.

A successful local receipt is observational only: it cannot authorize a task,
commit, merge, or archive. A passing receipt additionally requires a complete
telemetry footer, the exact manifest-bound physical-file set, no unattributed
test nodes, and outcome counts that reconcile with the terminal test summary.
Reuse requires those same intact coverage bytes plus the exact projected Git
tree, generated-artifact digest, Node runtime, command, platform, and working
directory. Old or partial receipt formats are not reusable. An empty commit with
the same tree may reuse that result. A material merge or a high-risk lifecycle,
security, recovery, or generated-artifact change must run again with an explicit
reason, for example:

```bash
pnpm workflow:test --reason "material lifecycle merge"
```

The identity lock rejects parallel gates for the same tree. Three minutes with
no counter, CPU, or log activity triggers process-tree inspection; it never
automatically terminates a quiet process.

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
   Review and update the active `expense-app-v2` schema fork and
   `openspec/schemas/expense-app-v2/provenance.json`. If the compatibility-only
   `expense-app` v1 fork remains supported, review its provenance separately;
   do not substitute it for the active v2 contract, deep-import internals, or
   copy the archive merge implementation.
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

Registered fake-backed checks are the executable regression evidence for
provider orchestration. A credential-safe local observation may also exercise
ordinary Codex and Claude read-only adapters when both are callable, but that
observation is not a structural availability proof and does not make provider
text workflow authority.

Record each attempted provider, role, invocation identity, terminal state,
mutation observation, and achieved independence without credentials or raw
secrets. Distinguish healthy two-provider success from adapter unavailability.
Use a degraded path only after an exact human collaboration grant, and retain
the lower achieved independence; human authorization does not recreate the
missing perspective.

The engine now provides a strict v1 result schema and verifier:

```bash
pnpm workflow adapter availability-pilot \
  --record workflow/provider-availability-pilots/<name>.json --json
pnpm workflow adapter verify-availability-pilot \
  --record workflow/provider-availability-pilots/<name>.json --json
```

The run uses the ordinary lifecycle-owned read-only provider runner. Its
tracked result writes no raw provider output or credentials; ordinary local
invocation evidence remains under the engine runtime policy. It accepts only
one successful Codex and one successful Claude observation with unchanged
governed projections, ordinary provider independence, zero grants, and latency
inside repository policy. Because the adapters do not expose a trustworthy
billed-usage field, cost is recorded honestly as the policy reservation upper
bound with `actualUsageReported: false`; it must not be described as actual
spend.
Unavailable adapters produce a durable `incomplete` observation and fake-backed
tests never close `C-AVAILABILITY`. The real ordinary-path record
`workflow/provider-availability-pilots/c-availability-2026-08-15.json` passed
the strict verifier on 2026-08-15: Codex and Claude both succeeded, their
governed projections remained unchanged, and the run used zero grants and zero
human actions. This closes the empirical pilot claim for that exact baseline;
it does not establish structural availability, a future SLA, or actual billed
cost.

The disposable repository rehearsal proves the implementation path but is not
the workflow-adoption pilot. The gate below is the separate post-merge
workflow-adoption pilot; it does not replace or broaden the exact-baseline
`C-AVAILABILITY` observation described above. Workflow-adoption support remains
undeclared until a maintainer performs this gate after the integration is
merged and reachable from the configured base:

1. Update the configured base locally and create a new small, non-database
   OpenSpec change with one task and a harmless, tightly scoped repository
   change. Use a new `work/<pilot-change-id>` branch and a normalized intent
   file. Confirm that the running UI visibly exposes the exact governed skills
   `openspec-explore`, `openspec-propose`, and `workflow-engine`; otherwise
   record the pilot as incomplete rather than substituting an untracked skill.
2. Drive the investigation-first wrapper through its exact returned
   checkpoints until it reports `planning-complete`:

   ```bash
   pnpm workflow propose <pilot-change-id> --intent <intent.json> --json
   pnpm workflow propose <pilot-change-id> --resume --input <envelope.json> --json
   ```

   Preserve the returned `state`, `nextAction`, `inputSchema`, provider
   identities, achieved independence, and terminal planning transition. Do not
   substitute a hand-authored plan commit.

3. Execute its one task with the preferred managed pair:

   ```bash
   pnpm workflow open-task <pilot-change-id> --task <task-id> [--mandate <mandate-task-id>] --json
   pnpm workflow finalize <session-id> --message "Complete pilot task" --json
   ```

   Record the semantic change/task IDs, exact commands, check outcomes, and
   observed Codex skill-discovery surface in the pilot review. Also record
   provider wait count/rate, collaboration-grant count/rate and exact cause,
   provider latency, the reported or reserved cost basis, and direct human
   review/action count. Do not put commit hashes in the semantic handoff.

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
   UTC date prefix varies if the replay crosses a day. Declare
   workflow-adoption support only after all results are recorded and the
   required remote rule is confirmed; this declaration does not broaden the
   exact-baseline `C-AVAILABILITY` observation.

Do not perform the post-merge pilot inside the integration branch, describe the
disposable rehearsal or Task 7.1 local observation as the completed pilot, or
invent a provider invocation the engine did not surface.

## Archived Legacy Material

Superseded checklists, plans, status reports, logs, and templates are preserved
under `docs/archive/legacy/` using their former path below `docs/`. They are
immutable historical inputs and never override this workflow or current
canonical documents. Editing, restoring, renaming, or deleting archived
material requires new explicit maintainer approval.
