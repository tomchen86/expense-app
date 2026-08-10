import { ExitCode, workflowError } from './errors.ts';
import { runGit } from './git.ts';

/**
 * Read the single planning generation named by the committed PlanReview tree.
 * Runtime reports may be pruned; the immutable commit remains the authority.
 */
export function committedPlanningGeneration(
  repositoryRoot: string,
  commit: string,
  changeRoot: string,
  changeId: string,
): string | null {
  const committed = runGit(
    repositoryRoot,
    ['show', `${commit}:${changeRoot}/${changeId}/plan-review.json`],
    true,
  );
  if (committed.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(committed);
  } catch {
    return null;
  }
  const generations = new Set<string>();
  collectPlanningGenerations(parsed, generations);
  if (generations.size > 1) {
    throw workflowError(
      'AMENDMENT_GENERATION_AMBIGUOUS',
      'The committed review names more than one planning generation, so an amendment cannot say which one it replaces.',
      ExitCode.staleState,
    );
  }
  return [...generations][0] ?? null;
}

function collectPlanningGenerations(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanningGenerations(item, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    if (
      key === 'planningGenerationId' &&
      typeof nested === 'string' &&
      /^[0-9a-f]{64}$/.test(nested)
    ) {
      into.add(nested);
      continue;
    }
    collectPlanningGenerations(nested, into);
  }
}
