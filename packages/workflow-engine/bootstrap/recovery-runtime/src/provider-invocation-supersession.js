import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { projectProviderInvocationExecution } from './execution-core.js';
import { ExitCode, WorkflowError } from './errors.js';
import { assertPrivateInvestigationDirectory, createPrivateCanonicalJson, privatePathExists, readPrivateCanonicalJson, withPrivateRuntimeLock, } from './investigation-session-store.js';
import { assertInvocationId } from './paths.js';
import { providerRetentionArtifact, readCompleteProviderRetentionReceipt, } from './provider-retention-receipt.js';
import { assertProviderInvocationSupersessionTransaction, createProviderInvocationEvidenceSnapshot, createProviderInvocationSupersessionEdge, createProviderInvocationSupersessionIndex, createProviderInvocationSupersessionReceipt, createProviderInvocationSupersessionTransaction, createProviderInvocationSupersessionTransactionPointer, inspectProviderInvocationSupersessionRelations, providerInvocationSupersessionConflict, providerInvocationSupersessionEdgePath, providerInvocationSupersessionPredecessorIndexPath, providerInvocationSupersessionReceiptPath, providerInvocationSupersessionPaths, providerInvocationSupersessionSuccessorIndexPath, providerInvocationSupersessionTransactionPath, providerInvocationSupersessionTransactionPointerPath, providerInvocationSupersessionUnsafe, } from './provider-invocation-supersession-schema.js';
const MAX_EVIDENCE_ARTIFACT_BYTES = 1_048_576;
const MAX_SUPERSESSION_TRANSACTIONS = 4_096;
const TRANSACTION_FILE = /^[0-9a-f]{64}\.json$/;
export class SimulatedProviderInvocationSupersessionCrash extends WorkflowError {
    phase;
    constructor(phase) {
        super({
            code: 'PROVIDER_INVOCATION_SUPERSESSION_SIMULATED_CRASH',
            message: `Simulated provider invocation supersession crash after ${phase}.`,
            exitCode: ExitCode.internal,
        });
        this.phase = phase;
    }
}
export function prepareProviderInvocationSupersession(paths, input) {
    const successor = projectProviderInvocationExecution({
        record: input.successorRecord,
        request: input.successorRequest,
    });
    const predecessors = input.history
        .map((entry) => ({
        ...entry,
        projection: projectProviderInvocationExecution(entry),
    }))
        .filter(({ record, projection }) => record.attempt === input.successorRecord.attempt - 1 &&
        projection.job.jobId === successor.job.jobId);
    if (predecessors.length === 0)
        return null;
    if (predecessors.length !== 1)
        throw providerInvocationSupersessionUnsafe();
    const predecessor = predecessors[0];
    if (predecessor.record.state !== 'failed' ||
        predecessor.projection.attempt.failure === null) {
        // Adjacent Attempt numbers can also be concurrent race/hedge Attempts.
        // Only a terminal failed predecessor establishes replacement semantics.
        return null;
    }
    if (Date.parse(input.successorRecord.createdAt) <
        Date.parse(predecessor.record.updatedAt)) {
        // A later-numbered Attempt may have been reserved as a concurrent hedge.
        // It cannot truthfully replace a failure that had not happened yet.
        return null;
    }
    if (successor.attempt.attemptNumber !==
        predecessor.projection.attempt.attemptNumber + 1 ||
        successor.workflow.workflowId !==
            predecessor.projection.workflow.workflowId ||
        successor.job.epoch !== predecessor.projection.job.epoch ||
        successor.job.contextDigest !== predecessor.projection.job.contextDigest ||
        successor.job.requestDigest !== predecessor.projection.job.requestDigest) {
        throw providerInvocationSupersessionUnsafe();
    }
    const predecessorInvocationId = predecessor.record.invocationId;
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${predecessorInvocationId}.supersession.lock`), () => {
        const transactionPath = providerInvocationSupersessionTransactionPath(paths, predecessorInvocationId);
        if (privatePathExists(paths, transactionPath, providerInvocationSupersessionUnsafe)) {
            const existingTransaction = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, transactionPath, providerInvocationSupersessionUnsafe));
            if (existingTransaction.successorInvocationId !==
                input.successorRecord.invocationId) {
                throw providerInvocationSupersessionConflict();
            }
            createPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPointerPath(paths, input.successorRecord.invocationId), createProviderInvocationSupersessionTransactionPointer({
                schemaVersion: 1,
                kind: 'provider-invocation-supersession-transaction-pointer',
                predecessorInvocationId,
                successorInvocationId: input.successorRecord.invocationId,
                transactionDigest: existingTransaction.transactionDigest,
            }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
            return existingTransaction;
        }
        const existing = inspectRelations(paths, predecessorInvocationId);
        if (existing.supersededBy !== null) {
            if (existing.supersededBy.supersededBy.invocationId !==
                input.successorRecord.invocationId) {
                throw providerInvocationSupersessionConflict();
            }
            return readTransactionForSuccessor(paths, input.successorRecord.invocationId);
        }
        const replacementOf = currentEvidenceSnapshot(paths, predecessor.record, predecessor.request);
        if (replacementOf.terminalStatus !== 'failed') {
            throw providerInvocationSupersessionUnsafe();
        }
        const supersededBy = currentEvidenceSnapshot(paths, input.successorRecord, input.successorRequest);
        if (supersededBy.terminalStatus !== null) {
            throw providerInvocationSupersessionUnsafe();
        }
        const edge = createProviderInvocationSupersessionEdge({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-edge',
            workflowId: predecessor.projection.workflow.workflowId,
            jobId: predecessor.projection.job.jobId,
            epoch: predecessor.projection.job.epoch,
            contextDigest: predecessor.projection.job.contextDigest,
            replacementMode: input.replacementMode,
            previousEdgeDigest: existing.replacementOf?.edgeDigest ?? null,
            replacementOf,
            supersededBy,
            createdAt: input.successorRecord.createdAt,
        });
        const transaction = createProviderInvocationSupersessionTransaction({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-transaction',
            predecessorInvocationId,
            successorInvocationId: input.successorRecord.invocationId,
            edge,
            preparedAt: input.successorRecord.createdAt,
        });
        const pointer = createProviderInvocationSupersessionTransactionPointer({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-transaction-pointer',
            predecessorInvocationId,
            successorInvocationId: input.successorRecord.invocationId,
            transactionDigest: transaction.transactionDigest,
        });
        createPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPath(paths, predecessorInvocationId), transaction, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'transaction-written');
        createPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPointerPath(paths, input.successorRecord.invocationId), pointer, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'transaction-prepared');
        return readTransactionForSuccessor(paths, input.successorRecord.invocationId);
    }, 'PROVIDER_INVOCATION_SUPERSESSION_OPERATION_CONFLICT', providerInvocationSupersessionUnsafe);
}
/**
 * Resume a creation transaction before the ordinary lifecycle scan. A
 * half-published supersession intentionally makes both endpoints fail closed,
 * so retrying creation must use the bounded WAL lookup instead of asking the
 * scanner to treat that state as ordinary history.
 */
export function resumePreparedProviderInvocationSupersession(paths, successorRecord, successorRequest) {
    const successorInvocationId = assertInvocationId(successorRecord.invocationId);
    const pointerPath = providerInvocationSupersessionTransactionPointerPath(paths, successorInvocationId);
    if (privatePathExists(paths, pointerPath, providerInvocationSupersessionUnsafe)) {
        return assertPreparedSuccessorBinding(readTransactionForSuccessor(paths, successorInvocationId), successorRecord, successorRequest);
    }
    const transactionDirectory = providerInvocationSupersessionPaths(paths).transactionsByPredecessor;
    if (!fs.lstatSync(transactionDirectory, { throwIfNoEntry: false })) {
        return null;
    }
    assertPrivateInvestigationDirectory(paths, transactionDirectory, providerInvocationSupersessionUnsafe);
    const entries = fs
        .readdirSync(transactionDirectory, { withFileTypes: true })
        .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    if (entries.length > MAX_SUPERSESSION_TRANSACTIONS) {
        throw providerInvocationSupersessionUnsafe();
    }
    let candidate = null;
    for (const entry of entries) {
        if (!entry.isFile() ||
            entry.isSymbolicLink() ||
            !TRANSACTION_FILE.test(entry.name)) {
            throw providerInvocationSupersessionUnsafe();
        }
        const transaction = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, path.join(transactionDirectory, entry.name), providerInvocationSupersessionUnsafe));
        if (transaction.successorInvocationId !== successorInvocationId)
            continue;
        if (candidate !== null)
            throw providerInvocationSupersessionConflict();
        candidate = transaction;
    }
    if (candidate === null)
        return null;
    const admitted = assertPreparedSuccessorBinding(candidate, successorRecord, successorRequest);
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${admitted.predecessorInvocationId}.supersession.lock`), () => {
        const durable = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPath(paths, admitted.predecessorInvocationId), providerInvocationSupersessionUnsafe));
        if (canonicalJson(durable) !== canonicalJson(admitted)) {
            throw providerInvocationSupersessionUnsafe();
        }
        createPrivateCanonicalJson(paths, pointerPath, createProviderInvocationSupersessionTransactionPointer({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-transaction-pointer',
            predecessorInvocationId: admitted.predecessorInvocationId,
            successorInvocationId,
            transactionDigest: admitted.transactionDigest,
        }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        return readTransactionForSuccessor(paths, successorInvocationId);
    }, 'PROVIDER_INVOCATION_SUPERSESSION_OPERATION_CONFLICT', providerInvocationSupersessionUnsafe);
}
function assertPreparedSuccessorBinding(transaction, successorRecord, successorRequest) {
    const admitted = assertProviderInvocationSupersessionTransaction(transaction);
    const snapshot = admitted.edge.supersededBy;
    if (admitted.successorInvocationId !== successorRecord.invocationId ||
        snapshot.invocationId !== successorRecord.invocationId ||
        snapshot.attempt !== successorRecord.attempt ||
        snapshot.requestDigest !== successorRecord.requestDigest ||
        snapshot.manifestDigest !== successorRecord.manifestDigest ||
        snapshot.subjectDigest !== successorRequest.targetDigest ||
        snapshot.createdAt !== admitted.edge.createdAt ||
        admitted.preparedAt !== admitted.edge.createdAt ||
        snapshot.promptDigest !== null ||
        snapshot.rawOutputDigest !== null ||
        snapshot.semanticOutputDigest !== null ||
        snapshot.terminalStatus !== null ||
        snapshot.terminalAt !== null ||
        snapshot.failureCode !== null ||
        snapshot.legacyRevision !== 0) {
        throw providerInvocationSupersessionUnsafe();
    }
    return admitted;
}
export function finalizeProviderInvocationSupersession(paths, transaction, readCore, input) {
    const admitted = assertProviderInvocationSupersessionTransaction(transaction);
    if (!isTimestamp(input.publishedAt)) {
        throw providerInvocationSupersessionUnsafe();
    }
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `${admitted.predecessorInvocationId}.supersession.lock`), () => {
        const durable = readTransactionForSuccessor(paths, admitted.successorInvocationId);
        if (canonicalJson(durable) !== canonicalJson(admitted)) {
            throw providerInvocationSupersessionUnsafe();
        }
        const receiptPath = providerInvocationSupersessionReceiptPath(paths, admitted.transactionDigest);
        if (privatePathExists(paths, receiptPath, providerInvocationSupersessionUnsafe)) {
            const relations = inspectRelations(paths, admitted.successorInvocationId);
            if (relations.replacementOf?.edgeDigest !== admitted.edge.edgeDigest) {
                throw providerInvocationSupersessionUnsafe();
            }
            assertEdgeCurrent(paths, admitted.edge, readCore);
            return deepFreeze({ edge: admitted.edge, replayed: true });
        }
        assertEdgeCurrent(paths, admitted.edge, readCore);
        createPrivateCanonicalJson(paths, providerInvocationSupersessionEdgePath(paths, admitted.edge.edgeDigest), admitted.edge, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'edge-written');
        createPrivateCanonicalJson(paths, providerInvocationSupersessionPredecessorIndexPath(paths, admitted.predecessorInvocationId), createProviderInvocationSupersessionIndex({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-index',
            role: 'superseded-by',
            invocationId: admitted.predecessorInvocationId,
            peerInvocationId: admitted.successorInvocationId,
            edgeDigest: admitted.edge.edgeDigest,
            transactionDigest: admitted.transactionDigest,
        }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'predecessor-indexed');
        createPrivateCanonicalJson(paths, providerInvocationSupersessionSuccessorIndexPath(paths, admitted.successorInvocationId), createProviderInvocationSupersessionIndex({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-index',
            role: 'replacement-of',
            invocationId: admitted.successorInvocationId,
            peerInvocationId: admitted.predecessorInvocationId,
            edgeDigest: admitted.edge.edgeDigest,
            transactionDigest: admitted.transactionDigest,
        }), providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        simulateCrash(input.simulateCrashAfter, 'successor-indexed');
        const receipt = createProviderInvocationSupersessionReceipt({
            schemaVersion: 1,
            kind: 'provider-invocation-supersession-receipt',
            predecessorInvocationId: admitted.predecessorInvocationId,
            successorInvocationId: admitted.successorInvocationId,
            edgeDigest: admitted.edge.edgeDigest,
            transactionDigest: admitted.transactionDigest,
            publishedAt: input.publishedAt,
        });
        createPrivateCanonicalJson(paths, receiptPath, receipt, providerInvocationSupersessionUnsafe, 'PROVIDER_INVOCATION_SUPERSESSION_CONFLICT');
        inspectRelations(paths, admitted.predecessorInvocationId);
        inspectRelations(paths, admitted.successorInvocationId);
        return deepFreeze({ edge: admitted.edge, replayed: false });
    }, 'PROVIDER_INVOCATION_SUPERSESSION_OPERATION_CONFLICT', providerInvocationSupersessionUnsafe);
}
export function recoverProviderInvocationSupersessionTransaction(paths, requestedSuccessorInvocationId, readCore, input) {
    const successorInvocationId = assertInvocationId(requestedSuccessorInvocationId);
    return finalizeProviderInvocationSupersession(paths, readTransactionForSuccessor(paths, successorInvocationId), readCore, { publishedAt: input.recoveredAt });
}
export function readProviderInvocationEvidenceRecord(paths, record, request, readCore) {
    const relations = inspectRelations(paths, record.invocationId);
    assertRelationsCurrent(paths, record, request, relations, readCore);
    const fallback = relations.supersededBy?.replacementOf ??
        relations.replacementOf?.supersededBy;
    const invocation = currentEvidenceSnapshot(paths, record, request, fallback);
    return deepFreeze({
        invocation,
        replacementOf: relations.replacementOf === null
            ? null
            : {
                edgeDigest: relations.replacementOf.edgeDigest,
                replacementMode: relations.replacementOf.replacementMode,
                invocation: relations.replacementOf.replacementOf,
            },
        supersededBy: relations.supersededBy === null
            ? null
            : {
                edgeDigest: relations.supersededBy.edgeDigest,
                replacementMode: relations.supersededBy.replacementMode,
                invocation: relations.supersededBy.supersededBy,
            },
    });
}
export function assertProviderInvocationSupersessionEndpointCurrent(paths, record, request, readCore) {
    const relations = inspectRelations(paths, record.invocationId);
    assertRelationsCurrent(paths, record, request, relations, readCore);
}
function assertRelationsCurrent(paths, record, request, relations, readCore) {
    if (relations.supersededBy !== null &&
        relations.supersededBy.previousEdgeDigest !==
            (relations.replacementOf?.edgeDigest ?? null)) {
        throw providerInvocationSupersessionUnsafe();
    }
    if (relations.replacementOf !== null) {
        assertSnapshotStableCurrent(paths, relations.replacementOf.supersededBy, record, request, false);
        assertEdgeCurrent(paths, relations.replacementOf, readCore, record.invocationId);
    }
    if (relations.supersededBy !== null) {
        assertSnapshotStableCurrent(paths, relations.supersededBy.replacementOf, record, request, true);
        assertEdgeCurrent(paths, relations.supersededBy, readCore, record.invocationId);
    }
}
function assertEdgeCurrent(paths, edge, readCore, requiredInvocationId) {
    const readEndpoint = (invocationId) => {
        const exists = privatePathExists(paths, path.join(paths.invocations, invocationId, 'state.json'), providerInvocationSupersessionUnsafe);
        if (!exists) {
            if (requiredInvocationId === undefined ||
                requiredInvocationId === invocationId) {
                throw providerInvocationSupersessionUnsafe();
            }
            return null;
        }
        return readCore(invocationId);
    };
    const predecessor = readEndpoint(edge.replacementOf.invocationId);
    const successor = readEndpoint(edge.supersededBy.invocationId);
    const predecessorProjection = predecessor === null
        ? null
        : projectProviderInvocationExecution(predecessor);
    const successorProjection = successor === null ? null : projectProviderInvocationExecution(successor);
    if (predecessor !== null) {
        assertSnapshotStableCurrent(paths, edge.replacementOf, predecessor.record, predecessor.request, true);
    }
    if (successor !== null) {
        assertSnapshotStableCurrent(paths, edge.supersededBy, successor.record, successor.request, false);
    }
    if ((predecessorProjection !== null &&
        (predecessorProjection.workflow.workflowId !== edge.workflowId ||
            predecessorProjection.job.jobId !== edge.jobId ||
            predecessorProjection.job.epoch !== edge.epoch ||
            predecessorProjection.job.contextDigest !== edge.contextDigest)) ||
        (successorProjection !== null &&
            (successorProjection.workflow.workflowId !== edge.workflowId ||
                successorProjection.job.jobId !== edge.jobId ||
                successorProjection.job.epoch !== edge.epoch ||
                successorProjection.job.contextDigest !== edge.contextDigest)) ||
        (predecessorProjection !== null &&
            successorProjection !== null &&
            predecessorProjection.attempt.attemptNumber + 1 !==
                successorProjection.attempt.attemptNumber)) {
        throw providerInvocationSupersessionUnsafe();
    }
}
function assertSnapshotStableCurrent(paths, expected, record, request, terminalExact) {
    const current = currentEvidenceSnapshot(paths, record, request, expected);
    for (const key of [
        'invocationId',
        'attempt',
        'requestDigest',
        'manifestDigest',
        'subjectDigest',
        'createdAt',
    ]) {
        if (current[key] !== expected[key]) {
            throw providerInvocationSupersessionUnsafe();
        }
    }
    if (terminalExact &&
        (current.promptDigest !== expected.promptDigest ||
            current.rawOutputDigest !== expected.rawOutputDigest ||
            current.semanticOutputDigest !== expected.semanticOutputDigest ||
            current.terminalStatus !== expected.terminalStatus ||
            current.terminalAt !== expected.terminalAt ||
            current.failureCode !== expected.failureCode ||
            current.legacyRevision !== expected.legacyRevision)) {
        throw providerInvocationSupersessionUnsafe();
    }
    if (!terminalExact &&
        (expected.terminalStatus !== null ||
            expected.terminalAt !== null ||
            expected.failureCode !== null ||
            expected.legacyRevision !== 0)) {
        // The successor snapshot records its immutable prepared identity. Its
        // state/revision may advance after publication, but the snapshot itself
        // must never masquerade as terminal evidence.
        if (expected.terminalStatus !== null ||
            expected.terminalAt !== null ||
            expected.failureCode !== null ||
            expected.legacyRevision !== 0) {
            throw providerInvocationSupersessionUnsafe();
        }
    }
}
function currentEvidenceSnapshot(paths, record, request, retainedFallback) {
    const prompt = artifactDigest(paths, record, 'runtime/prompt.json');
    const raw = artifactDigest(paths, record, 'runtime/semantic-output.json');
    const observedSemanticOutputDigest = record.result !== null
        ? digestText(canonicalJson(record.result.output))
        : failedSemanticOutputDigest(paths, record);
    const semanticOutputDigest = observedSemanticOutputDigest === null &&
        retainedFallback !== undefined &&
        retainedFallback.rawOutputDigest === raw
        ? retainedFallback.semanticOutputDigest
        : observedSemanticOutputDigest;
    return createProviderInvocationEvidenceSnapshot({
        schemaVersion: 1,
        kind: 'provider-invocation-evidence-snapshot',
        invocationId: record.invocationId,
        attempt: record.attempt,
        requestDigest: record.requestDigest,
        manifestDigest: record.manifestDigest,
        subjectDigest: request.targetDigest,
        promptDigest: prompt,
        rawOutputDigest: raw,
        semanticOutputDigest,
        terminalStatus: record.state === 'succeeded' || record.state === 'failed'
            ? record.state
            : null,
        terminalAt: record.state === 'succeeded' || record.state === 'failed'
            ? record.updatedAt
            : null,
        failureCode: record.state === 'failed' ? record.failure.code : null,
        legacyRevision: record.revision,
        createdAt: record.createdAt,
    });
}
function failedSemanticOutputDigest(paths, record) {
    const evidencePath = path.join(paths.invocations, record.invocationId, 'repair-evidence.json');
    if (!privatePathExists(paths, evidencePath, providerInvocationSupersessionUnsafe)) {
        return null;
    }
    const value = readPrivateCanonicalJson(paths, evidencePath, providerInvocationSupersessionUnsafe);
    if (!isRecord(value) ||
        value.kind !== 'provider-repair-evidence' ||
        value.failedInvocationId !== record.invocationId ||
        !isRecord(value.repairContext) ||
        !Object.hasOwn(value.repairContext, 'previousOutput')) {
        throw providerInvocationSupersessionUnsafe();
    }
    return digestText(canonicalJson(value.repairContext.previousOutput));
}
function artifactDigest(paths, record, name) {
    const filePath = path.join(paths.invocations, record.invocationId, ...name.split('/'));
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (stats) {
        const content = readPrivateArtifact(paths, filePath);
        return content.byteLength === 0 ? null : digestBuffer(content);
    }
    if (record.state !== 'succeeded' && record.state !== 'failed')
        return null;
    const receipt = readCompleteProviderRetentionReceipt(paths, record.invocationId, {
        requestDigest: record.requestDigest,
        manifestDigest: record.manifestDigest,
        legacyRevision: record.revision,
        terminalState: record.state,
        terminalAt: record.updatedAt,
    });
    const retained = receipt === null ? null : providerRetentionArtifact(receipt, name);
    return retained === null || retained.bytes === 0 ? null : retained.digest;
}
function readPrivateArtifact(paths, filePath) {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!before ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > MAX_EVIDENCE_ARTIFACT_BYTES ||
        fs.realpathSync(filePath) !== path.resolve(filePath) ||
        !path.resolve(filePath).startsWith(`${path.resolve(paths.root)}${path.sep}`)) {
        throw providerInvocationSupersessionUnsafe();
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
    try {
        const opened = fs.fstatSync(descriptor);
        if (!sameFile(before, opened))
            throw providerInvocationSupersessionUnsafe();
        const content = fs.readFileSync(descriptor);
        const afterOpened = fs.fstatSync(descriptor);
        const afterPath = fs.lstatSync(filePath, { throwIfNoEntry: false });
        if (!afterPath ||
            !sameFile(opened, afterOpened) ||
            !sameFile(afterOpened, afterPath) ||
            opened.size !== content.byteLength ||
            opened.mtimeMs !== afterOpened.mtimeMs ||
            opened.ctimeMs !== afterOpened.ctimeMs) {
            throw providerInvocationSupersessionUnsafe();
        }
        return content;
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function sameFile(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.nlink === right.nlink &&
        (right.mode & 0o777) === 0o600);
}
function readTransactionForSuccessor(paths, requestedSuccessorInvocationId) {
    const successorInvocationId = assertInvocationId(requestedSuccessorInvocationId);
    const pointerValue = readPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPointerPath(paths, successorInvocationId), providerInvocationSupersessionUnsafe);
    const pointer = inspectRelationsPointer(pointerValue, successorInvocationId);
    const transaction = assertProviderInvocationSupersessionTransaction(readPrivateCanonicalJson(paths, providerInvocationSupersessionTransactionPath(paths, pointer.predecessorInvocationId), providerInvocationSupersessionUnsafe));
    if (transaction.transactionDigest !== pointer.transactionDigest ||
        transaction.successorInvocationId !== successorInvocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    return transaction;
}
function inspectRelationsPointer(value, successorInvocationId) {
    if (!isRecord(value) ||
        value.kind !== 'provider-invocation-supersession-transaction-pointer' ||
        value.successorInvocationId !== successorInvocationId ||
        typeof value.predecessorInvocationId !== 'string' ||
        typeof value.transactionDigest !== 'string') {
        throw providerInvocationSupersessionUnsafe();
    }
    return {
        predecessorInvocationId: assertInvocationId(value.predecessorInvocationId),
        transactionDigest: value.transactionDigest,
    };
}
function inspectRelations(paths, invocationId) {
    return inspectProviderInvocationSupersessionRelations(paths, invocationId, {
        exists: (filePath) => privatePathExists(paths, filePath, providerInvocationSupersessionUnsafe),
        read: (filePath) => readPrivateCanonicalJson(paths, filePath, providerInvocationSupersessionUnsafe),
    });
}
function simulateCrash(selected, phase) {
    if (selected === phase) {
        throw new SimulatedProviderInvocationSupersessionCrash(phase);
    }
}
function digestBuffer(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function digestText(value) {
    return digestBuffer(Buffer.from(value, 'utf8'));
}
function isTimestamp(value) {
    return (Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function deepFreeze(value) {
    if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
        return value;
    }
    Object.freeze(value);
    for (const child of Object.values(value))
        deepFreeze(child);
    return value;
}
