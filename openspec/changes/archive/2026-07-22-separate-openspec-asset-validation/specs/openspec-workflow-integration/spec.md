## ADDED Requirements

### Requirement: Planning-Only OpenSpec Asset Interface

Repository-delivered OpenSpec assets SHALL expose only exploration and proposal behavior across Codex, Claude Code, `.agents`, and reviewed Codex prompt targets, and MUST hand implementation authority to the repository workflow. Asset validity MUST be established by the versioned asset contract rather than by a formatting check.

#### Scenario: Tool-plural planning assets are regenerated

- **GIVEN** a clean temporary project and isolated home, XDG, Codex, and temporary directories
- **WHEN** the pinned generator selects Codex and Claude with the reviewed custom workflow allowlist
- **THEN** one upstream run produces the expected Codex and Claude source closures
- **AND** the repository receives only reviewed explore and propose skills, `.agents` mirrors, and Codex prompts
- **AND** no real user Codex or Claude state is modified

#### Scenario: Claude commands or lifecycle skills are generated upstream

- **WHEN** the isolated upstream run emits its expected Claude command files or any source outside the reviewed closures
- **THEN** expected Claude commands are discarded rather than delivered
- **AND** any unexpected source causes generation to fail before repository files are written

#### Scenario: Asset stages are validated

- **WHEN** generated-asset verification runs
- **THEN** it verifies exact generator policy plus raw-source, reviewed-overlay, and delivered-final digests for every target
- **AND** it verifies canonical paths, exact target closure, mirror equality, and final reviewed content

#### Scenario: Asset check runs without the formatter

- **WHEN** the registered OpenSpec asset check validates a generated repository tree
- **THEN** it succeeds without resolving or invoking Prettier
- **AND** it does not rewrite the manifest or any delivered file

#### Scenario: Manifest or delivery state is missing or drifted

- **WHEN** the manifest is missing, renamed, malformed, stale, or inconsistent with any required target, digest, path, mirror, or closure
- **THEN** hook validation and pull-request regeneration fail closed

#### Scenario: Generated asset exposes forbidden authority

- **GIVEN** any delivered asset invokes OpenSpec apply, update, sync, archive, bulk-archive, or store behavior, whether bare or executable-prefixed
- **OR** it invokes an external store, Spectra, an unreviewed slash command, a tool-wide OpenSpec permission, or an incompatible tool primitive
- **WHEN** generated-asset verification runs
- **THEN** verification fails for that delivery target
- **AND** the asset cannot satisfy repository CI

#### Scenario: Generated final is formatted after delivery

- **WHEN** any tool rewrites a delivered generated file after generation
- **THEN** its final-byte digest no longer matches the reviewed manifest
- **AND** the read-only asset check fails rather than accepting or repairing it

## REMOVED Requirements

### Requirement: Planning-Only Codex Interface

**Reason**: The Codex-only contract is superseded by a tool-plural OpenSpec asset contract with explicit formatter independence and fail-closed delivery validation.

**Migration**: Use `pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>>`; Codex remains a supported delivery target and the installer option remains Codex-specific.
