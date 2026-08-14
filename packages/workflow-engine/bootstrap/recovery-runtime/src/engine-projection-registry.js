import { ExitCode, workflowError } from './errors.js';
const REGISTRY = Object.freeze([
    Object.freeze({
        path: 'docs/CURRENT_AND_NEXT_STEPS.md',
        transitions: Object.freeze([
            'archive',
            'completion',
            'issue',
            'plan',
            'rollback-completion',
        ]),
    }),
]);
/**
 * Returns a copy of the reviewed, engine-owned projection registry. Repository
 * policy may enable an entry but cannot add another output path or transition.
 */
export function engineProjectionDefinitions() {
    return REGISTRY.map((definition) => ({
        path: definition.path,
        transitions: [...definition.transitions],
    }));
}
export function engineProjectionPathsForTransition(transition) {
    return REGISTRY.filter(({ transitions }) => transitions.includes(transition)).map(({ path }) => path);
}
export function classifyProjectionPaths(changedPaths, taskProjectionPaths, engineProjectionPaths) {
    const changed = sortedUnique(changedPaths);
    const taskProjections = sortedUnique(taskProjectionPaths);
    const engineProjections = sortedUnique(engineProjectionPaths);
    if (changed.length !== changedPaths.length ||
        taskProjections.length !== taskProjectionPaths.length ||
        engineProjections.length !== engineProjectionPaths.length ||
        taskProjections.some((projectionPath) => !changed.includes(projectionPath)) ||
        engineProjections.some((projectionPath) => !changed.includes(projectionPath) ||
            taskProjections.includes(projectionPath))) {
        throw workflowError('PROJECTION_PATH_CLASSIFICATION_INVALID', 'Projection path categories must be disjoint subsets of the exact changed paths.', ExitCode.verification);
    }
    const projections = new Set([...taskProjections, ...engineProjections]);
    return {
        taskPaths: changed.filter((changedPath) => !projections.has(changedPath)),
        taskProjectionPaths: taskProjections,
        engineProjectionPaths: engineProjections,
        changedPaths: changed,
    };
}
function sortedUnique(values) {
    return [...new Set(values)].sort();
}
