import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { normalizeChangedPath } from "../../runtime/session-workspace/paths.js";
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export function planningProviderBindingPath(changeId) {
    if (!CHANGE_ID.test(changeId) || changeId === 'archive') {
        throw workflowError('PLANNING_CHANGE_ID_INVALID', 'Planning-provider binding requires one valid non-reserved change ID.', ExitCode.guard);
    }
    return `workflow/change-providers/${changeId}.json`;
}
export function assertPlanningPaths(changeRoot, changeId, changedPaths, deletedPaths = [], schemaName = 'expense-app') {
    if (changeId === 'archive') {
        throw workflowError('PLANNING_CHANGE_ID_RESERVED', 'The OpenSpec archive container cannot be used as an active change ID.', ExitCode.guard);
    }
    const prefix = `${changeRoot}/${changeId}/`;
    const exact = new Set([
        ...requiredPlanningArtifactPaths(changeRoot, changeId, schemaName),
        planningProviderBindingPath(changeId),
    ]);
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
        return (segments.length < 2 ||
            segments.at(-1) !== 'spec.md' ||
            segments
                .slice(0, -1)
                .some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment)));
    });
    if (invalid.length > 0) {
        throw workflowError('PLANNING_PATHS_INVALID', `Planning transition contains paths outside the named ${schemaName} planning tree.`, ExitCode.guard, { details: { invalidPaths: invalid.sort() } });
    }
}
export function requiredPlanningArtifactPaths(changeRoot, changeId, schemaName = 'expense-app') {
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
