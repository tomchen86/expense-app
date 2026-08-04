import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { discoverRepository, runGit } from './git.js';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.js';
import { assertHumanRevocationAuthorization, authorizeHumanRevocation, canonicalHumanRevocationAuthorization, digestHumanRevocationSubject, } from './human-revocation.js';
import { createEngineArtifact, verifyHarnessMaintenanceGrant, } from './intervention-control.js';
import { parseMaintainerPolicy } from './maintainer-policy.js';
import { interventionControlPersistencePaths, readPersistedIntervention, } from './intervention-control-persistence.js';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const ENGINE_PROBE_TIMEOUT_MS = 10_000;
export const MAINTENANCE_SCOPE_PATHS = Object.freeze([
    'packages/harness-runtime/**',
    'packages/workflow-engine/**',
]);
export const MAINTENANCE_SCOPE_OPERATIONS = Object.freeze([
    'adopt-engine-into-parent',
    'build-engine-artifact',
    'create-isolated-workspace',
    'modify-engine',
    'run-engine-tests',
]);
export const MAINTENANCE_SCOPE_WAIVERS = Object.freeze([
    'active-change-exclusivity',
    'clean-worktree-required',
    'engine-path-protection',
]);
export function buildAndPersistInterventionEngineArtifact(storageRoot, input) {
    const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
    if (!Number.isSafeInteger(input.protocolVersion) ||
        input.protocolVersion < 1 ||
        !Number.isSafeInteger(input.policySchemaVersion) ||
        input.policySchemaVersion < 1) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_VERSION_INVALID', 'Engine artifact protocol and policy schema versions must be positive integers.', ExitCode.usage);
    }
    const childWorkspacePath = intervention.childWorkspace.childWorkspacePath;
    const childRepository = discoverRepository(childWorkspacePath);
    if (childRepository.repositoryRealPath !== childWorkspacePath ||
        childRepository.branch !==
            `work/${intervention.relationship.interventionChangeId}` ||
        childRepository.head !== intervention.checkpoint.baseOid) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_WORKSPACE_MISMATCH', 'Engine artifact must be built from the exact reserved child worktree and checkpoint base.', ExitCode.verification);
    }
    const executablePath = assertScopedChildArtifactPath(childWorkspacePath, input.executablePath);
    const executableBytes = readBoundedArtifactSource(executablePath);
    const executableDigest = digest(executableBytes);
    const sourceDigestBeforeSmoke = interventionSourceDigest(childWorkspacePath);
    const probe = runArtifactProbe(executablePath, '--bootstrap-probe');
    const health = runArtifactProbe(executablePath, '--health-check');
    const sourceDigest = interventionSourceDigest(childWorkspacePath);
    if (sourceDigest !== sourceDigestBeforeSmoke) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_SOURCE_DRIFT', 'Engine source changed while the candidate smoke contract was running.', ExitCode.staleState);
    }
    if (probe.kind !== 'engine-bootstrap-probe.v1' ||
        probe.started !== true ||
        probe.sessionSchema !== intervention.parent.sessionSchema ||
        health.kind !== 'engine-health.v1' ||
        health.healthy !== true ||
        health.sessionSchema !== intervention.parent.sessionSchema) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_SMOKE_FAILED', 'Candidate engine did not pass the bootstrap and health smoke contract.', ExitCode.verification);
    }
    const smokeReportDigest = digest(canonicalJson({
        kind: 'intervention-engine-smoke-report.v1',
        executableDigest,
        sourceDigest,
        probe,
        health,
    }));
    const artifact = createEngineArtifact({
        sourceChangeId: intervention.relationship.interventionChangeId,
        sourceDigest,
        executableDigest,
        protocolVersion: input.protocolVersion,
        canReadSessionSchemas: [intervention.parent.sessionSchema],
        writesSessionSchema: intervention.parent.sessionSchema,
        policySchemaVersion: input.policySchemaVersion,
        smokeReportDigest,
    });
    return persistInterventionEngineArtifact(storageRoot, {
        parentChangeId: input.parentChangeId,
        artifact,
        executablePath,
        now: input.now,
    });
}
export function maintenanceGrantId(parentChangeId, checkpointId, issuedAt, interventionChangeId) {
    assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    assertDigest(checkpointId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    if (issuedAt !== undefined) {
        exactDate(new Date(issuedAt));
        assertNonEmpty(interventionChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    }
    return `maintenance-${crypto
        .createHash('sha256')
        .update(issuedAt === undefined
        ? `maintenance-grant\0${parentChangeId}\0${checkpointId}`
        : `maintenance-grant.v2\0${parentChangeId}\0${checkpointId}\0${interventionChangeId}\0${issuedAt}`)
        .digest('hex')}`;
}
export function maintenanceApprovalSummary(input) {
    const humanReadable = [
        'Harness maintenance intervention',
        `Parent change: ${input.parentChangeId}`,
        `Intervention change: ${input.interventionChangeId}`,
        `Checkpoint: ${input.checkpointId}`,
        `Current engine: ${input.engineFromDigest}`,
        `Session schema: ${input.sessionSchema}`,
        `Reason: ${input.reason}`,
        `Reserved child workspace: ${input.childWorkspace.path}`,
        `Reserved child change ref: ${input.childWorkspace.changeRef}`,
        `Exact scope paths: ${MAINTENANCE_SCOPE_PATHS.join(', ')}`,
        `Allowed operations: ${MAINTENANCE_SCOPE_OPERATIONS.join(', ')}`,
        `Explicit waivers: ${MAINTENANCE_SCOPE_WAIVERS.join(', ')}`,
        `External authority audit root: ${input.authorityAudit.externalAuditRoot}`,
        `Authority audit repository: ${input.authorityAudit.repositoryId}`,
        'Local adoption limit: 1',
        'Repository-default/global engine promotion: forbidden',
    ].join('\n');
    return deepFreeze({
        kind: 'maintenance-approval-summary.v1',
        ...input,
        scope: {
            paths: [...MAINTENANCE_SCOPE_PATHS],
            operations: [...MAINTENANCE_SCOPE_OPERATIONS],
        },
        waivers: [...MAINTENANCE_SCOPE_WAIVERS],
        authorityAudit: structuredClone(input.authorityAudit),
        maxLocalAdoptions: 1,
        humanReadable,
    });
}
export function persistMaintenanceGrantRecord(storageRoot, input) {
    const paths = maintenancePaths(storageRoot);
    ensurePrivateDirectory(paths.grants);
    const payload = input.envelope.payload;
    assertAuditBinding(input.summary.authorityAudit);
    const legacyGrantId = maintenanceGrantId(input.summary.parentChangeId, input.summary.checkpointId);
    const issuedGrantId = maintenanceGrantId(input.summary.parentChangeId, input.summary.checkpointId, payload.issuedAt, payload.interventionChangeId);
    if (![legacyGrantId, issuedGrantId].includes(payload.grantId) ||
        payload.parentChangeId !== input.summary.parentChangeId ||
        payload.interventionChangeId !== input.summary.interventionChangeId ||
        payload.engineFromDigest !== input.summary.engineFromDigest ||
        payload.sessionSchema !== input.summary.sessionSchema ||
        payload.reason !== input.summary.reason ||
        canonicalJson(payload.scope) !== canonicalJson(input.summary.scope) ||
        canonicalJson(payload.waivers) !== canonicalJson(input.summary.waivers) ||
        payload.maxLocalAdoptions !== input.summary.maxLocalAdoptions) {
        throw maintenanceRecordCorrupt('Maintenance grant does not match the presented approval summary.');
    }
    const at = exactDate(input.now).toISOString();
    const record = withRecordDigest({
        kind: 'persisted-maintenance-grant.v1',
        state: 'available',
        parentChangeId: input.summary.parentChangeId,
        interventionChangeId: input.summary.interventionChangeId,
        checkpointId: input.summary.checkpointId,
        authorityAudit: structuredClone(input.summary.authorityAudit),
        envelope: structuredClone(input.envelope),
        summary: structuredClone(input.summary),
        createdAt: at,
        updatedAt: at,
        expiredAt: null,
        revokedAt: null,
        revocationReason: null,
    });
    const target = maintenanceGrantRecordPath(storageRoot, payload.grantId);
    if (fs.existsSync(target)) {
        const existing = readMaintenanceGrantRecord(storageRoot, payload.grantId);
        if (canonicalJson(existing) !== canonicalJson(record)) {
            throw workflowError('MAINTENANCE_GRANT_RECORD_CONFLICT', 'Maintenance grant id is already bound to different bytes.', ExitCode.conflict);
        }
        return existing;
    }
    createPrivateFileExclusive(target, `${canonicalJson(record)}\n`);
    return deepFreeze(structuredClone(record));
}
export function readMaintenanceGrantRecord(storageRoot, grantId) {
    const value = readCanonicalPrivateFile(maintenanceGrantRecordPath(storageRoot, grantId), 'MAINTENANCE_GRANT_RECORD_NOT_FOUND');
    const hasRevocationAuthorization = isRecord(value) &&
        Object.prototype.hasOwnProperty.call(value, 'revocationAuthorization');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'checkpointId',
            'authorityAudit',
            'createdAt',
            'envelope',
            'expiredAt',
            'interventionChangeId',
            'kind',
            'parentChangeId',
            'recordDigest',
            'revocationReason',
            ...(hasRevocationAuthorization ? ['revocationAuthorization'] : []),
            'revokedAt',
            'state',
            'summary',
            'updatedAt',
        ]) ||
        value.kind !== 'persisted-maintenance-grant.v1' ||
        !['available', 'expired', 'revoked'].includes(String(value.state)) ||
        !verifyRecordDigest(value)) {
        throw maintenanceRecordCorrupt();
    }
    const record = value;
    assertAuditBinding(record.authorityAudit);
    assertAuditBinding(record.summary.authorityAudit);
    if (record.envelope.payload.grantId !== grantId ||
        record.envelope.payload.parentChangeId !== record.parentChangeId ||
        record.envelope.payload.interventionChangeId !==
            record.interventionChangeId ||
        record.summary.checkpointId !== record.checkpointId ||
        record.summary.parentChangeId !== record.parentChangeId ||
        record.summary.interventionChangeId !== record.interventionChangeId ||
        canonicalJson(record.authorityAudit) !==
            canonicalJson(record.summary.authorityAudit) ||
        (record.state === 'available' &&
            (record.expiredAt !== null ||
                record.revokedAt !== null ||
                record.revocationReason !== null)) ||
        (record.state === 'expired' &&
            (record.expiredAt !== record.envelope.payload.expiresAt ||
                record.revokedAt !== null ||
                record.revocationReason !== null)) ||
        (record.state === 'revoked' &&
            (record.expiredAt !== null ||
                record.revokedAt === null ||
                record.revocationReason === null)) ||
        (hasRevocationAuthorization &&
            (record.state !== 'revoked' ||
                canonicalJson(assertMaintenanceRevocationAuthorization(record.revocationAuthorization, grantId, record.revocationReason, record.revokedAt)) !== canonicalJson(record.revocationAuthorization)))) {
        throw maintenanceRecordCorrupt();
    }
    exactDate(new Date(record.createdAt));
    exactDate(new Date(record.updatedAt));
    return deepFreeze(structuredClone(record));
}
export function readMaintenanceGrantForParent(storageRoot, parentChangeId) {
    assertNonEmpty(parentChangeId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    const directory = maintenancePaths(storageRoot).grants;
    if (!fs.existsSync(directory)) {
        throw workflowError('MAINTENANCE_GRANT_RECORD_NOT_FOUND', 'Persisted maintenance record was not found.', ExitCode.conflict);
    }
    const matches = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === 'revocation-authorizations') {
            continue;
        }
        if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
            throw workflowError('INTERVENTION_MAINTENANCE_STORAGE_UNSAFE', 'Maintenance grant store contains an unexpected entry.', ExitCode.unsafeEnvironment);
        }
        const value = readCanonicalPrivateFile(path.join(directory, entry.name), 'MAINTENANCE_GRANT_RECORD_NOT_FOUND');
        if (!isRecord(value) ||
            !isRecord(value.envelope) ||
            !isRecord(value.envelope.payload) ||
            typeof value.envelope.payload.grantId !== 'string') {
            throw maintenanceRecordCorrupt();
        }
        const grantId = value.envelope.payload.grantId;
        if (path.basename(maintenanceGrantRecordPath(storageRoot, grantId)) !==
            entry.name) {
            throw maintenanceRecordCorrupt();
        }
        const record = readMaintenanceGrantRecord(storageRoot, grantId);
        if (record.parentChangeId === parentChangeId)
            matches.push(record);
    }
    if (matches.length === 0) {
        throw workflowError('MAINTENANCE_GRANT_RECORD_NOT_FOUND', 'Persisted maintenance record was not found.', ExitCode.conflict);
    }
    matches.sort((left, right) => {
        const byTime = left.createdAt < right.createdAt
            ? -1
            : left.createdAt > right.createdAt
                ? 1
                : 0;
        if (byTime !== 0)
            return byTime;
        const rank = { expired: 0, revoked: 1, available: 2 };
        const byState = rank[left.state] - rank[right.state];
        if (byState !== 0)
            return byState;
        return left.envelope.payload.grantId < right.envelope.payload.grantId
            ? -1
            : left.envelope.payload.grantId > right.envelope.payload.grantId
                ? 1
                : 0;
    });
    return matches.at(-1);
}
export function revokeMaintenanceGrantForParent(cwd, storageRoot, parentChangeId, options) {
    assertNonEmpty(options.reason, 'MAINTENANCE_GRANT_REVOCATION_INVALID');
    const repository = discoverRepository(cwd);
    const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
    if (current.state !== 'available' && current.state !== 'revoked') {
        throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Only active harness-maintenance authority can be revoked.', ExitCode.guard);
    }
    const requestedNow = exactDate(options.now ?? new Date());
    if (current.state !== 'revoked') {
        const intervention = readPersistedIntervention(storageRoot, parentChangeId);
        const expiresAt = Date.parse(current.envelope.payload.expiresAt);
        const verificationNow = new Date(Math.min(requestedNow.getTime(), expiresAt - 1));
        verifyHarnessMaintenanceGrant(current.envelope, {
            now: verificationNow,
            parent: intervention.parent,
            relationship: intervention.relationship,
            checkpoint: intervention.checkpoint,
            verifyHumanSignature: options.verifyHumanSignature,
        });
    }
    const expectedAuditRepositoryId = deriveAuthorityAuditRepositoryId(`git-common:${repository.gitCommonDirectory}`);
    if (current.authorityAudit.repositoryId !== expectedAuditRepositoryId) {
        throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Maintenance revocation audit binding does not match this Git common directory.', ExitCode.guard);
    }
    const policy = loadCurrentMaintainerPolicy(repository.repositoryRoot);
    const authorization = authorizeHumanRevocation(repository.repositoryRoot, {
        subjectKind: 'harness-maintenance-grant',
        grantId: current.envelope.payload.grantId,
        grantDigest: digestHumanRevocationSubject(`${canonicalJson(current.envelope)}\n`),
        repositoryId: policy.repository.id,
        repositoryOrigin: policy.repository.origin,
        changeId: current.parentChangeId,
        taskId: null,
        workflowId: current.interventionChangeId,
        audit: structuredClone(current.authorityAudit),
    }, options, path.join(storageRoot, 'maintenance-grants', 'revocation-authorizations', `${current.envelope.payload.grantId}.json`), current.revocationAuthorization ?? null);
    if (current.state === 'revoked') {
        if (current.revocationReason !== authorization.payload.reason ||
            current.revocationAuthorization === undefined ||
            canonicalHumanRevocationAuthorization(current.revocationAuthorization) !==
                canonicalHumanRevocationAuthorization(authorization)) {
            throw workflowError('HUMAN_REVOCATION_CONFLICT', 'Maintenance grant already has a different revocation tombstone.', ExitCode.conflict);
        }
        return current;
    }
    const at = authorization.payload.revokedAt;
    const next = withRecordDigest({
        ...withoutRecordDigest(current),
        state: 'revoked',
        updatedAt: at,
        revokedAt: at,
        revocationReason: authorization.payload.reason,
        revocationAuthorization: authorization,
    });
    replacePrivateFileAtomic(maintenanceGrantRecordPath(storageRoot, current.envelope.payload.grantId), `${canonicalJson(next)}\n`);
    return deepFreeze(structuredClone(next));
}
export function terminalizeExpiredMaintenanceGrantForParent(storageRoot, parentChangeId, now) {
    const current = readMaintenanceGrantForParent(storageRoot, parentChangeId);
    if (current.state !== 'available')
        return current;
    const observedAt = exactDate(now).getTime();
    const expiresAt = Date.parse(current.envelope.payload.expiresAt);
    if (!Number.isFinite(expiresAt))
        throw maintenanceRecordCorrupt();
    if (observedAt < expiresAt)
        return current;
    const terminalAt = new Date(expiresAt).toISOString();
    const next = withRecordDigest({
        ...withoutRecordDigest(current),
        state: 'expired',
        updatedAt: terminalAt,
        expiredAt: terminalAt,
    });
    replacePrivateFileAtomic(maintenanceGrantRecordPath(storageRoot, current.envelope.payload.grantId), `${canonicalJson(next)}\n`);
    return deepFreeze(structuredClone(next));
}
export function persistInterventionEngineArtifact(storageRoot, input) {
    const intervention = readPersistedIntervention(storageRoot, input.parentChangeId);
    const artifact = verifyArtifact(input.artifact);
    if (artifact.sourceChangeId !== intervention.relationship.interventionChangeId) {
        throw workflowError('INTERVENTION_ENGINE_ARTIFACT_BINDING_MISMATCH', 'Engine artifact was not produced by the persisted intervention.', ExitCode.verification);
    }
    const executablePath = verifyArtifactExecutable(intervention.childWorkspace.childWorkspacePath, input.executablePath, artifact.executableDigest);
    const record = withRecordDigest({
        kind: 'persisted-intervention-engine-artifact.v1',
        parentChangeId: input.parentChangeId,
        interventionChangeId: intervention.relationship.interventionChangeId,
        checkpointId: intervention.checkpoint.checkpointId,
        artifact,
        executablePath,
        createdAt: exactDate(input.now).toISOString(),
    });
    const paths = maintenancePaths(storageRoot);
    ensurePrivateDirectory(paths.artifacts);
    const target = interventionArtifactRecordPath(storageRoot, artifact.artifactId);
    if (fs.existsSync(target)) {
        const existing = readInterventionEngineArtifact(storageRoot, artifact.artifactId);
        if (canonicalJson(existing) !== canonicalJson(record)) {
            throw workflowError('INTERVENTION_ENGINE_ARTIFACT_CONFLICT', 'Artifact id is already bound to different intervention bytes.', ExitCode.conflict);
        }
        return existing;
    }
    createPrivateFileExclusive(target, `${canonicalJson(record)}\n`);
    return deepFreeze(structuredClone(record));
}
export function readInterventionEngineArtifact(storageRoot, artifactId) {
    assertDigest(artifactId, 'INTERVENTION_ENGINE_ARTIFACT_INVALID');
    const value = readCanonicalPrivateFile(interventionArtifactRecordPath(storageRoot, artifactId), 'INTERVENTION_ENGINE_ARTIFACT_NOT_FOUND');
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'artifact',
            'checkpointId',
            'createdAt',
            'executablePath',
            'interventionChangeId',
            'kind',
            'parentChangeId',
            'recordDigest',
        ]) ||
        value.kind !== 'persisted-intervention-engine-artifact.v1' ||
        !verifyRecordDigest(value)) {
        throw artifactRecordCorrupt();
    }
    const record = value;
    const intervention = readPersistedIntervention(storageRoot, record.parentChangeId);
    const artifact = verifyArtifact(record.artifact);
    if (artifact.artifactId !== artifactId ||
        record.interventionChangeId !==
            intervention.relationship.interventionChangeId ||
        record.checkpointId !== intervention.checkpoint.checkpointId) {
        throw artifactRecordCorrupt();
    }
    verifyArtifactExecutable(intervention.childWorkspace.childWorkspacePath, record.executablePath, artifact.executableDigest);
    return deepFreeze(structuredClone({ ...record, artifact }));
}
function interventionSourceDigest(childWorkspacePath) {
    const changed = runGit(childWorkspacePath, [
        'diff',
        '--name-only',
        '--no-renames',
        '-z',
        'HEAD',
        '--',
    ]);
    const untracked = runGit(childWorkspacePath, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
    ]);
    const paths = [
        ...new Set([...splitNul(changed), ...splitNul(untracked)]),
    ].sort();
    let totalBytes = 0;
    const entries = paths.map((relativePath) => {
        assertMaintenanceScopedRelativePath(relativePath);
        const target = path.join(childWorkspacePath, relativePath);
        const stats = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stats) {
            return { path: relativePath, kind: 'deleted' };
        }
        if (!stats.isFile() ||
            stats.isSymbolicLink() ||
            stats.nlink !== 1 ||
            stats.size > MAX_EXECUTABLE_BYTES) {
            throw workflowError('INTERVENTION_ENGINE_BUILD_SOURCE_UNSAFE', `Engine source snapshot contains an unsafe entry: ${relativePath}`, ExitCode.unsafeEnvironment);
        }
        totalBytes += stats.size;
        if (totalBytes > MAX_SOURCE_SNAPSHOT_BYTES) {
            throw workflowError('INTERVENTION_ENGINE_BUILD_SOURCE_TOO_LARGE', 'Engine source snapshot exceeds the bounded build limit.', ExitCode.guard);
        }
        return {
            path: relativePath,
            kind: 'file',
            mode: (stats.mode & 0o111) === 0 ? '100644' : '100755',
            contentDigest: digest(fs.readFileSync(target)),
        };
    });
    const head = runGit(childWorkspacePath, ['rev-parse', 'HEAD']).trim();
    return digest(canonicalJson({
        kind: 'intervention-engine-source-snapshot.v1',
        head,
        entries,
    }));
}
function assertScopedChildArtifactPath(childWorkspacePath, requestedPath) {
    if (typeof requestedPath !== 'string' ||
        !path.isAbsolute(requestedPath) ||
        path.resolve(requestedPath) !== requestedPath) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_PATH_INVALID', 'Engine executable path must be exact, normalized, and absolute.', ExitCode.usage);
    }
    const childRoot = fs.realpathSync(childWorkspacePath);
    const relativePath = path.relative(childRoot, requestedPath);
    if (relativePath.length === 0 ||
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath)) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_PATH_OUTSIDE_SCOPE', 'Engine executable must stay inside the reserved child worktree.', ExitCode.guard);
    }
    assertMaintenanceScopedRelativePath(relativePath);
    return requestedPath;
}
function assertMaintenanceScopedRelativePath(relativePath) {
    const normalized = relativePath.split(path.sep).join('/');
    if (normalized !== relativePath ||
        normalized.length === 0 ||
        normalized.startsWith('/') ||
        normalized.split('/').some((part) => part === '' || part === '..') ||
        (!normalized.startsWith('packages/workflow-engine/') &&
            !normalized.startsWith('packages/harness-runtime/'))) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_SCOPE_VIOLATION', `Engine build changed a path outside the signed maintenance scope: ${relativePath}`, ExitCode.guard);
    }
}
function readBoundedArtifactSource(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        stats.size < 1 ||
        stats.size > MAX_EXECUTABLE_BYTES ||
        fs.realpathSync(filePath) !== filePath) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_EXECUTABLE_UNSAFE', 'Candidate engine must be a bounded canonical single-link executable.', ExitCode.unsafeEnvironment);
    }
    return fs.readFileSync(filePath);
}
function runArtifactProbe(executablePath, mode) {
    const result = spawnSync(executablePath, [mode], {
        cwd: path.dirname(executablePath),
        encoding: 'utf8',
        timeout: ENGINE_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            LANG: 'C',
            LC_ALL: 'C',
            TMPDIR: path.dirname(executablePath),
        },
    });
    if (result.error ||
        result.status !== 0 ||
        typeof result.stdout !== 'string') {
        throw workflowError('INTERVENTION_ENGINE_BUILD_SMOKE_FAILED', `Candidate engine ${mode} command failed.`, ExitCode.verification);
    }
    let value;
    try {
        value = JSON.parse(result.stdout);
    }
    catch {
        throw workflowError('INTERVENTION_ENGINE_BUILD_SMOKE_INVALID', `Candidate engine ${mode} output is not JSON.`, ExitCode.verification);
    }
    if (!isRecord(value)) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_SMOKE_INVALID', `Candidate engine ${mode} output must be an object.`, ExitCode.verification);
    }
    return value;
}
function splitNul(value) {
    if (value.length === 0)
        return [];
    if (!value.endsWith('\0')) {
        throw workflowError('INTERVENTION_ENGINE_BUILD_GIT_OUTPUT_INVALID', 'Git source snapshot output was not NUL terminated.', ExitCode.verification);
    }
    return value.slice(0, -1).split('\0');
}
function maintenancePaths(storageRoot) {
    const root = interventionControlPersistencePaths(storageRoot).root;
    return {
        grants: path.join(root, 'maintenance-grants'),
        artifacts: path.join(root, 'intervention-engine-artifacts'),
    };
}
function maintenanceGrantRecordPath(storageRoot, grantId) {
    assertNonEmpty(grantId, 'MAINTENANCE_GRANT_RECORD_INVALID');
    const name = crypto
        .createHash('sha256')
        .update(`maintenance-record\0${grantId}`)
        .digest('hex');
    return path.join(maintenancePaths(storageRoot).grants, `${name}.json`);
}
function interventionArtifactRecordPath(storageRoot, artifactId) {
    assertDigest(artifactId, 'INTERVENTION_ENGINE_ARTIFACT_INVALID');
    return path.join(maintenancePaths(storageRoot).artifacts, `${artifactId.slice('sha256:'.length)}.json`);
}
function verifyArtifact(artifact) {
    const rebuilt = createEngineArtifact(artifact);
    if (rebuilt.artifactId !== artifact.artifactId)
        throw artifactRecordCorrupt();
    return rebuilt;
}
function verifyArtifactExecutable(childWorkspacePath, requestedPath, expectedDigest) {
    const childRoot = fs.realpathSync(childWorkspacePath);
    const executablePath = path.resolve(requestedPath);
    const relative = path.relative(childRoot, executablePath);
    const stats = fs.lstatSync(executablePath, { throwIfNoEntry: false });
    if (relative.length === 0 ||
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        stats.size < 1 ||
        stats.size > MAX_EXECUTABLE_BYTES ||
        digest(fs.readFileSync(executablePath)) !== expectedDigest) {
        throw workflowError('INTERVENTION_ENGINE_ARTIFACT_DRIFT', 'Persisted engine artifact executable is missing, unsafe, or changed.', ExitCode.verification);
    }
    return fs.realpathSync(executablePath);
}
function ensurePrivateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
        throw workflowError('INTERVENTION_MAINTENANCE_STORAGE_UNSAFE', 'Maintenance records require private plain directories.', ExitCode.unsafeEnvironment);
    }
}
function createPrivateFileExclusive(filePath, content) {
    const descriptor = fs.openSync(filePath, fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    try {
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function replacePrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    createPrivateFileExclusive(temporary, content);
    fs.renameSync(temporary, filePath);
}
function readCanonicalPrivateFile(filePath, notFoundCode) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats) {
        throw workflowError(notFoundCode, 'Persisted maintenance record was not found.', ExitCode.conflict);
    }
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== PRIVATE_FILE_MODE ||
        stats.size < 1 ||
        stats.size > MAX_RECORD_BYTES) {
        throw maintenanceRecordCorrupt();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        throw maintenanceRecordCorrupt();
    }
    if (`${canonicalJson(value)}\n` !== raw)
        throw maintenanceRecordCorrupt();
    return value;
}
function withRecordDigest(value) {
    return { ...value, recordDigest: digest(canonicalJson(value)) };
}
function verifyRecordDigest(value) {
    const { recordDigest, ...payload } = value;
    return (typeof recordDigest === 'string' &&
        digest(canonicalJson(payload)) === recordDigest);
}
function withoutRecordDigest(value) {
    const { recordDigest: _recordDigest, ...payload } = value;
    return payload;
}
function exactDate(value) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw workflowError('INTERVENTION_MAINTENANCE_TIME_INVALID', 'Maintenance record time is invalid.', ExitCode.guard);
    }
    return new Date(value.getTime());
}
function loadCurrentMaintainerPolicy(repositoryRoot) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            'HEAD:workflow/maintainer-policy.json',
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error)
            throw error;
        throw workflowError('MAINTAINER_POLICY_INVALID', 'The current HEAD does not contain a valid maintainer policy.', ExitCode.guard);
    }
}
function assertMaintenanceRevocationAuthorization(value, grantId, reason, revokedAt) {
    const authorization = assertHumanRevocationAuthorization(value);
    if (authorization.payload.subjectKind !== 'harness-maintenance-grant' ||
        authorization.payload.grantId !== grantId ||
        authorization.payload.reason !== reason ||
        authorization.payload.revokedAt !== revokedAt) {
        throw maintenanceRecordCorrupt();
    }
    return authorization;
}
function digest(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
function assertDigest(value, code) {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw workflowError(code, 'Expected a SHA-256 digest.', ExitCode.guard);
    }
}
function assertNonEmpty(value, code) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.trim() !== value) {
        throw workflowError(code, 'Expected a non-empty exact string.', ExitCode.guard);
    }
}
function assertAuditBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['externalAuditRoot', 'repositoryId']) ||
        typeof value.externalAuditRoot !== 'string' ||
        !path.isAbsolute(value.externalAuditRoot) ||
        path.normalize(value.externalAuditRoot) !== value.externalAuditRoot) {
        throw workflowError('MAINTENANCE_GRANT_AUDIT_BINDING_INVALID', 'Maintenance grant requires an exact absolute authority-audit root.', ExitCode.guard);
    }
    assertDigest(value.repositoryId, 'MAINTENANCE_GRANT_AUDIT_BINDING_INVALID');
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()));
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function maintenanceRecordCorrupt(message = 'Persisted maintenance grant failed integrity verification.') {
    return workflowError('MAINTENANCE_GRANT_RECORD_CORRUPT', message, ExitCode.verification);
}
function artifactRecordCorrupt() {
    return workflowError('INTERVENTION_ENGINE_ARTIFACT_RECORD_CORRUPT', 'Persisted intervention engine artifact failed integrity verification.', ExitCode.verification);
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
