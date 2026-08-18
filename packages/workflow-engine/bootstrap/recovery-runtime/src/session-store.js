import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isPlanningAssuranceBinding, } from './contracts.js';
import { ExitCode, workflowError } from './errors.js';
import { ensurePlainDirectory, publishPreparedExclusiveLock, reclaimDeadPreparedLock, withPreparedLockCleanupClaim, } from './filesystem-safety.js';
import { assertHumanResolutionLifecycleBarrier, reclaimHumanResolutionJournalTemporaries, } from './investigation-session-store.js';
import { assertGrantLifecycleBarrier } from './grant-store.js';
import { normalizePolicyPath } from './paths.js';
const MAINTAINER_GRANT_STATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const SESSION_LOCK_OWNER_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TASK_REVISION_LEASE_ID = /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function runtimePaths(gitCommonDirectory, runtimeDirectory) {
    const root = path.join(gitCommonDirectory, runtimeDirectory);
    return {
        root,
        locks: path.join(root, 'locks'),
        operations: path.join(root, 'operations'),
        sessions: path.join(root, 'sessions'),
        reports: path.join(root, 'reports'),
        taskRevisions: path.join(root, 'task-revisions'),
    };
}
export function withSessionOperation(runtime, sessionId, operation) {
    ensurePlainDirectory(runtime.operations);
    const lockPath = path.join(runtime.operations, `${sessionId}.lock`);
    const ownerToken = crypto.randomUUID();
    const content = `${JSON.stringify({
        sessionId,
        ownerToken,
        pid: process.pid,
    })}\n`;
    let descriptor;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            descriptor = publishPreparedExclusiveLock(lockPath, content, ownerToken, invalidSessionLock);
            break;
        }
        catch (error) {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
                descriptor = undefined;
            }
            if (isNodeError(error) &&
                error.code === 'EEXIST' &&
                attempt === 0 &&
                reclaimDeadSessionOperationLock(lockPath, sessionId)) {
                continue;
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workflowError('SESSION_OPERATION_CONFLICT', `Session ${sessionId} already has an operation in progress.`, ExitCode.conflict);
            }
            throw error;
        }
    }
    try {
        return operation();
    }
    finally {
        releaseSessionOperationLock(lockPath, descriptor, content);
    }
}
function releaseSessionOperationLock(lockPath, descriptor, content) {
    if (descriptor === undefined) {
        throw invalidSessionLock();
    }
    try {
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        let observedContent;
        try {
            observedContent = fs.readFileSync(lockPath, 'utf8');
        }
        catch {
            observedContent = undefined;
        }
        if (!owned.isFile() ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            !observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.nlink !== 1 ||
            (observed.mode & 0o777) !== 0o600 ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            observedContent !== content ||
            readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content) {
            throw invalidSessionLock();
        }
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function reclaimDeadSessionOperationLock(lockPath, expectedSessionId) {
    const result = reclaimDeadPreparedLock(lockPath, (content) => {
        let value;
        try {
            value = JSON.parse(content);
        }
        catch {
            return null;
        }
        if (!isRecord(value) ||
            Object.keys(value).length !== 3 ||
            value.sessionId !== expectedSessionId ||
            typeof value.ownerToken !== 'string' ||
            !Number.isSafeInteger(value.pid) ||
            value.pid < 1 ||
            `${JSON.stringify(value)}\n` !== content) {
            return null;
        }
        return {
            pid: value.pid,
            ownerToken: value.ownerToken,
        };
    });
    return result === 'absent' || result === 'reclaimed';
}
export function withRepositoryLifecycleOperation(runtime, operation, options = {}) {
    const lease = acquireRepositoryLifecycleLease(runtime, options);
    let result;
    try {
        result = operation(lease.assertOwned);
    }
    catch (operationError) {
        releaseAfterOperationError(lease, operationError);
    }
    lease.release();
    return result;
}
export async function withRepositoryLifecycleOperationAsync(runtime, operation, options = {}) {
    const lease = acquireRepositoryLifecycleLease(runtime, options);
    let result;
    try {
        result = await operation(lease.assertOwned);
    }
    catch (operationError) {
        releaseAfterOperationError(lease, operationError);
    }
    lease.release();
    return result;
}
function acquireRepositoryLifecycleLease(runtime, options) {
    assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeId ?? null);
    assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
    ensurePlainDirectory(runtime.operations);
    const lockPath = path.join(runtime.operations, 'repository-lifecycle.lock');
    const ownerToken = crypto.randomUUID();
    const content = `${JSON.stringify({
        kind: 'repository-lifecycle',
        ownerToken,
        pid: process.pid,
    })}\n`;
    let descriptor;
    const assertOwned = () => {
        if (descriptor === undefined) {
            throw invalidRepositoryLifecycleLock('Repository lifecycle lock ownership was lost.');
        }
        const owned = fs.fstatSync(descriptor);
        const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
        let observedContent;
        try {
            observedContent = fs.readFileSync(lockPath, 'utf8');
        }
        catch {
            observedContent = undefined;
        }
        if (!owned.isFile() ||
            owned.nlink !== 1 ||
            (owned.mode & 0o777) !== 0o600 ||
            !observed?.isFile() ||
            observed.isSymbolicLink() ||
            observed.nlink !== 1 ||
            (observed.mode & 0o777) !== 0o600 ||
            observed.dev !== owned.dev ||
            observed.ino !== owned.ino ||
            observedContent !== content ||
            readDescriptorContent(descriptor, Buffer.byteLength(content)) !== content) {
            throw invalidRepositoryLifecycleLock('Repository lifecycle lock ownership changed during the transition.');
        }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            descriptor = publishPreparedExclusiveLock(lockPath, content, ownerToken, () => invalidRepositoryLifecycleLock('Repository lifecycle reclaim state is unsafe.'));
            break;
        }
        catch (error) {
            if (isNodeError(error) &&
                error.code === 'EEXIST' &&
                attempt === 0 &&
                reclaimDeadRepositoryLifecycleLock(lockPath)) {
                continue;
            }
            if (isNodeError(error) && error.code === 'EEXIST') {
                throw workflowError('REPOSITORY_LIFECYCLE_CONFLICT', 'Another repository lifecycle transition is in progress.', ExitCode.conflict);
            }
            throw error;
        }
    }
    if (descriptor === undefined) {
        throw invalidRepositoryLifecycleLock('Repository lifecycle lock could not be acquired.');
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
            throw invalidRepositoryLifecycleLock('Repository lifecycle lock ownership was lost.');
        }
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.unlinkSync(lockPath);
        fsyncDirectory(path.dirname(lockPath));
    };
    try {
        reclaimHumanResolutionJournalTemporaries(runtime.root, assertOwned);
        const assertLifecycleOwned = () => {
            assertOwned();
            assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeId ?? null);
            assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
        };
        assertHumanResolutionLifecycleBarrier(runtime.root, options.allowHumanResolutionGrantId ?? null, options.allowHumanResolutionChangeId ?? null);
        assertGrantLifecycleBarrier(runtime.root, options.allowGrantChallengeId ?? null);
        assertMaintainerReservationCompatibility(runtime, options.allowMaintainerGrantId);
        return { assertOwned: assertLifecycleOwned, release };
    }
    catch (setupError) {
        try {
            release();
        }
        catch (releaseError) {
            throw new AggregateError([setupError, releaseError], 'Repository lifecycle setup and lock release both failed.', { cause: releaseError });
        }
        throw setupError;
    }
}
function releaseAfterOperationError(lease, operationError) {
    try {
        lease.release();
    }
    catch (releaseError) {
        throw new AggregateError([operationError, releaseError], 'Repository lifecycle operation and lock release both failed.', { cause: releaseError });
    }
    throw operationError;
}
function reclaimDeadRepositoryLifecycleLock(lockPath) {
    const result = reclaimDeadPreparedLock(lockPath, (content) => {
        let value;
        try {
            value = JSON.parse(content);
        }
        catch {
            return null;
        }
        if (!isRecord(value) ||
            Object.keys(value).length !== 3 ||
            value.kind !== 'repository-lifecycle' ||
            typeof value.ownerToken !== 'string' ||
            !Number.isSafeInteger(value.pid) ||
            value.pid < 1 ||
            `${JSON.stringify(value)}\n` !== content) {
            return null;
        }
        return {
            pid: value.pid,
            ownerToken: value.ownerToken,
        };
    });
    return result === 'absent' || result === 'reclaimed';
}
function readDescriptorContent(descriptor, byteLength) {
    const bytes = Buffer.alloc(byteLength);
    const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
    return bytes.subarray(0, count).toString('utf8');
}
export function listActiveWorkflowSessionIds(runtime) {
    return listActiveWorkflowSessions(runtime).map((session) => session.sessionId);
}
export function listConflictingActiveWorkflowSessionIds(runtime, scope) {
    const repositoryRoot = scope.repositoryRoot === undefined
        ? undefined
        : path.resolve(scope.repositoryRoot);
    const targetBranch = scope.targetRef?.startsWith('refs/heads/')
        ? scope.targetRef.slice('refs/heads/'.length)
        : undefined;
    return listActiveWorkflowSessions(runtime)
        .filter((session) => session.changeId === scope.changeId ||
        (repositoryRoot !== undefined &&
            path.resolve(session.repositoryRoot) === repositoryRoot) ||
        (targetBranch !== undefined && session.branch === targetBranch))
        .map((session) => session.sessionId);
}
function listActiveWorkflowSessions(runtime) {
    const stats = fs.lstatSync(runtime.sessions, { throwIfNoEntry: false });
    if (!stats) {
        return [];
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw workflowError('SESSION_DIRECTORY_UNSAFE', 'Workflow session directory is unsafe.', ExitCode.staleState);
    }
    return fs
        .readdirSync(runtime.sessions)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => readSessionFile(path.join(runtime.sessions, entry)))
        .filter((session) => session.state === 'active' || session.state === 'revising')
        .sort((left, right) => left.sessionId < right.sessionId
        ? -1
        : left.sessionId > right.sessionId
            ? 1
            : 0);
}
function assertMaintainerReservationCompatibility(runtime, allowedGrantId) {
    // Maintainer authority remains a repository-wide human-only fence. The
    // change-scoped relaxation applies only to ordinary active sessions.
    const reservedDirectory = path.join(runtime.root, 'maintainer-grants', 'reserved');
    const stats = fs.lstatSync(reservedDirectory, { throwIfNoEntry: false });
    if (!stats) {
        return;
    }
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(reservedDirectory) !== path.resolve(reservedDirectory) ||
        (stats.mode & 0o777) !== 0o700) {
        throw workflowError('MAINTAINER_GRANT_STORE_UNSAFE', 'Maintainer grant reservation storage is unsafe.', ExitCode.staleState);
    }
    const entries = fs.readdirSync(reservedDirectory);
    if (entries.some((entry) => !MAINTAINER_GRANT_STATE_FILE.test(entry))) {
        throw workflowError('MAINTAINER_GRANT_STORE_UNSAFE', 'Maintainer grant reservation storage contains an invalid entry.', ExitCode.staleState);
    }
    const reservations = entries
        .map((entry) => entry.slice(0, -'.json'.length))
        .sort();
    if (reservations.length === 0 ||
        (allowedGrantId !== undefined &&
            reservations.length === 1 &&
            reservations[0] === allowedGrantId)) {
        return;
    }
    throw workflowError('ACTIVE_AUTHORITY_CONFLICT', 'A maintainer authority reservation already owns the repository lifecycle.', ExitCode.conflict, { details: { grantIds: reservations } });
}
function invalidRepositoryLifecycleLock(message) {
    return workflowError('REPOSITORY_LIFECYCLE_LOCK_INVALID', message, ExitCode.staleState);
}
export function readSessionFile(sessionPath) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    }
    catch (error) {
        throw workflowError('SESSION_UNREADABLE', `Unable to read session: ${path.basename(sessionPath, '.json')}`, ExitCode.staleState, {
            details: {
                sessionPath,
                cause: error instanceof Error ? error.message : String(error),
            },
        });
    }
    if (!isWorkflowSession(value)) {
        throw workflowError('INVALID_SESSION', `Session file is malformed: ${sessionPath}`, ExitCode.staleState);
    }
    const expectedSessionId = path.basename(sessionPath, '.json');
    if (value.sessionId !== expectedSessionId) {
        throw workflowError('SESSION_ID_MISMATCH', `Session content does not match filename ${expectedSessionId}.`, ExitCode.staleState);
    }
    return value;
}
export function writeJsonAtomic(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filePath);
        fsyncDirectory(path.dirname(filePath));
    }
    catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporaryPath, { force: true });
        throw error;
    }
}
export function releaseOwnedLock(lockPath, sessionId) {
    withPreparedLockCleanupClaim(lockPath, () => {
        let descriptor;
        try {
            try {
                descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            }
            catch (error) {
                if (isNodeError(error) && error.code === 'ENOENT') {
                    return;
                }
                throw error;
            }
            const opened = fs.fstatSync(descriptor);
            const content = fs.readFileSync(descriptor, 'utf8');
            const value = parseManagedSessionLock(content);
            if (!opened.isFile() ||
                opened.nlink !== 1 ||
                (opened.mode & 0o777) !== 0o600 ||
                value === null) {
                throw invalidSessionLock();
            }
            if (value.sessionId !== sessionId) {
                return;
            }
            const observed = fs.lstatSync(lockPath, { throwIfNoEntry: false });
            if (!observed ||
                observed.dev !== opened.dev ||
                observed.ino !== opened.ino) {
                return;
            }
            try {
                fs.unlinkSync(lockPath);
            }
            catch (error) {
                if (!isNodeError(error) || error.code !== 'ENOENT') {
                    throw error;
                }
            }
            fsyncDirectory(path.dirname(lockPath));
        }
        finally {
            if (descriptor !== undefined) {
                fs.closeSync(descriptor);
            }
        }
    });
}
export function assertOwnedLock(lockPath, sessionId, changeId, taskId) {
    let value;
    try {
        value = parseManagedSessionLock(fs.readFileSync(lockPath, 'utf8'));
    }
    catch {
        throw invalidSessionLock();
    }
    if (value?.sessionId !== sessionId ||
        value.changeId !== changeId ||
        value.taskId !== taskId) {
        throw invalidSessionLock();
    }
}
function parseManagedSessionLock(content) {
    let value;
    try {
        value = JSON.parse(content);
    }
    catch {
        return null;
    }
    if (!isRecord(value) ||
        typeof value.sessionId !== 'string' ||
        typeof value.changeId !== 'string' ||
        typeof value.taskId !== 'string' ||
        `${JSON.stringify(value)}\n` !== content) {
        return null;
    }
    const keys = Object.keys(value).sort();
    if (keys.join('\0') === ['changeId', 'sessionId', 'taskId'].join('\0')) {
        return value;
    }
    if (keys.join('\0') !==
        ['changeId', 'ownerToken', 'pid', 'sessionId', 'taskId'].join('\0') ||
        typeof value.ownerToken !== 'string' ||
        !SESSION_LOCK_OWNER_TOKEN.test(value.ownerToken) ||
        !Number.isSafeInteger(value.pid) ||
        value.pid < 1) {
        return null;
    }
    return value;
}
export function createSessionId() {
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
    return `session-${timestamp}-${crypto.randomUUID()}`;
}
function isWorkflowSession(value) {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        return false;
    }
    const allowedFields = new Set([
        'schemaVersion',
        'sessionId',
        'state',
        'changeId',
        'taskId',
        'mandateBinding',
        'repositoryRoot',
        'gitCommonDirectory',
        'branch',
        'baseline',
        'artifacts',
        'allowedPaths',
        'requiredChecks',
        'requiredCheckDigests',
        'checkEvidenceEngineDigest',
        'planningAssurance',
        'revisionLeaseId',
        'implementationReconciliationReportId',
        'implementationReconciliationPaths',
        'documentationRemediation',
        'createdAt',
        'latestCheckReportId',
        'completionReportId',
        'finishReportId',
        'commitReportId',
        'commitHash',
        'committedAt',
        'abortedAt',
        'abortReason',
    ]);
    if (Object.keys(value).some((field) => !allowedFields.has(field))) {
        return false;
    }
    if (typeof value.sessionId !== 'string' ||
        !['active', 'revising', 'aborted', 'committed'].includes(String(value.state)) ||
        typeof value.changeId !== 'string' ||
        typeof value.taskId !== 'string' ||
        typeof value.repositoryRoot !== 'string' ||
        typeof value.gitCommonDirectory !== 'string' ||
        typeof value.branch !== 'string' ||
        typeof value.createdAt !== 'string' ||
        Number.isNaN(Date.parse(value.createdAt)) ||
        !isRecord(value.baseline) ||
        typeof value.baseline.head !== 'string' ||
        typeof value.baseline.tree !== 'string' ||
        !isStringRecord(value.artifacts) ||
        !isStringArray(value.allowedPaths) ||
        !isStringArray(value.requiredChecks)) {
        return false;
    }
    if (value.mandateBinding !== undefined &&
        value.mandateBinding !== null &&
        !isTaskMandateBinding(value.mandateBinding, value.changeId)) {
        return false;
    }
    for (const field of [
        'implementationReconciliationReportId',
        'latestCheckReportId',
        'completionReportId',
        'finishReportId',
        'commitReportId',
    ]) {
        const fieldValue = value[field];
        if (fieldValue !== undefined && !isDigest(fieldValue)) {
            return false;
        }
    }
    if (value.requiredCheckDigests !== undefined &&
        !isStringRecord(value.requiredCheckDigests)) {
        return false;
    }
    if (value.implementationReconciliationPaths !== undefined &&
        (!isStringArray(value.implementationReconciliationPaths) ||
            value.implementationReconciliationPaths.length === 0 ||
            new Set(value.implementationReconciliationPaths).size !==
                value.implementationReconciliationPaths.length ||
            JSON.stringify(value.implementationReconciliationPaths) !==
                JSON.stringify([...value.implementationReconciliationPaths].sort()) ||
            value.implementationReconciliationPaths.some((candidatePath) => !candidatePath.startsWith('workflow/semantic-ledger/') ||
                candidatePath.includes('..')))) {
        return false;
    }
    if (value.implementationReconciliationPaths !== undefined &&
        value.implementationReconciliationReportId === undefined) {
        return false;
    }
    if (value.documentationRemediation !== undefined &&
        (!isRecord(value.documentationRemediation) ||
            Object.keys(value.documentationRemediation).sort().join('\0') !==
                ['paths', 'reviewRecordDigests'].join('\0') ||
            !isStringArray(value.documentationRemediation.reviewRecordDigests) ||
            value.documentationRemediation.reviewRecordDigests.length === 0 ||
            value.documentationRemediation.reviewRecordDigests.some((candidate) => !isDigest(candidate)) ||
            !isCanonicalStringSet(value.documentationRemediation.reviewRecordDigests) ||
            !isStringArray(value.documentationRemediation.paths) ||
            value.documentationRemediation.paths.length === 0 ||
            !isCanonicalStringSet(value.documentationRemediation.paths) ||
            value.documentationRemediation.paths.some((candidate) => !isCanonicalDocumentationRemediationPath(candidate) ||
                (!candidate.startsWith('docs/') &&
                    !/(?:^|\/)README\.md$/.test(candidate))))) {
        return false;
    }
    if (value.checkEvidenceEngineDigest !== undefined &&
        !isSha256Digest(value.checkEvidenceEngineDigest)) {
        return false;
    }
    if (value.planningAssurance !== undefined &&
        value.planningAssurance !== null &&
        !isPlanningAssuranceBinding(value.planningAssurance)) {
        return false;
    }
    if (value.revisionLeaseId !== undefined &&
        (typeof value.revisionLeaseId !== 'string' ||
            !TASK_REVISION_LEASE_ID.test(value.revisionLeaseId))) {
        return false;
    }
    if ((value.state === 'revising') !==
        (typeof value.revisionLeaseId === 'string')) {
        // An aborted session may retain its terminal lease pointer for audit.
        if (value.state !== 'aborted' || value.revisionLeaseId === undefined) {
            return false;
        }
    }
    if ((value.commitHash !== undefined && !isCommitHash(value.commitHash)) ||
        (value.commitReportId === undefined) !== (value.commitHash === undefined)) {
        return false;
    }
    if (value.state === 'active' &&
        value.commitReportId !== undefined &&
        (value.finishReportId === undefined || value.committedAt !== undefined)) {
        return false;
    }
    if (value.state === 'revising' &&
        (value.latestCheckReportId !== undefined ||
            value.completionReportId !== undefined ||
            value.finishReportId !== undefined ||
            value.commitReportId !== undefined ||
            value.commitHash !== undefined ||
            value.committedAt !== undefined)) {
        return false;
    }
    if (value.state === 'aborted' &&
        (typeof value.abortedAt !== 'string' ||
            Number.isNaN(Date.parse(value.abortedAt)) ||
            typeof value.abortReason !== 'string' ||
            !value.abortReason)) {
        return false;
    }
    if (value.state === 'committed' &&
        (!isDigest(value.latestCheckReportId) ||
            !isDigest(value.completionReportId) ||
            !isDigest(value.finishReportId) ||
            !isDigest(value.commitReportId) ||
            !isCommitHash(value.commitHash) ||
            typeof value.committedAt !== 'string' ||
            Number.isNaN(Date.parse(value.committedAt)))) {
        return false;
    }
    return true;
}
function isCanonicalDocumentationRemediationPath(candidate) {
    try {
        return (normalizePolicyPath(candidate) === candidate && !candidate.endsWith('/**'));
    }
    catch {
        return false;
    }
}
function isTaskMandateBinding(value, changeId) {
    if (!isRecord(value))
        return false;
    const keys = Object.keys(value).sort();
    if (keys.join('\0') !==
        [
            'changeId',
            'externalAuditRoot',
            'mandateDigest',
            'mandateId',
            'mandateTaskId',
            'schemaVersion',
        ]
            .sort()
            .join('\0')) {
        return false;
    }
    return (value.schemaVersion === 1 &&
        value.changeId === changeId &&
        typeof value.externalAuditRoot === 'string' &&
        path.isAbsolute(value.externalAuditRoot) &&
        path.normalize(value.externalAuditRoot) === value.externalAuditRoot &&
        typeof value.mandateTaskId === 'string' &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) &&
        typeof value.mandateId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.mandateId) &&
        isDigest(value.mandateDigest));
}
function isDigest(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function isSha256Digest(value) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function isCommitHash(value) {
    return (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
    return (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}
function isCanonicalStringSet(value) {
    return (new Set(value).size === value.length &&
        JSON.stringify(value) === JSON.stringify([...value].sort()));
}
function isStringRecord(value) {
    return (isRecord(value) &&
        Object.values(value).every((item) => typeof item === 'string'));
}
function invalidSessionLock() {
    return workflowError('SESSION_LOCK_INVALID', 'The active session lock is missing or does not match the session.', ExitCode.staleState);
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
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
