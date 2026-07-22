# OpenSpec skill mirror maintenance

The repository exposes two planning-only OpenSpec skills to agents:

- `openspec-explore`
- `openspec-propose`

The versioned OpenSpec asset manifest governs their generated Codex, Claude
Code, and `.agents` deliveries. Each `.agents/skills/` file must remain
byte-identical to its canonical Codex counterpart; the workflow-engine asset
contract enforces that invariant and the Claude parity contract.

Do not edit a delivered skill independently or copy mirrors by hand. During an
approved managed change, run `pnpm workflow openspec-assets generate --json`
to regenerate every delivery target from one pinned tool-plural source run,
then run `pnpm workflow openspec-assets check --json`.

These skills create or refine planning artifacts only. They do not authorize
task execution, completion, staging, commits, or archive transitions; those
remain the responsibility of `pnpm workflow`.

The tracked root `.spectra.yaml` is historical compatibility data only. Do not
invoke Spectra, regenerate Spectra skills, or add nested `.spectra.yaml` files
under `openspec/`.
