## MODIFIED Requirements

### Requirement: Repository Agent Skill Surface

The repository SHALL expose `openspec-explore` and `openspec-propose` as its managed SDD skills under `.agents/skills/`. Each skill MUST be a manifest-governed mirror that is byte-identical to its canonical counterpart under `.codex/skills/`. The repository MUST NOT track or retain Spectra agent-skill entries under `.agents/skills/`.

#### Scenario: Approved OpenSpec skill mirrors are present

- **WHEN** the repository agent-skill surface is validated
- **THEN** both approved OpenSpec skills exist, are listed as `.agents` delivery targets in the OpenSpec asset manifest, and match their canonical Codex skill files byte for byte

#### Scenario: Spectra skill is reintroduced

- **WHEN** a Spectra-prefixed agent skill exists under `.agents/skills/`
- **THEN** the repository contract fails and identifies the conflicting agent surface

#### Scenario: OpenSpec mirror diverges

- **WHEN** an approved `.agents` OpenSpec skill differs from its canonical `.codex` source or its manifest final-byte digest
- **THEN** the repository contract fails before the change can pass managed checks

#### Scenario: Agent mirror is omitted from the manifest

- **WHEN** either approved `.agents` skill is absent from the manifest delivery closure
- **THEN** generated-asset validation fails even if a separate byte copy exists in the worktree
