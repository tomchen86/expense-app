# Roadmap

_Last verified: July 14, 2026_

This document owns project priority. Detailed implementation tasks belong only
in the linked OpenSpec change.

## Now

### Establish executable AI workflow assurance

- Make OpenSpec specs and changes the only normative requirement and active
  planning/task artifacts.
- Keep Spectra installed but outside the workflow.
- Add a repository-owned CLI for Git, branch, clean-baseline, task-policy,
  session-lock, and diff-scope checks.
- Establish canonical documentation entry points without deleting legacy files.

Active change:
`openspec/changes/establish-executable-ai-workflow/`

## Next

1. Add check execution, disposable API database protection, immutable reports,
   and evidence-authorized task completion.
2. Seed structured issue data and implement the Document Gateway so
   `ISSUE_LOG.md` cannot be arbitrarily rewritten.
3. Audit `REQUIREMENT_LOG.md` into capability-based OpenSpec specs before
   downgrading the old file to legacy.
4. Re-audit product implementation and tests, then rebuild the product roadmap
   from verified repository evidence rather than the conflicting 2025 plans.

## Later

- Add Git hook delegation and authoritative CI verification.
- Add controlled document refresh proposals for architecture and feature docs.
- Create the reviewed `docs/WORKFLOW.md` and only then supersede
  `UPDATE_CHECKLIST.md`.
- Evaluate a controlled AI adapter and stronger filesystem sandboxing after the
  local policy engine is stable.

## Legacy Roadmap

`docs/planning/ROADMAP.md` is retained as a 2025 historical planning snapshot.
It contains known stale product-state claims and is not a current source of
truth.
