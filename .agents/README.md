# OpenSpec skill mirror maintenance

The repository exposes two planning-only OpenSpec skills to agents:

- `openspec-explore`
- `openspec-propose`

Their canonical sources are the matching files under `.codex/skills/`. Each
`.agents/skills/` copy must remain byte-identical to its canonical source; the
workflow-engine repository contract enforces that invariant.

Do not edit a mirror independently. Update its canonical source through a
managed change, copy the complete file into this directory, and run the
registered workflow checks.

These skills create or refine planning artifacts only. They do not authorize
task execution, completion, staging, commits, or archive transitions; those
remain the responsibility of `pnpm workflow`.

The tracked root `.spectra.yaml` is historical compatibility data only. Do not
invoke Spectra, regenerate Spectra skills, or add nested `.spectra.yaml` files
under `openspec/`.
