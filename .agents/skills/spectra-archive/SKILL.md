---
name: spectra-archive
description: 'Archive a completed change'
license: MIT
compatibility: Requires spectra CLI and git.
metadata:
  author: spectra
  version: '1.0'
  generatedBy: 'Spectra'
---

Archive a completed change.

**Input**: Optionally specify a change name after `$spectra-archive` (e.g., `$spectra-archive add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Prerequisites**: This skill requires the `spectra` CLI and `git`. If either command is unavailable, report the error and STOP.

**Steps**

1. **If no change name provided, prompt for selection**

   Run `spectra list --json` to get available changes. Use the **AskUserQuestion tool** to let the user select.

   Show only active changes (not already archived).
   Include the schema used for each change if available.

   **IMPORTANT**: Do NOT guess or auto-select a change. Always let the user choose.

   Validate that the selected name matches `^[a-z0-9][a-z0-9-]*$`. If it does not, STOP; never interpolate an unvalidated name into a path or shell command.

2. **Check artifact completion status**

   Run `spectra status --change "<name>" --json` to check artifact completion.

   Parse the JSON to understand:
   - `schemaName`: The workflow being used
   - `artifacts`: List of artifacts with their status (`done` or other)

   **If any artifacts are not `done`:**
   - Display the incomplete artifacts and STOP
   - Direct the user to `$spectra-propose` or `$spectra-ingest` to complete/reconcile artifacts

3. **Check task completion status**

   Read the tasks file (typically `tasks.md`) to check for incomplete tasks.

   Count tasks marked with `- [ ]` (incomplete) vs `- [x]` (complete).

   **If incomplete tasks found:**
   - Display the incomplete tasks and STOP
   - Direct the user to `$spectra-apply` to finish and verify them

   **If no tasks file exists:** Proceed without task-related warning.

4. **Assess delta spec application**

   Check for delta specs at `openspec/changes/<name>/specs/`. If none exist, proceed without a spec prompt.

   **If delta specs exist:**
   - Compare each delta spec with its corresponding main spec at `openspec/specs/<capability>/spec.md`
   - Determine what changes would be applied (adds, modifications, removals, renames)
   - Show a combined summary before archiving

   Build the exact canonical-spec target list from the delta-spec capability directories. Run `git status --porcelain --untracked-files=all -- <target-paths>` before archiving. If any target is already dirty or staged, show it and STOP; separate that work first so archive-generated spec changes remain attributable. Cache the current `git rev-parse HEAD` value.

   `spectra archive` applies delta specs to main specs by default. There is no separate `spectra sync` command in Spectra 2.3.1.

   Only use `--skip-specs` when the user explicitly confirms this is a tooling/documentation-only change whose delta specs must not be applied.

5. **Confirm and perform the archive**

   Show the exact move and mutation plan:

   - `openspec/changes/<name>/` → `openspec/changes/archive/YYYY-MM-DD-<name>/`
   - Canonical spec paths that will be updated, or "none"
   - Whether delta-spec application will be skipped

   Ask for explicit confirmation to perform this move. If no interactive question tool is available, ask in plain text and wait. Do not treat an inferred/provided name alone as permission to rename the change directory.

   Use the `spectra archive` CLI command which handles the full archive workflow
   (spec snapshot, delta application, @trace injection, identity recording, vector indexing):

   ```bash
   spectra archive <name> --yes
   ```

   **Optional flags:**
   - `--skip-specs` — skip delta spec application (for tooling/doc-only changes)

   Do not use `--mark-tasks-complete` to convert unchecked work into claimed completion, and do not use `--no-validate` in this workflow.

   **If archive fails** with "already exists" error, suggest renaming existing archive.

   After a successful archive, write `.spectra/archive-baseline/<name>.json` in this exact shape:

   ```json
   {
     "change": "<name>",
     "archive_path": "openspec/changes/archive/YYYY-MM-DD-<name>",
     "head_before_archive": "<full-commit-hash>",
     "specs_skipped": false,
     "canonical_spec_paths": ["openspec/specs/<capability>/spec.md"],
     "canonical_specs_clean_before_archive": true,
     "canonical_spec_sha256": {
       "openspec/specs/<capability>/spec.md": "<post-archive-sha256>"
     }
   }
   ```

   Use the exact archive path reported by the CLI, the cached pre-archive HEAD, and SHA-256 hashes computed immediately after archive. When specs were skipped, set `specs_skipped: true` and use an empty canonical-spec list/hash map. This ignored local manifest lets a later `$spectra-commit` attribute archive-generated spec changes safely. If the manifest cannot be written, report the error and do not proceed to commit.

6. **Display summary**

   Show archive completion summary including:
   - Change name
   - Schema that was used
   - Archive location
   - Spec sync status (synced / sync skipped / no delta specs)
   - Any spec-application warning
   - Local archive-baseline manifest path for the later scoped commit

**Output On Success**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** openspec/changes/archive/YYYY-MM-DD-<name>/
**Specs:** ✓ Synced to main specs

All artifacts complete. All tasks complete.
```

**Output On Success (No Delta Specs)**

```
## Archive Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** openspec/changes/archive/YYYY-MM-DD-<name>/
**Specs:** No delta specs

All artifacts complete. All tasks complete.
```

**Output On Success With Spec Warning**

```
## Archive Complete (with warnings)

**Change:** <change-name>
**Schema:** <schema-name>
**Archived to:** openspec/changes/archive/YYYY-MM-DD-<name>/
**Specs:** Sync skipped (user chose to skip)

**Warning:**
- Delta spec application was skipped after explicit user confirmation

Review the archive if this was not intentional.
```

**Output On Error (Archive Exists)**

```
## Archive Failed

**Change:** <change-name>
**Target:** openspec/changes/archive/YYYY-MM-DD-<name>/

Target archive directory already exists.

**Options:**
1. Rename the existing archive
2. Delete the existing archive if it's a duplicate
3. Wait until a different date to archive
```

**Guardrails**

- Always prompt for change selection if not provided
- Always get explicit confirmation immediately before moving the active change into the archive
- Use artifact graph (spectra status --json) for completion checking
- Block archive when required artifacts or tasks are incomplete; archiving must not fabricate completion
- Preserve .openspec.yaml when moving to archive (it moves with the directory)
- Show clear summary of what happened
- If delta specs exist, always show the application summary before archiving
- Rely on `spectra archive` for delta application; do not call nonexistent sync helpers
- Spectra 2.3.1 may retain `.spectra/touched/<change-name>.json` so an archive-first commit can still identify source files. Report that ignored local file after the commit, and do not delete it without explicit maintainer approval
- Keep `.spectra/archive-baseline/<change-name>.json` until the corresponding scoped commit succeeds
- If **AskUserQuestion tool** is not available, ask the same questions as plain text and wait for the user's response
