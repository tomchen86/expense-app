import { ExitCode, workflowError } from './errors.ts';
import { normalizeChangedPath } from './paths.ts';

export function assertPlanningPaths(
  changeRoot: string,
  changeId: string,
  changedPaths: string[],
): void {
  if (changeId === 'archive') {
    throw workflowError(
      'PLANNING_CHANGE_ID_RESERVED',
      'The OpenSpec archive container cannot be used as an active change ID.',
      ExitCode.guard,
    );
  }
  const prefix = `${changeRoot}/${changeId}/`;
  const exact = new Set([
    `${prefix}.openspec.yaml`,
    `${prefix}proposal.md`,
    `${prefix}design.md`,
    `${prefix}tasks.md`,
    `${prefix}guard.json`,
  ]);
  const invalid = changedPaths.filter((candidate) => {
    const normalized = normalizeChangedPath(candidate);
    if (exact.has(normalized)) {
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
      'Planning transition contains paths outside the named planning tree.',
      ExitCode.guard,
      { details: { invalidPaths: invalid.sort() } },
    );
  }
}
