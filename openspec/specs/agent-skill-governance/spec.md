# agent-skill-governance Specification

## Purpose
TBD - created by archiving change replace-spectra-agent-skills-with-openspec. Update Purpose after archive.
## Requirements
### Requirement: Repository Agent Skill Surface

The repository SHALL expose `openspec-explore` and `openspec-propose` as its
managed SDD skills under `.agents/skills/`. Each skill MUST be byte-identical to
its canonical counterpart under `.codex/skills/`. The repository MUST NOT
track or retain Spectra agent-skill entries under `.agents/skills/`.

#### Scenario: Approved OpenSpec skill mirrors are present

- **WHEN** the repository agent-skill surface is validated
- **THEN** both approved OpenSpec skills exist and match their canonical Codex skill files byte for byte

#### Scenario: Spectra skill is reintroduced

- **WHEN** a Spectra-prefixed agent skill exists under `.agents/skills/`
- **THEN** the repository contract fails and identifies the conflicting agent surface

#### Scenario: OpenSpec mirror diverges

- **WHEN** an approved `.agents` OpenSpec skill differs from its canonical `.codex` source
- **THEN** the repository contract fails before the change can pass managed checks

### Requirement: Historical Spectra Data Has No Execution Authority

The tracked root `.spectra.yaml` MUST be treated only as historical
compatibility data. Agent instructions and maintenance guidance MUST prohibit
Spectra commands, skills, adapters, generated lifecycle assets, and lifecycle
state from authorizing repository work. Nested `.spectra.yaml` metadata MUST
NOT exist under `openspec/`.

#### Scenario: Agent reads repository governance

- **WHEN** an agent determines the planning and execution workflow from repository instructions
- **THEN** it is directed to OpenSpec for planning and `pnpm workflow` for execution without a Spectra execution path

#### Scenario: Nested Spectra metadata is introduced

- **WHEN** `.spectra.yaml` exists at `openspec/` or below it
- **THEN** the repository contract fails and the nested metadata grants no lifecycle authority

#### Scenario: Historical root configuration remains

- **WHEN** the tracked root `.spectra.yaml` is encountered
- **THEN** repository guidance classifies it as historical-only and does not invoke or regenerate Spectra assets

