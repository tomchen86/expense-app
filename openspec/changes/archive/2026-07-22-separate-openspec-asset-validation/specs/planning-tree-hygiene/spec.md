## ADDED Requirements

### Requirement: Generated OpenSpec Asset Format Scope Is Exact

The workflow-format contract assertion SHALL accept only the registered command that explicitly covers the reviewed human-maintained workflow paths and excludes the generated OpenSpec asset home. It MUST reject the former broad workflow-directory form and every other command.

#### Scenario: Asset-separated format scope is active

- **WHEN** the post-authority repository contract validates `workflow-format`
- **THEN** the exact asset-separated command passes
- **AND** generated OpenSpec assets remain outside formatting ownership

#### Scenario: Broad or otherwise drifted format scope returns

- **WHEN** `workflow-format` names the broad workflow directory, omits a required human-maintained path, includes the generated asset home, or otherwise changes
- **THEN** the repository contract fails

## REMOVED Requirements

### Requirement: Bootstrap format scope retirement is transition-tolerant

**Reason**: The archived-bootstrap transition is complete, and retaining its dual-form window would weaken the exact new format/asset ownership boundary.

**Migration**: Before the signed asset-scope authority edit, an ordinary regression temporarily recognizes only the current and proposed commands; after the edit is merged, the activation task changes the permanent contract to the new form only.
