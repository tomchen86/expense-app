## Context

`git ls-files --others --ignored` may return an ignored nested repository as a NUL-delimited directory record ending in `/`. `listRepositoryIgnoredPaths` currently maps every record directly through `normalizeChangedPath`, whose trust contract intentionally rejects trailing slashes and other noncanonical repository paths. The downstream ignored-entry fingerprinter already handles directories with `lstat`, so the failure is an adapter mismatch rather than a missing directory capability.

Raw Git output is an external trust boundary. The engine must decode Git-specific record syntax before admitting a canonical repository-relative path, while `normalizeChangedPath` remains the shared fail-closed authority for absolute paths, traversal, `.git` segments, control characters, backslashes, empty segments, and trailing slashes.

## Goals / Non-Goals

**Goals:**

- Accept Git's single trailing directory marker for ignored-path records.
- Preserve one canonical internal representation for each repository path.
- Keep ignored directory presence and identity represented in working-state fingerprints.
- Capture RED-first evidence for the real nested-repository case and the unchanged strict path contract.

**Non-Goals:**

- Relaxing or transforming generic changed paths, policy paths, or planning paths.
- Changing `/memo/` ignore policy or maintainer-local nested-repository state.
- Recursively reading or hashing private contents inside an ignored nested repository.
- Generalizing unrelated Git command adapters or changing fingerprint framing.

## Decisions

### Decode the marker only in the ignored-path Git adapter

Add a private adapter beside `listRepositoryIgnoredPaths`. When a raw ignored record ends in `/`, it removes exactly that final character and passes the result to `normalizeChangedPath`; records without the marker go directly to the same validator.

This keeps Git transport syntax outside the canonical path model. Removing only one character also preserves fail-closed behavior: `/` becomes empty, `memo//` still ends in `/` after one removal, and traversal, absolute, control-character, backslash, and `.git` inputs remain invalid.

Globally accepting trailing slashes was rejected because every path consumer would then have two string identities for one filesystem entry. Globally trimming them was rejected because it would silently accept malformed inputs from planning, policy, diff, and document-refresh boundaries that do not emit Git directory markers.

### Preserve existing directory fingerprint semantics

The canonical path continues through the existing ignored-entry loop. The digest frames the canonical ignored path and the existing `lstat` metadata plus entry kind. No nested-repository content traversal is added. This is sufficient to distinguish removal or rename because the ignored-path set and framed path identity change.

Discarding directory records was rejected because it would let an ignored directory disappear or move without that identity participating in the fingerprint.

### Prove the boundary at contract and integration levels

The RED phase creates an ignored nested Git repository in a disposable fixture and demonstrates the current fingerprint/validation failure. The regression then proves successful validation and different fingerprints after a directory rename. A path-contract assertion separately preserves rejection of direct `normalizeChangedPath('memo/')` input.

The registered `workflow-tests`, `workflow-typecheck`, `workflow-lint`, and `workflow-format` checks provide task evidence. No database check is needed because this change touches only the workflow engine and disposable filesystem fixtures.

## Risks / Trade-offs

- **[Risk] The adapter could over-normalize malformed Git output** → Remove exactly one final `/`, then rely on the unchanged strict validator.
- **[Risk] The regression could accidentally depend on the developer's real `memo/`** → Construct and remove the nested repository only inside an isolated fixture.
- **[Risk] Readers may infer nested contents are recursively protected** → Keep recursive content hashing explicitly out of scope and assert only directory path/identity transitions.
- **[Trade-off] One source-specific adapter duplicates a small normalization step** → The duplication makes the trust boundary explicit and avoids widening every repository-path caller.

## Migration Plan

1. Commit this prerequisite plan from a clean linked worktree.
2. Start its single managed task and capture the failing regression before production edits.
3. Add the adapter, run registered checks, and create the managed task commit.
4. Merge the prerequisite to the configured base, then rerun T1.5 planning validation and plan commit in its original worktree.

Rollback is the ordinary revert of the prerequisite task and planning transition; there is no data migration or maintainer-local state change.

## Open Questions

None.
