import type { ManagedSchemaName } from '../../contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeChangedPath } from '../../paths.ts';

export function assertPlanningPaths(
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
  deletedPaths: readonly string[] = [],
  schemaName: ManagedSchemaName = 'expense-app',
): void {
  if (changeId === 'archive') {
    throw workflowError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
      ExitCode.guard,
    );
  }
  const prefix = `${changeRoot}/${changeId}/`;
  const exact = new Set(
    requiredPlanningArtifactPaths(changeRoot, changeId, schemaName),
  );
  const deleted = new Set(deletedPaths.map(normalizeChangedPath));
  const invalid = changedPaths.filter((candidate) => {
    const normalized = normalizeChangedPath(candidate);
    if (exact.has(normalized)) {
      return false;
    }
    if (deleted.has(normalized) && normalized.startsWith(prefix)) {
      return false;
    }
    if (!normalized.startsWith(`${prefix}specs/`)) {
      return true;
    }
    const relative = normalized.slice(`${prefix}specs/`.length);
    const segments = relative.split('/');
    return (
      segments.length < 2 ||
      segments.at(-1) !== 'spec.md' ||
      segments
        .slice(0, -1)
        .some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))
    );
  });
  if (invalid.length > 0) {
    throw workflowError(
      'PLANNING_PATHS_INVALID',
      `Planning transition contains paths outside the named ${schemaName} planning tree.`,
      ExitCode.guard,
      { details: { invalidPaths: invalid.sort() } },
    );
  }
}

export function requiredPlanningArtifactPaths(
  changeRoot: string,
  changeId: string,
  schemaName: ManagedSchemaName = 'expense-app',
): string[] {
  const prefix = `${changeRoot}/${changeId}/`;
  return [
    '.openspec.yaml',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    ...(schemaName === 'expense-app-v2'
      ? ['investigation.json', 'execution.json', 'plan-review.json']
      : []),
  ]
    .map((entry) => `${prefix}${entry}`)
    .sort();
}
