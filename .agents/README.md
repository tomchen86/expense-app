# Repository skill mirror maintenance

The repository exposes three reviewed skills to agents:

- `openspec-explore`
- `openspec-propose`
- `workflow-engine`

The versioned OpenSpec asset manifest governs their generated Codex, Claude
Code, and `.agents` deliveries. Each `.agents/skills/` file must remain
byte-identical to its canonical Codex counterpart; the workflow-engine asset
contract enforces that invariant and the Claude parity contract.

Do not edit a delivered skill independently or copy mirrors by hand. During an
approved managed change, run `pnpm workflow openspec-assets generate --json`
to regenerate every delivery target from one pinned tool-plural source run,
then run `pnpm workflow openspec-assets check --json`.

The two OpenSpec skills investigate or create planning artifacts. The
`workflow-engine` skill routes later implementation, recovery, review,
finalization, and archive work to the public command surface. None of the
skills authorizes execution, completion, staging, commits, signing, protected
Apply, or archive transitions; those remain the responsibility of the exact
`pnpm workflow` command and any required human checkpoint.

The regenerated `openspec-propose` deliveries route formal planning through
`pnpm workflow propose`: callers follow its exact typed checkpoints, while the
engine owns investigation, execution, PlanReview, managed-ledger, and planning
transition fields. Do not prompt-author those fields or jump directly to the
underlying plan commit. The generated skill families are reviewed and
delivered byte-identically across their declared mirrors. Each skill remains
confined to its documented intent; one skill never grants the authority owned
by another command.

The optional `workflow finalize-task` handoff is a projected single-pass
substrate with caught ordinary-failure rollback. It checks and stages one
identical prospective tree, leaves `workflow commit` separate, and does not
claim crash-safe recovery, full atomicity, or automatic commit.

The tracked root `.spectra.yaml` is historical compatibility data only. Do not
invoke Spectra, regenerate Spectra skills, or add nested `.spectra.yaml` files
under `openspec/`.
