## Context

The current planning-asset pipeline was introduced as a Codex-only slice of the OpenSpec integration. A pinned `openspec init --tools codex --profile custom` run produces two skills and two Codex-home prompts; a reviewed overlay adapts their command surface; Prettier formats the overlaid bytes; and a manifest pins source and final digests. Hooks validate the tracked files, while pull-request assurance regenerates them.

The precedent survey found six boundaries that this change must handle together:

1. `workflow-format` names the whole `workflow/` tree, so it formats the manifest and prompt copies even though their generator already chooses their bytes.
2. `checkCodexPlanningAssets` also resolves and runs Prettier when reconstructing expected output. Narrowing the registered format scope alone would therefore leave asset validity formatter-dependent.
3. `validateWorkflowIntegrationAssets` returns when the manifest is absent, including on the CI regeneration path. A half-completed path rename can silently disable asset assurance.
4. The manifest covers `.codex/skills` and prompts, while `.agents/skills` is a separate normative byte-identical mirror and Claude receives no governed native skills.
5. The current forbidden-command matcher rejects bare lifecycle commands but incorrectly accepts `pnpm exec openspec archive` and Spectra invocations. Pinning the binary does not add workflow authorization.
6. `workflow/checks.json` is an authority file. A guard cannot reference a new check ID before that ID exists, and authority replay intentionally records only definitions already required by the parent policy or guard. An added-but-unused definition is structurally validated but first becomes executable evidence when a later guard references it.

The pinned OpenSpec 1.6.0 implementation and an isolated probe resolve the memo's generator uncertainty: one `--tools codex,claude` invocation with the existing custom `explore`/`propose` allowlist creates both native skill sets. The two tools' raw skill bytes are identical. Delivery mode `both` also creates two Claude slash commands; those are expected temporary output but are not repository delivery targets.

The tracked Roadmap's repository-workflow-adoption priority motivates the change. The ignored memo and handoff informed the investigation but do not supply executable or normative authority.

Trust is split across four reviewed boundaries:

- the exact pinned OpenSpec package, argv, isolated environment, and source closure;
- repository-owned overlay rules and forbidden-authority validation;
- the tracked manifest's source, overlay, and delivered-byte pins;
- the workflow engine, registered check definitions, managed task evidence, and human-only authority transition.

## Goals / Non-Goals

**Goals:**

- Provide one tool-neutral asset command and manifest home for Codex, Claude, `.agents`, and Codex prompt delivery.
- Preserve the planning-only allowlist of exactly `explore` and `propose` across every target.
- Make validity checks read-only, fail-closed, and independent of Prettier while leaving generation free to emit deterministic reviewed formatting.
- Make every source, overlay, final byte, path closure, and forbidden authority decision explicit in a versioned manifest contract.
- Introduce the registered asset check and narrowed format scope through the existing signed authority path, then prove its first managed use.
- Keep the rename atomic with the fail-closed integration change so no committed intermediate tree can skip validation.

**Non-Goals:**

- Expose OpenSpec apply, update, sync, archive, bulk-archive, store, or Claude slash-command entry points.
- Change the repository workflow lifecycle, OpenSpec version, application code, dependencies, database policy, or remote rules.
- Install project skills into a real user home or overwrite existing Codex prompts.
- Rewrite archived changes or preserve the old public CLI as a compatibility alias.
- Let an agent issue a maintainer grant, create a signed authority commit, publish its audit/attestation tags, or claim those human steps succeeded.

## Decisions

### 1. Keep one active change and use three governed phases

The change remains one WIP item but crosses three pull-request phases:

1. ordinary managed tasks establish the handoff baseline, add transition regressions, and atomically deliver the renamed plural asset implementation;
2. a human maintainer changes only `workflow/checks.json` in one signed authority commit;
3. a planning revision adds the first task whose guard requires `openspec-assets`, and that task removes the temporary dual-form assertion and records managed evidence from the new check.

The initial guard could not name `openspec-assets`, because change validation correctly rejects unknown check IDs. After the authority commit merged and received its required attestation, this phase-three planning revision added the executable activation task and guard entry.

Splitting the directory/CLI rename into its own change was rejected. The current missing-manifest return would make a partially renamed tree fail open. A separate authority-only change was also rejected because it would add another active lifecycle without removing the required deferred-activation step.

### 2. Generate both tool sources in one isolated OpenSpec invocation

The generator runs the exact pinned CLI once with:

```text
init <temporary-project> --tools codex,claude --profile custom --force
```

An isolated `HOME`, XDG config/data home, `CODEX_HOME`, and temporary directory contain all upstream writes. The custom config retains `delivery: both` and the exact `explore`/`propose` workflow list. The generator validates deterministic diagnostics and exact upstream closures for:

- two Codex skills under the temporary project;
- two Claude skills and two expected-but-undelivered Claude commands;
- two prompts under the isolated Codex home.

Only the Codex skills, Claude skills, and Codex prompts are overlaid and delivered. `.agents` is not passed as an OpenSpec tool because OpenSpec 1.6.0 does not support skill generation for that adapter; its two files are copied from the reviewed Codex finals and verified byte-for-byte.

Separate Codex and Claude invocations were rejected because they duplicate process and diagnostic state while the pinned CLI already supports an ordered plural selection. Copying Codex raw sources into Claude was rejected because native upstream materialization works and its per-tool source paths should remain auditable.

### 3. Use a schema-v2 manifest with three digest stages

The manifest moves to `workflow/openspec-assets/manifest.json` and records:

- exact generator package/version/argv, custom profile, delivery mode, workflow allowlist, tool order, and expected source closures;
- overlay version and policy digest;
- formatter identity/config digest used only by generation;
- for each delivery entry, its target, kind, source path, destination path, source digest, reviewed-overlay digest, and final-byte digest;
- a mirror relationship for `.agents` entries while retaining the same three content pins as their canonical Codex entries.

The generator pipeline is deliberately three-stage:

```text
raw upstream source -> reviewed semantic overlay -> generator-formatted final
     sourceDigest           overlayDigest                finalDigest
```

`generate` may invoke the repository-pinned formatter to make final files reviewable and deterministic. `check` does not invoke or resolve that formatter: it regenerates raw sources, reapplies the pure overlay to verify the first two pins, then validates tracked final bytes against their reviewed final pins, content policy, and path closure. Repeated-generation integration coverage proves generator determinism separately.

This makes the tracked final-byte pin, not a formatter run during verification, the reviewed delivery authority. A final-byte or manifest change remains an explicit review diff and cannot be hidden by a post-generation formatting pass.

Removing the formatter from generation as well was considered. It would provide a fully derivable final stage, but every current Markdown asset differs from the repository's formatting policy and the old required `workflow-format` must still pass before the authority transition. That broader byte migration is unnecessary for separating trust from formatting. Keeping Prettier inside `check` was rejected because it preserves the coupling this change exists to remove.

### 4. Treat every live delivery surface as one closure

The repository validator owns exact `openspec-*` skill closure under `.codex/skills`, `.claude/skills`, and `.agents/skills`, plus the two prompt files under `workflow/openspec-assets/prompts`. It preserves unrelated tracked Claude configuration such as `.claude/settings.json` and does not install the temporary Claude commands.

Every final file is checked for a canonical plain path, single link, allowed destination, final digest, and forbidden authority. Codex and Claude skill finals must match each other for the pinned tool version, and `.agents` must match the canonical Codex finals. Unexpected OpenSpec skill names, missing targets, symlinks, hard links, special files, or prompt files fail closed.

The existing independent `.agents` comparison alone was rejected because a manifest claiming all delivery targets must not omit a normative agent surface.

### 5. Separate safe planning commands from all lifecycle authority

The overlay continues to pin approved read/planning invocations to `pnpm exec openspec` and hands implementation to `pnpm workflow`. The verifier is tightened so the executable prefix never exempts lifecycle behavior: apply, update, sync, archive, bulk-archive, and store commands remain forbidden whether bare, `pnpm exec`, `npx`, or otherwise adapted. Command-like Spectra invocations, external-store selection, OpenSpec-wide Bash permission, unreviewed slash syntax, and incompatible tool primitives also fail.

The same verifier runs for every delivery target before generation and during repository validation. Error names, module names, temporary prefixes, public result labels, and help text become `OPENSPEC_ASSET_*` or `openspec-assets`; no Codex-only compatibility alias remains. The prompt installer retains its Codex-specific option and overwrite refusal.

### 6. Make manifest presence a real integration invariant

The integration validator no longer returns merely because the manifest path is absent. Full workflow fixtures that invoke hooks or CI must install a valid governed asset fixture and deterministic fake upstream output; tests do not receive a production runtime bypass flag. A dedicated missing/renamed-manifest regression proves both hook and regeneration paths stop before reporting success.

This fixture cost is accepted because a fixture exercising the complete repository contract should not rely on the exact fail-open behavior being removed. Historical archived files remain untouched; pull-request assurance validates the current candidate tree's integration contract.

### 7. Give formatting and asset validity disjoint registered scopes

The completed authority commit made exactly two semantic edits to `workflow/checks.json`:

- add non-destructive `openspec-assets`, executing `node packages/workflow-engine/src/cli.ts openspec-assets check --json` through the registered runner;
- replace the broad `workflow` argument of `workflow-format` with exact human-maintained top-level workflow JSON files plus `workflow/schemas`, leaving `workflow/openspec-assets/**` out of the format check.

Before that commit, an ordinary test change accepted only the exact old and proposed new format definitions. The authority candidate was checked with its parent-pinned required set. CI adopted the changed required `workflow-format` definition from the signed candidate; the newly added but unused asset definition was structurally validated but not reported or executed as required evidence.

After merge and authority attestation, this planning revision adds a final task whose guard requires `openspec-assets`. That task is the first managed and CI execution of the new definition and changes the contract assertion to accept only the new format scope. It also folds in behavior-preserving post-merge review cleanup: make reviewed mirror resolution order-independent, remove three unused alias exports, and remove an implementation-coupled formatter call-count assertion while retaining the stronger formatter-independence regression. Adding the new check to maintainer policy was rejected: asset validation is relevant to asset-changing tasks and CI integration, not every unrelated authority commit.

### 8. Preserve TDD and executable evidence boundaries

Behavioral gaps receive failing tests before production changes: missing manifest, plural target drift, forbidden pinned lifecycle/Spectra commands, read-only checking without a formatter, and closure/digest failures. The authority add-definition behavior already existed; its test is characterization evidence rather than a fabricated RED. The old/new format assertion supplied exact pre-transition evidence for the authority form. The final review cleanup changes no supported behavior, so the existing mirror, formatter-independence, typecheck, and integration coverage provide its refactor evidence.

No API tests or `TEST_DATABASE_URL` are involved. Task completion, staging, commits, and archive remain exclusively workflow-engine transitions; a green standalone asset check is evidence only.

## Delegation Plan

- The pre-design Mode B/read-only precedent survey was completed in parallel with the primary investigation. Findings were cross-checked against source, tests, pinned OpenSpec 1.6.0, current checks, Git history, and isolated probes before this design was written.
- The mechanical module/path/error/CLI rename in the plural-asset task may be delegated as a Mode C patch-only codemod in an isolated worktree. The managed session remains the only place where the reviewed patch may be applied and committed.
- The primary implementer owns RED tests, manifest semantics, overlay/formatter separation, fixture changes, and final verification.
- Before the authority pull request merges, a Mode B read-only review must inspect the combined check-definition addition/change and CI replay with file-and-line evidence. It must specifically test whether an unused new definition can be laundered or treated as executed evidence.
- Any non-obvious test or CI failure pauses mutation while a read-only hypothesis check and an independent primary investigation run in parallel.

## Risks / Trade-offs

- **[Risk] A half-renamed manifest path disables validation** -> Rename command, modules, constants, manifest home, assets, consumers, and missing-manifest behavior in one managed task; add hook and CI regressions that delete or misname the manifest.
- **[Risk] Formatter-independent checking no longer re-derives formatted finals** -> Pin source, overlay, and final stages separately; reapply and verify the semantic overlay; validate every final against strict authority/path policy; require explicit manifest diffs; and prove deterministic generation in integration tests.
- **[Risk] The combined upstream run starts producing new files** -> Assert exact per-root source closures, including the expected discarded Claude commands, and fail before copying anything.
- **[Risk] Fixture migration creates a test-only bypass** -> Make complete fixtures satisfy the same manifest contract instead of adding a production opt-out.
- **[Risk] `.agents` drifts after Codex regeneration** -> Generate it from reviewed Codex finals, include it in the manifest, and retain the independent byte-equality repository contract.
- **[Risk] The authority commit adds a check that has never run as required evidence** -> Merge and attest it first, then add the new ID only to a fresh final task through a plan revision and require that task plus CI to execute it.
- **[Risk] The narrowed format list omits a human-maintained policy file** -> Enumerate every current top-level workflow JSON document and the schema directory in the exact transition assertion; any later file needs a reviewed definition change.
- **[Trade-off] The public command and error vocabulary break** -> Update all live consumers atomically and do not retain a misleading Codex-only alias; archived records remain historical and unchanged.

## Migration Plan

1. Plan-commit the complete initial artifacts on `work/separate-openspec-asset-validation` with only existing check IDs in `guard.json`.
2. Complete the scoped handoff-baseline task before any implementation or later planning revision.
3. Add the authority replay characterization and exact old/new format-contract test.
4. Complete the atomic asset migration RED -> GREEN -> REFACTOR: rename the public surface and files, add plural delivery and manifest v2, harden fail-closed/content/closure behavior, separate `check` from the formatter, regenerate every target, and update live guidance.
5. Merge the ordinary task commits and synchronize the active change branch with the configured base.
6. A human maintainer issues one short-lived grant for exact path `workflow/checks.json`, applies only the reviewed registry/format edits, runs `authority-check`, creates the signed authority commit, merges it through strict CI, and publishes/verifies the required authority attestation. Agents stop and report if any of these human prerequisites is absent.
7. Revise the plan to add the final activation task and guard entry requiring `openspec-assets`; submit that planning-only revision through `plan-commit` before starting the task.
8. Complete the activation task: require the new-only format contract; apply the accepted order-independent mirror, dead-alias, and formatter-test cleanup; refresh the semantic handoff; and capture fresh managed/CI evidence from `openspec-assets` and all other required checks.
9. Merge and archive through the normal workflow transition.

Before the authority commit, rollback is a managed logical revert of ordinary task commits. An unused/revoked/failed grant follows the maintainer cleanup lifecycle. After a signed authority commit is merged, rollback requires a separately reviewed authority transition; audit and attestation tags are never deleted to erase history.

## Open Questions

None. Tool count, upstream invocation, delivery surfaces, formatter boundary, public rename, authority sequence, and human-only steps are resolved by the user direction plus repository evidence.
