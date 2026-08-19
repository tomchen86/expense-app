import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type EngineProjectionTransition =
  'archive' | 'completion' | 'issue' | 'plan' | 'rollback-completion';

export type EngineProjectionDefinition = {
  path: string;
  transitions: EngineProjectionTransition[];
};

export type ProjectionPathClassification = {
  taskPaths: string[];
  taskProjectionPaths: string[];
  engineProjectionPaths: string[];
  changedPaths: string[];
};

const REGISTRY: readonly Readonly<{
  path: string;
  transitions: readonly EngineProjectionTransition[];
}>[] = Object.freeze([
  Object.freeze({
    path: 'docs/CURRENT_AND_NEXT_STEPS.md',
    transitions: Object.freeze([
      'archive',
      'completion',
      'issue',
      'plan',
      'rollback-completion',
    ] satisfies EngineProjectionTransition[]),
  }),
]);

/**
 * Returns a copy of the reviewed, engine-owned projection registry. Repository
 * policy may enable an entry but cannot add another output path or transition.
 */
export function engineProjectionDefinitions(): EngineProjectionDefinition[] {
  return REGISTRY.map((definition) => ({
    path: definition.path,
    transitions: [...definition.transitions],
  }));
}

export function engineProjectionPathsForTransition(
  transition: EngineProjectionTransition,
): string[] {
  return REGISTRY.filter(({ transitions }) =>
    transitions.includes(transition),
  ).map(({ path }) => path);
}

export function classifyProjectionPaths(
  changedPaths: string[],
  taskProjectionPaths: string[],
  engineProjectionPaths: string[],
): ProjectionPathClassification {
  const changed = sortedUnique(changedPaths);
  const taskProjections = sortedUnique(taskProjectionPaths);
  const engineProjections = sortedUnique(engineProjectionPaths);
  if (
    changed.length !== changedPaths.length ||
    taskProjections.length !== taskProjectionPaths.length ||
    engineProjections.length !== engineProjectionPaths.length ||
    taskProjections.some(
      (projectionPath) => !changed.includes(projectionPath),
    ) ||
    engineProjections.some(
      (projectionPath) =>
        !changed.includes(projectionPath) ||
        taskProjections.includes(projectionPath),
    )
  ) {
    throw workflowError(
      'PROJECTION_PATH_CLASSIFICATION_INVALID',
      'Projection path categories must be disjoint subsets of the exact changed paths.',
      ExitCode.verification,
    );
  }
  const projections = new Set([...taskProjections, ...engineProjections]);
  return {
    taskPaths: changed.filter((changedPath) => !projections.has(changedPath)),
    taskProjectionPaths: taskProjections,
    engineProjectionPaths: engineProjections,
    changedPaths: changed,
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
