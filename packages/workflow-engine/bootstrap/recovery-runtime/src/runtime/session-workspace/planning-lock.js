import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { ensurePlainDirectory, publishPreparedExclusiveLock, reclaimDeadPreparedLock, } from '../repository-transaction/filesystem-safety.js';
import { assertHumanResolutionLifecycleBarrier } from '../storage-journal/investigation-session-store.js';
import { assertOwnedLock, listConflictingActiveWorkflowSessionIds, readSessionFile, releaseOwnedLock, withRepositoryLifecycleOperation, } from './session-store.js';
const HELD_CHANGE_TRANSITION_AUTHORITY = Symbol('held-change-transition-authority');
export function withPlanningAuthority(runtime, changeId, operation) {
    return withChangeTransitionAuthority(runtime, changeId, 'plan', operation);
}
/**
 * Open-task already owns the repository lifecycle lock while it moves from a
 * planning transition to an active task-session lock. Keeping that outer lock
 * held closes the otherwise unavoidable interval where another lifecycle
 * operation could observe the plan commit without its exact session. This
 * helper owns only the per-change transition lock and releases it before the
 * caller publishes the session lock.
 */
export function withOpenTaskPlanningAuthority(runtime, changeId, assertRepositoryLock, operation) {
    assertHumanResolutionLifecycleBarrier(runtime.root, null);
    assertRepositoryLock();
    reclaimDeadChangeTransitionLock(runtime, changeId, assertRepositoryLock);
    return withChangeTransitionLock(runtime, changeId, 'open-task', (assertChangeLock) => {
        assertNoActiveSessionsForChange(runtime, changeId);
        assertHumanResolutionBarrier(runtime, changeId, null);
        return operation(heldChangeTransitionAuthority(changeId, () => {
            assertRepositoryLock();
            assertChangeLock();
            assertHumanResolutionBarrier(runtime, changeId, null);
        }));
    });
}
/**
 * Turn the existing task-session change lock into a bounded planning
 * authority while that exact session is durably revising. The caller already
 * owns the repository and session lifecycle locks; this helper does not open a
 * second authority lane or release the task lock.
 */
export function withTaskRevisionPlanningAuthority(runtime, expectedSession, revisionLeaseId, assertRepositoryLock, operation) {
    assertHumanResolutionLifecycleBarrier(runtime.root, null);
    assertRepositoryLock();
    const current = readSessionFile(path.join(runtime.sessions, `${expectedSession.sessionId}.json`));
    if (JSON.stringify(current) !== JSON.stringify(expectedSession) ||
        current.state !== 'revising' ||
        current.revisionLeaseId !== revisionLeaseId) {
        throw workflowError('TASK_REVISION_AUTHORITY_STALE', 'Task revision planning authority is not bound to the exact revising session.', ExitCode.staleState);
    }
    const assertOwned = () => {
        assertRepositoryLock();
        const reread = readSessionFile(path.join(runtime.sessions, `${current.sessionId}.json`));
        if (JSON.stringify(reread) !== JSON.stringify(current)) {
            throw staleLock();
        }
        assertOwnedLock(path.join(runtime.locks, `${current.changeId}.lock`), current.sessionId, current.changeId, current.taskId);
        assertHumanResolutionBarrier(runtime, current.changeId, null);
    };
    assertOwned();
    return operation(heldChangeTransitionAuthority(current.changeId, assertOwned));
}
/**
 * Investigation creation shares the repository and per-change transition
 * locks with task, plan, and archive transitions. The callback must contain
 * only synchronous persistence/CAS work: provider execution and caller/human
 * waits happen after both locks have been released.
 */
export function withInvestigationTransitionAuthority(runtime, changeId, operation) {
    assertHumanResolutionLifecycleBarrier(runtime.root, null);
    return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
        reclaimDeadChangeTransitionLock(runtime, changeId, assertRepositoryLock);
        return withChangeTransitionLock(runtime, changeId, 'investigation', (assertChangeLock) => {
            assertNoActiveSessionsForChange(runtime, changeId);
            assertHumanResolutionBarrier(runtime, changeId, null);
            return operation(heldChangeTransitionAuthority(changeId, () => {
                assertRepositoryLock();
                assertChangeLock();
                assertHumanResolutionBarrier(runtime, changeId, null);
            }));
        });
    });
}
export function withHumanResolutionTransitionAuthority(runtime, changeId, activeGrantId, operation) {
    assertHumanResolutionLifecycleBarrier(runtime.root, activeGrantId, activeGrantId === null ? null : changeId);
    return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
        reclaimDeadChangeTransitionLock(runtime, changeId, assertRepositoryLock);
        return withChangeTransitionLock(runtime, changeId, 'human-resolution', (assertChangeLock) => {
            assertNoActiveSessionsForChange(runtime, changeId);
            assertHumanResolutionBarrier(runtime, changeId, activeGrantId);
            return operation(heldChangeTransitionAuthority(changeId, () => {
                assertRepositoryLock();
                assertChangeLock();
                assertHumanResolutionBarrier(runtime, changeId, activeGrantId);
            }));
        });
    }, {
        allowHumanResolutionGrantId: activeGrantId ?? undefined,
        allowHumanResolutionChangeId: activeGrantId === null ? undefined : changeId,
    });
}
/**
 * Grant Core already owns the repository lifecycle lease while it invokes a
 * registered transition. This helper adds only the exact per-change
 * human-resolution authority, avoiding a nested repository lock while
 * preserving the existing active-task and durable-journal barriers.
 */
export function withGrantHumanResolutionTransitionAuthority(runtime, changeId, activeGrantId, assertRepositoryLock, operation) {
    assertRepositoryLock();
    assertHumanResolutionLifecycleBarrier(runtime.root, activeGrantId, changeId);
    reclaimDeadChangeTransitionLock(runtime, changeId, assertRepositoryLock);
    return withChangeTransitionLock(runtime, changeId, 'human-resolution', (assertChangeLock) => {
        assertNoActiveSessionsForChange(runtime, changeId);
        assertHumanResolutionBarrier(runtime, changeId, activeGrantId);
        return operation(heldChangeTransitionAuthority(changeId, () => {
            assertRepositoryLock();
            assertChangeLock();
            assertHumanResolutionBarrier(runtime, changeId, activeGrantId);
        }));
    });
}
export function withChangeTransitionAuthority(runtime, changeId, transition, operation) {
    assertHumanResolutionLifecycleBarrier(runtime.root, null);
    return withRepositoryLifecycleOperation(runtime, (assertRepositoryLock) => {
        reclaimDeadChangeTransitionLock(runtime, changeId, assertRepositoryLock);
        return withChangeTransitionLock(runtime, changeId, transition, (assertChangeLock) => {
            assertNoActiveSessionsForChange(runtime, changeId);
            assertHumanResolutionBarrier(runtime, changeId, null);
            return operation(heldChangeTransitionAuthority(changeId, () => {
                assertRepositoryLock();
                assertChangeLock();
                assertHumanResolutionBarrier(runtime, changeId, null);
            }));
        });
    });
}
export function assertHeldChangeTransitionAuthority(authority, changeId) {
    if (typeof authority !== 'function' ||
        authority[HELD_CHANGE_TRANSITION_AUTHORITY] !== true ||
        authority.changeId !== changeId ||
        typeof authority.assertOwned !== 'function') {
        throw workflowError('INVESTIGATION_TRANSITION_UNBOUND', 'Held transition authority belongs to another change.', ExitCode.guard);
    }
    authority.assertOwned();
    return authority.assertOwned;
}
function heldChangeTransitionAuthority(changeId, assertOwned) {
    const authority = (() => assertOwned());
    Object.defineProperties(authority, {
        changeId: { value: changeId, enumerable: true },
        assertOwned: { value: authority, enumerable: true },
        [HELD_CHANGE_TRANSITION_AUTHORITY]: { value: true },
    });
    return Object.freeze(authority);
}
function withChangeTransitionLock(runtime, changeId, transition, operation) {
    ensurePlainDirectory(runtime.locks);
    const lockPath = path.join(runtime.locks, `${changeId}.lock`);
    const ownerToken = crypto.randomUUID();
    const operationId = `${transition}-${ownerToken}`;
    const content = `${JSON.stringify({
        operationId,
        ownerToken,
        changeId,
        transition,
        pid: process.pid,
    })}\n`;
    let descriptor;
    const assertOwned = () => {
        if (descriptor === undefined) {
            throw staleLock();
        }
        const owned = fs.fstatSync(descriptor);
        const stats = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        let observed;
        try {
            observed = fs.readFileSync(lockPath, 'utf8');
        }
        catch {
            observed = undefined;
        }
        if (!owned.isFile() ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            !stats?.isFile() ||
            stats.isSymbolicLink() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600 ||
            stats.dev !== owned.dev ||
            stats.ino !== owned.ino ||
            observed !== content) {
            throw staleLock();
        }
    };
    try {
        descriptor = publishPreparedExclusiveLock(lockPath, content, ownerToken, staleLock);
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
            descriptor = undefined;
        }
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw existingChangeLockError(lockPath, transition);
        }
        throw error;
    }
    const release = () => {
        try {
            assertOwned();
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            throw error;
        }
        if (descriptor === undefined) {
            throw staleLock();
        }
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
    };
    let result;
    try {
        result = operation(assertOwned);
    }
    catch (operationError) {
        try {
            release();
        }
        catch (releaseError) {
            throw new AggregateError([operationError, releaseError], 'Planning operation and change-lock release both failed.', { cause: releaseError });
        }
        throw operationError;
    }
    release();
    return result;
}
export function reclaimDeadChangeTransitionLock(runtime, changeId, assertRepositoryLifecycleOwned) {
    assertRepositoryLifecycleOwned();
    ensurePlainDirectory(runtime.locks);
    const lockPath = path.join(runtime.locks, `${changeId}.lock`);
    if (reclaimTerminalSessionLock(runtime, lockPath, changeId)) {
        assertRepositoryLifecycleOwned();
        return;
    }
    reclaimDeadTransitionLock(lockPath, (value, content) => {
        if (isRecord(value) &&
            hasExactKeys(value, [
                'operationId',
                'ownerToken',
                'changeId',
                'transition',
                'pid',
            ]) &&
            typeof value.operationId === 'string' &&
            typeof value.ownerToken === 'string' &&
            value.operationId === `${value.transition}-${value.ownerToken}` &&
            value.changeId === changeId &&
            (value.transition === 'plan' ||
                value.transition === 'archive' ||
                value.transition === 'investigation' ||
                value.transition === 'human-resolution' ||
                value.transition === 'open-task') &&
            Number.isSafeInteger(value.pid) &&
            `${JSON.stringify(value)}\n` === content) {
            return {
                pid: value.pid,
                ownerToken: value.ownerToken,
            };
        }
        if (isRecord(value) &&
            hasExactKeys(value, [
                'sessionId',
                'ownerToken',
                'changeId',
                'taskId',
                'pid',
            ]) &&
            typeof value.sessionId === 'string' &&
            typeof value.ownerToken === 'string' &&
            value.changeId === changeId &&
            typeof value.taskId === 'string' &&
            Number.isSafeInteger(value.pid) &&
            `${JSON.stringify(value)}\n` === content &&
            sessionLockMayBeReclaimed(runtime, value.sessionId, changeId, value.taskId)) {
            return {
                pid: value.pid,
                ownerToken: value.ownerToken,
            };
        }
        return null;
    });
    assertRepositoryLifecycleOwned();
}
function reclaimTerminalSessionLock(runtime, lockPath, changeId) {
    const stats = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600) {
        return false;
    }
    let value;
    let content;
    try {
        content = fs.readFileSync(lockPath, 'utf8');
        value = JSON.parse(content);
    }
    catch {
        return false;
    }
    if (!isRecord(value) ||
        typeof value.sessionId !== 'string' ||
        value.changeId !== changeId ||
        typeof value.taskId !== 'string' ||
        `${JSON.stringify(value)}\n` !== content) {
        return false;
    }
    const legacyMarker = hasExactKeys(value, ['sessionId', 'changeId', 'taskId']);
    const preparedMarker = hasExactKeys(value, [
        'sessionId',
        'ownerToken',
        'changeId',
        'taskId',
        'pid',
    ]) &&
        typeof value.ownerToken === 'string' &&
        Number.isSafeInteger(value.pid) &&
        value.pid >= 1;
    if ((!legacyMarker && !preparedMarker) ||
        !terminalSessionMatches(runtime, value.sessionId, changeId, value.taskId)) {
        return false;
    }
    releaseOwnedLock(lockPath, value.sessionId);
    return true;
}
function sessionLockMayBeReclaimed(runtime, sessionId, changeId, taskId) {
    const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
    const stats = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
    if (!stats) {
        return true;
    }
    return terminalSessionMatches(runtime, sessionId, changeId, taskId);
}
function terminalSessionMatches(runtime, sessionId, changeId, taskId) {
    const sessionPath = path.join(runtime.sessions, `${sessionId}.json`);
    const stats = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600) {
        return false;
    }
    try {
        const session = readSessionFile(sessionPath);
        return (session.sessionId === sessionId &&
            session.changeId === changeId &&
            session.taskId === taskId &&
            (session.state === 'aborted' || session.state === 'committed'));
    }
    catch {
        return false;
    }
}
function reclaimDeadTransitionLock(lockPath, readOwner) {
    reclaimDeadPreparedLock(lockPath, (content) => {
        let value;
        try {
            value = JSON.parse(content);
        }
        catch {
            return null;
        }
        return readOwner(value, content);
    });
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value);
    return (actual.length === keys.length &&
        keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)));
}
function assertNoActiveSessionsForChange(runtime, changeId) {
    // Plan/archive and managed task branches are derived from the required
    // {changeId} template; investigation and human-resolution state is likewise
    // keyed by changeId. The change identity therefore owns each exact target.
    const active = listConflictingActiveWorkflowSessionIds(runtime, {
        changeId,
    });
    if (active.length > 0) {
        throw workflowError('ACTIVE_SESSION_CONFLICT', `Change ${changeId} already has an active workflow session.`, ExitCode.conflict, { details: { activeSessionIds: active } });
    }
}
function assertHumanResolutionBarrier(runtime, changeId, allowedGrantId) {
    const activePath = path.join(runtime.root, 'investigations', 'human-resolutions', 'active', `${changeId}.json`);
    if (!fs.lstatSync(activePath, { throwIfNoEntry: false })) {
        return;
    }
    if (allowedGrantId !== null &&
        activeJournalBindsGrant(activePath, changeId, allowedGrantId)) {
        return;
    }
    throw workflowError('HUMAN_RESOLUTION_RECOVERY_REQUIRED', 'An active human-resolution transaction must be recovered first.', ExitCode.conflict);
}
function activeJournalBindsGrant(filePath, changeId, grantId) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before?.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600) {
        return false;
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor);
        if (opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            !opened.isFile() ||
            opened.nlink !== 1 ||
            (opened.mode & 0o777) !== 0o600) {
            return false;
        }
        const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
        return (isRecord(value) &&
            value.schemaVersion === 2 &&
            value.kind === 'human-resolution-journal' &&
            value.grantId === grantId &&
            isRecord(value.target) &&
            value.target.changeId === changeId);
    }
    catch {
        return false;
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
function existingChangeLockError(lockPath, transition) {
    try {
        const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (typeof value === 'object' &&
            value !== null &&
            'sessionId' in value &&
            typeof value.sessionId === 'string') {
            return workflowError('ACTIVE_SESSION_CONFLICT', 'Change already has an active task session.', ExitCode.conflict);
        }
    }
    catch {
        // A malformed occupied lock remains an exclusive conflict.
    }
    return workflowError(transition === 'archive'
        ? 'ARCHIVE_TRANSITION_CONFLICT'
        : transition === 'investigation'
            ? 'INVESTIGATION_TRANSITION_CONFLICT'
            : transition === 'human-resolution'
                ? 'HUMAN_RESOLUTION_TRANSITION_CONFLICT'
                : 'PLANNING_TRANSITION_CONFLICT', `Change already has a ${transition} transition in progress.`, ExitCode.conflict);
}
function staleLock() {
    return workflowError('PLANNING_LOCK_INVALID', 'Planning change lock ownership changed during the transition.', ExitCode.staleState);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
