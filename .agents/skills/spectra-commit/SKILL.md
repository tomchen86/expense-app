---
name: spectra-commit
description: 'Commit files related to a specific Spectra change'
license: MIT
compatibility: Requires spectra CLI and git.
metadata:
  author: spectra
  version: '1.0'
  generatedBy: 'Spectra'
---

Commit files related to a specific Spectra change.

This is a **utility skill** (not a workflow step). It reads source file tracking data and artifact changes to stage and commit only the files belonging to one change — useful when multiple changes are in progress simultaneously.

**Input**: Optionally specify a change name after `$spectra-commit` (e.g., `$spectra-commit add-auth`). If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Prerequisites**: This skill requires `git` and the `spectra` CLI. Run `git --version` and `spectra --version`. If either is unavailable, report the error and STOP.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `spectra list --json` to get available changes. Use the **AskUserQuestion tool** to let the user select

   Always announce: "Committing for change: <name>"

   Validate that the name matches `^[a-z0-9][a-z0-9-]*$`. If it does not, STOP; never interpolate an unvalidated name into a path or shell command.

   Resolve the artifact state:
   - If `openspec/changes/<name>/` exists, this is an active change.
   - Otherwise, find exact matches at `openspec/changes/archive/*-<name>/`. If exactly one dirty archived path matches, use it. If several match, show them and ask the user to select the exact archive path. If none match, STOP.

   Run `git diff --cached --name-only`. If the index already contains any staged file, show the list and STOP. Do not alter the existing index; ask the user to commit or unstage that separate work first.

2. **Read tracking file**

   Check for `.spectra/touched/<change-name>.json`. If it exists, parse it to get source files grouped by task.

   Expected format:

   ```json
   {
     "change": "<change-name>",
     "touched": [
       {
         "task_id": "1",
         "task_desc": "Task description",
         "files": ["src/file1.ts", "src/file2.ts"]
       }
     ]
   }
   ```

   If the file does not exist, proceed without source file data — only artifact files will be included.

3. **Collect and attribute artifact files**

   Run `git status --porcelain --untracked-files=all` and build the artifact set for the resolved state:

   - Active change: dirty files under `openspec/changes/<name>/`
   - Already archived change: dirty files under the exact selected archive path plus deletions under `openspec/changes/<name>/`

   Check `.spectra/archive-baseline/<name>.json`. If it exists, require all of these checks:

   - `change` matches the validated name and `archive_path` matches the exact selected archive
   - `canonical_specs_clean_before_archive` is exactly `true`
   - `head_before_archive` equals the current `git rev-parse HEAD`
   - when `specs_skipped` is `false`, `canonical_spec_paths` exactly matches paths derived from the selected archive's `specs/*/spec.md` capability directories; when `true`, both the path list and hash map are empty
   - every path matches `openspec/specs/<capability>/spec.md`
   - each current canonical spec's SHA-256 equals its value in `canonical_spec_sha256`

   If any check fails, STOP. Include only dirty canonical-spec paths from a fully valid manifest.

   If an already archived change has dirty canonical specs but no valid baseline manifest, STOP. A post-hoc diff cannot prove which canonical-spec edits came from the archive versus earlier work.

   Before any optional archive, read and cache the proposal summary plus the completed/total task counts from the active or selected archived artifact root. Archive moves the active artifact paths, so later commit-message generation must use these cached values.

4. **Identify unrelated dirty files**

   From the full `git status --porcelain --untracked-files=all` output, any dirty files NOT in the artifact set, validated canonical-spec set, or tracking file are "unrelated changes."

5. **Display commit plan**

   Show the file list grouped into sections:

   ```
   ## Commit Plan: <change-name>

   ### Change Artifacts
   - M  openspec/changes/<name>/proposal.md
   - M  openspec/changes/<name>/tasks.md

   ### Canonical Spec Updates (only with a validated archive baseline)
   - M  openspec/specs/expenses/spec.md

   ### Source Files
   **Task 1: <task description>**
   - M  apps/api/src/services/expense.service.ts
   - A  apps/api/src/__tests__/integration/expense.spec.ts

   **Task 3: <task description>**
   - M  apps/mobile/src/store/features/expenseStore.ts

   ### Unrelated Changes (not included)
   - M  apps/api/src/services/category.service.ts
   - ??  tmp/scratch.js
   ```

   If no tracking file was found, show a warning instead of the Source Files section:

   ```
   ### Source Files
   ⚠ No source file tracking data found.
   Only artifact files will be committed. Use `spectra task done` during apply to enable source file tracking.
   ```

   If there are no artifact files, no validated canonical-spec files, AND no tracked source files, inform the user that there is nothing to commit and STOP.

   When local tracking/baseline files exist, add an explicit section listing the exact ignored files that will be removed only after a successful archived-change commit. This makes the subsequent confirmation cover the cleanup action.

6. **User confirmation**

   Use the **AskUserQuestion tool** to ask the user how to proceed.

   Options:
   - **Commit as shown**: Proceed with the displayed artifact, validated canonical-spec, and source files; for an archived change, also perform the displayed local cleanup after success
   - **Customize**: Add or remove specifically named files after confirming why each belongs to this change
   - **Archive first, then commit together** (active changes only): Run archive before committing, include attributed archive/spec changes, then perform the displayed local cleanup after a successful commit
   - **Cancel**: Stop without staging or committing

   If the user selects "Customize":
   - Show a numbered list of all dirty files (included and excluded)
   - Ask which files to add or remove
   - Re-display the updated commit plan for confirmation

   If the user selects "Archive first, then commit together":
   - This option is available only when the change is still active
   - Proceed to step 6a (Archive sub-flow) before continuing to step 7

6a. **Archive sub-flow** (only when the user selected "Archive first, then commit together")

    This sub-flow executes task handling and archive collection before returning to the main commit flow.

    **6a-i. Incomplete task handling**

    Read the tasks file at `openspec/changes/<name>/tasks.md`. Count `- [x]` (complete) and `- [ ]` (incomplete) checkboxes.

    - If **all tasks are complete**: skip to 6a-ii.
    - If **incomplete tasks exist**:
      - Display the list of incomplete tasks
      - STOP and direct the user to `$spectra-apply` to finish and verify them
      - Never use `--mark-tasks-complete` to turn unchecked work into claimed completion

    **6a-ii. Delta spec application**

    Check whether delta specs exist at `openspec/changes/<name>/specs/`.

    - If **no delta specs exist** (directory is empty or absent): continue to archive execution.
    - If **delta specs exist**:
      - Show a concise summary of the main-spec changes that archive will apply
      - Explain that `spectra archive` applies delta specs by default in Spectra 2.3.1
      - Use `--skip-specs` only if the user explicitly confirms that spec application should be skipped

    Build the exact canonical-spec target list from the delta-spec capability directories. Before archive, run `git status --porcelain --untracked-files=all -- <target-paths>`. If any target is already dirty or staged, show it and STOP; separate that work first so archive-generated spec edits remain attributable. Cache the current full HEAD commit hash.

    **6a-iii. Archive execution and file collection**

    Execute the archive:

    ```bash
    spectra archive <name> --yes              # normal archive; applies delta specs
    spectra archive <name> --yes --skip-specs # only after explicit user confirmation
    ```

    After archive completes successfully:

    1. Resolve the exact archive path reported by the CLI.
    2. Immediately compute the post-archive SHA-256 for every canonical-spec target and write `.spectra/archive-baseline/<name>.json` using the archive skill's exact schema, including the cached HEAD, `specs_skipped`, clean-before-archive flag, target paths, and hashes.
    3. Add only deletions under the old active path, files under the exact archive path, and dirty canonical specs in that recorded target list to the commit set. Do not sweep in every path changed after archive.
    4. Reclassify every other dirty file as unrelated and display an **updated commit plan** showing all sections:

    ```
    ## Updated Commit Plan: <change-name> (with archive)

    ### Change Artifacts (archived)
    - D  openspec/changes/<name>/proposal.md
    - D  openspec/changes/<name>/tasks.md
    - ...

    ### Archived Files
    - A  openspec/changes/archive/YYYY-MM-DD-<name>/proposal.md
    - A  openspec/changes/archive/YYYY-MM-DD-<name>/tasks.md
    - ...

    ### Source Files
    (same as before)

    ### Main Spec Updates (if delta specs were applied)
    - M  openspec/specs/<spec-name>/spec.md
    - ...
    ```

    Then continue to step 7.

7. **Generate commit message**

Use the proposal summary and task counts cached in step 3. Do not read the old active artifact paths after the archive sub-flow has moved them.

Generate a message in this format:

```
spectra(<change-name>): <summary>

Change: <change-name>
Tasks: <completed>/<total> complete
```

Rewrite `<summary>` as an imperative phrase (for example, `Add receipt upload support`) so the subject follows the repository's commit-message convention.

If the archive sub-flow was executed (user selected "Archive first, then commit together"), add `Archived: yes` to the message body:

```
spectra(<change-name>): <summary>

Change: <change-name>
Tasks: <completed>/<total> complete
Archived: yes
```

Task progress comes from reading the tasks file and counting `- [x]` vs `- [ ]` checkboxes.

Show the generated message to the user and allow editing before proceeding.

8. **Selective staging**

   Re-run `git diff --cached --name-only` immediately before staging. If the index is no longer empty, show the files and STOP without altering the index.

   For an archived change, re-run every archive-baseline validation from step 3 immediately before staging. This catches canonical specs edited after the archive plan was confirmed. STOP on any mismatch.

   Stage each confirmed file individually:

   ```bash
   git add <file1>
   git add <file2>
   ...
   ```

   **NEVER use `git add .` or `git add -A`.** Each file must be staged explicitly.

   Compare `git diff --cached --name-only` with the confirmed file set. If there is any missing or additional staged path, show the mismatch and STOP before committing.

9. **Commit**

   ```bash
   git commit -m "<message>"
   ```

10. **Show result**

    ```bash
    git log --oneline -1
    ```

Display the commit hash and message to confirm.

If an archived-change commit succeeded, delete only the exact `.spectra/touched/<validated-change-name>.json` and `.spectra/archive-baseline/<validated-change-name>.json` files that were listed in the confirmed plan. Never use a glob and never remove either parent directory. Report whether each local cleanup occurred.

**Output On Success**

```
## Committed: <change-name>

**Commit:** <short-hash> spectra(<change-name>): <summary>
**Files:** <N> files committed (<A> artifacts, <S> source files)
**Tasks:** <completed>/<total> complete
```

**Output On Nothing To Commit**

```
## Nothing to Commit

**Change:** <change-name>

No dirty files found for this change (no modified artifacts, no tracked source files).
```

**Guardrails**

- **NEVER use `git add .` or `git add -A`** — every file must be staged individually with `git add <file>`
- **NEVER commit with a pre-populated index** — stop rather than including another change's staged files
- **NEVER attribute canonical-spec changes without a clean pre-archive check and valid archive-baseline manifest**
- **NEVER commit files the user hasn't confirmed** — always show the file list and get explicit confirmation first
- **Always show the full file list before committing** — no silent staging
- If the tracking file is missing, warn but don't block — artifact-only commits are valid
- The "Unrelated Changes" section is informational only — these files are excluded by default
- If **AskUserQuestion tool** is not available, ask the same questions as plain text and wait for the user's response
