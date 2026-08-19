import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from './foundation/errors/errors.js';
const CHANGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_PATTERN = /^\d+(?:\.\d+)+$/;
const SESSION_ID_PATTERN = /^session-[a-zA-Z0-9-]+$/;
const INVESTIGATION_ID_PATTERN = /^investigation-[a-zA-Z0-9-]+$/;
const INVOCATION_ID_PATTERN = /^invocation-[a-zA-Z0-9-]+$/;
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const UNSUPPORTED_GLOB_PATTERN = /[*?[\]{}!]/;
/**
 * Resolve the investigation runtime layout beneath the configured Git-common
 * runtime root: content-addressed objects, current refs, sessions, and
 * invocations. The Git-common root is canonicalized so platform aliases (for
 * example macOS `/var` → `/private/var`) do not later force symlink-safety
 * false positives; `base` is the trusted directory below which every runtime
 * path component must be created no-follow.
 */
export function investigationRuntimePaths(gitCommonDirectory, runtimeDirectory) {
    const base = fs.realpathSync(path.resolve(gitCommonDirectory));
    const root = path.join(base, runtimeDirectory, 'investigations');
    return {
        base,
        root,
        objects: path.join(root, 'objects', 'sha256'),
        refs: path.join(root, 'refs'),
        sessions: path.join(root, 'sessions'),
        invocations: path.join(root, 'invocations'),
        locks: path.join(root, 'locks'),
    };
}
export function assertChangeId(value) {
    if (!CHANGE_ID_PATTERN.test(value)) {
        throw workflowError('INVALID_CHANGE_ID', `Invalid change ID: ${value}`, ExitCode.usage, {
            recovery: 'Use lower-case kebab-case, for example add-expense-export.',
        });
    }
    return value;
}
export function assertTaskId(value) {
    if (!TASK_ID_PATTERN.test(value)) {
        throw workflowError('INVALID_TASK_ID', `Invalid task ID: ${value}`, ExitCode.usage, { recovery: 'Use a dotted numeric task ID, for example 1.1.' });
    }
    return value;
}
export function assertSessionId(value) {
    if (!SESSION_ID_PATTERN.test(value)) {
        throw workflowError('INVALID_SESSION_ID', `Invalid session ID: ${value}`, ExitCode.usage);
    }
    return value;
}
export function assertInvestigationId(value) {
    if (!INVESTIGATION_ID_PATTERN.test(value)) {
        throw workflowError('INVALID_INVESTIGATION_ID', `Invalid investigation ID: ${value}`, ExitCode.usage);
    }
    return value;
}
export function assertInvocationId(value) {
    if (!INVOCATION_ID_PATTERN.test(value)) {
        throw workflowError('INVALID_INVOCATION_ID', `Invalid provider invocation ID: ${value}`, ExitCode.usage);
    }
    return value;
}
export function normalizePolicyPath(value) {
    if (!value ||
        value.trim() !== value ||
        value.includes('\\') ||
        containsControlCharacter(value)) {
        throw invalidPolicyPath(value);
    }
    const isPrefix = value.endsWith('/**');
    const candidate = isPrefix ? value.slice(0, -3) : value;
    if (!candidate ||
        candidate.normalize('NFC') !== candidate ||
        path.posix.isAbsolute(candidate) ||
        WINDOWS_ABSOLUTE_PATTERN.test(candidate) ||
        candidate.startsWith('./') ||
        candidate.endsWith('/') ||
        UNSUPPORTED_GLOB_PATTERN.test(candidate)) {
        throw invalidPolicyPath(value);
    }
    const segments = candidate.split('/');
    if (segments.some((segment) => !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git')) {
        throw invalidPolicyPath(value);
    }
    return isPrefix ? `${candidate}/**` : candidate;
}
export function normalizeChangedPath(value) {
    if (!value ||
        value.includes('\\') ||
        containsControlCharacter(value) ||
        path.posix.isAbsolute(value) ||
        WINDOWS_ABSOLUTE_PATTERN.test(value) ||
        value.startsWith('./') ||
        value.endsWith('/')) {
        throw invalidRepositoryPath(value);
    }
    const segments = value.split('/');
    if (segments.some((segment) => !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git')) {
        throw invalidRepositoryPath(value);
    }
    return value;
}
export function normalizeExactRepositoryPath(value) {
    const normalized = normalizeChangedPath(value);
    if (UNSUPPORTED_GLOB_PATTERN.test(normalized) ||
        normalized.normalize('NFC') !== normalized) {
        throw invalidRepositoryPath(value);
    }
    return normalized;
}
function containsControlCharacter(value) {
    return [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    });
}
export function matchesAllowedPath(changedPath, allowedPath) {
    const changed = normalizeChangedPath(changedPath);
    const allowed = normalizePolicyPath(allowedPath);
    if (!allowed.endsWith('/**')) {
        return changed === allowed;
    }
    const base = allowed.slice(0, -3);
    return changed === base || changed.startsWith(`${base}/`);
}
export function assertPolicyPathInsideRepository(repositoryRoot, policyPath) {
    const normalized = normalizePolicyPath(policyPath);
    const relative = normalized.endsWith('/**')
        ? normalized.slice(0, -3)
        : normalized;
    const repositoryRealPath = fs.realpathSync(repositoryRoot);
    const targetPath = path.resolve(repositoryRealPath, relative);
    assertInside(repositoryRealPath, targetPath, policyPath);
    assertNoSymlinkSegments(repositoryRealPath, relative, policyPath);
}
function assertNoSymlinkSegments(repositoryRoot, relativePath, policyPath) {
    let currentPath = repositoryRoot;
    for (const segment of relativePath.split('/')) {
        currentPath = path.join(currentPath, segment);
        const stats = fs.lstatSync(currentPath, { throwIfNoEntry: false });
        if (!stats) {
            return;
        }
        if (stats.isSymbolicLink()) {
            let resolvedPath;
            try {
                resolvedPath = fs.realpathSync(currentPath);
            }
            catch {
                throw invalidPolicySymlink(repositoryRoot, currentPath, policyPath);
            }
            assertInside(repositoryRoot, resolvedPath, policyPath);
            throw invalidPolicySymlink(repositoryRoot, currentPath, policyPath);
        }
        if (!stats.isDirectory()) {
            return;
        }
    }
}
function assertInside(repositoryRoot, targetPath, policyPath) {
    const relative = path.relative(repositoryRoot, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw workflowError('PATH_ESCAPES_REPOSITORY', `Policy path escapes the repository: ${policyPath}`, ExitCode.guard, { details: { policyPath } });
    }
}
function invalidPolicyPath(value) {
    return workflowError('INVALID_POLICY_PATH', `Invalid policy path: ${value}`, ExitCode.guard, {
        details: { path: value },
        recovery: 'Use a repository-relative exact path or a directory prefix ending in /**.',
    });
}
function invalidPolicySymlink(repositoryRoot, symlinkPath, policyPath) {
    return workflowError('SYMLINK_POLICY_PATH', `Policy path crosses a symbolic link: ${policyPath}`, ExitCode.guard, {
        details: {
            policyPath,
            symlinkPath: path.relative(repositoryRoot, symlinkPath),
        },
        recovery: 'Use a direct repository path without symbolic-link aliases.',
    });
}
function invalidRepositoryPath(value) {
    return workflowError('INVALID_REPOSITORY_PATH', `Invalid repository path reported by Git: ${value}`, ExitCode.guard, { details: { path: value } });
}
