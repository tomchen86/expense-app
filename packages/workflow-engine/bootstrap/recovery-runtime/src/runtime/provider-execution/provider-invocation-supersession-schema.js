import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertInvocationId, } from "../session-workspace/paths.js";
const DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/;
const FILE_DIGEST = /^[0-9a-f]{64}$/;
export function providerInvocationSupersessionPaths(paths) {
    const root = path.join(paths.root, 'provider-invocation-supersessions');
    return {
        root,
        edges: path.join(root, 'edges'),
        byPredecessor: path.join(root, 'by-predecessor'),
        bySuccessor: path.join(root, 'by-successor'),
        transactionsByPredecessor: path.join(root, 'transactions', 'by-predecessor'),
        transactionsBySuccessor: path.join(root, 'transactions', 'by-successor'),
        receipts: path.join(root, 'receipts'),
    };
}
export function providerInvocationSupersessionTransactionPath(paths, predecessorInvocationId) {
    return path.join(providerInvocationSupersessionPaths(paths).transactionsByPredecessor, `${identityFileName(predecessorInvocationId)}.json`);
}
export function providerInvocationSupersessionTransactionPointerPath(paths, successorInvocationId) {
    return path.join(providerInvocationSupersessionPaths(paths).transactionsBySuccessor, `${identityFileName(successorInvocationId)}.json`);
}
export function providerInvocationSupersessionEdgePath(paths, edgeDigest) {
    return path.join(providerInvocationSupersessionPaths(paths).edges, `${assertDigest(edgeDigest)}.json`);
}
export function providerInvocationSupersessionPredecessorIndexPath(paths, predecessorInvocationId) {
    return path.join(providerInvocationSupersessionPaths(paths).byPredecessor, `${identityFileName(predecessorInvocationId)}.json`);
}
export function providerInvocationSupersessionSuccessorIndexPath(paths, successorInvocationId) {
    return path.join(providerInvocationSupersessionPaths(paths).bySuccessor, `${identityFileName(successorInvocationId)}.json`);
}
export function providerInvocationSupersessionReceiptPath(paths, transactionDigest) {
    return path.join(providerInvocationSupersessionPaths(paths).receipts, `${assertDigest(transactionDigest)}.json`);
}
export function createProviderInvocationEvidenceSnapshot(input) {
    return assertProviderInvocationEvidenceSnapshot({
        ...input,
        evidenceDigest: digestCanonical(input),
    });
}
export function createProviderInvocationSupersessionEdge(input) {
    return assertProviderInvocationSupersessionEdge({
        ...input,
        edgeDigest: digestCanonical(input),
    });
}
export function createProviderInvocationSupersessionTransaction(input) {
    return assertProviderInvocationSupersessionTransaction({
        ...input,
        transactionDigest: digestCanonical(input),
    });
}
export function createProviderInvocationSupersessionTransactionPointer(input) {
    return assertProviderInvocationSupersessionTransactionPointer({
        ...input,
        pointerDigest: digestCanonical(input),
    });
}
export function createProviderInvocationSupersessionIndex(input) {
    return assertProviderInvocationSupersessionIndex({
        ...input,
        indexDigest: digestCanonical(input),
    });
}
export function createProviderInvocationSupersessionReceipt(input) {
    return assertProviderInvocationSupersessionReceipt({
        ...input,
        receiptDigest: digestCanonical(input),
    });
}
export function inspectProviderInvocationSupersessionRelations(paths, requestedInvocationId, access) {
    const invocationId = assertInvocationId(requestedInvocationId);
    const predecessorTransactionPath = providerInvocationSupersessionTransactionPath(paths, invocationId);
    const predecessorIndexPath = providerInvocationSupersessionPredecessorIndexPath(paths, invocationId);
    const successorPointerPath = providerInvocationSupersessionTransactionPointerPath(paths, invocationId);
    const successorIndexPath = providerInvocationSupersessionSuccessorIndexPath(paths, invocationId);
    const predecessorTransaction = access.exists(predecessorTransactionPath)
        ? assertProviderInvocationSupersessionTransaction(access.read(predecessorTransactionPath))
        : null;
    if (predecessorTransaction === null && access.exists(predecessorIndexPath)) {
        throw providerInvocationSupersessionUnsafe();
    }
    if (predecessorTransaction !== null &&
        predecessorTransaction.predecessorInvocationId !== invocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    const successorPointer = access.exists(successorPointerPath)
        ? assertProviderInvocationSupersessionTransactionPointer(access.read(successorPointerPath))
        : null;
    if (successorPointer === null && access.exists(successorIndexPath)) {
        throw providerInvocationSupersessionUnsafe();
    }
    if (successorPointer !== null &&
        successorPointer.successorInvocationId !== invocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    const outgoing = predecessorTransaction === null
        ? null
        : readCompleteProviderInvocationSupersession(paths, predecessorTransaction, access);
    let incoming = null;
    if (successorPointer !== null) {
        const transactionPath = providerInvocationSupersessionTransactionPath(paths, successorPointer.predecessorInvocationId);
        if (!access.exists(transactionPath)) {
            throw providerInvocationSupersessionUnsafe();
        }
        const transaction = assertProviderInvocationSupersessionTransaction(access.read(transactionPath));
        if (transaction.transactionDigest !== successorPointer.transactionDigest ||
            transaction.successorInvocationId !== invocationId ||
            transaction.predecessorInvocationId !==
                successorPointer.predecessorInvocationId) {
            throw providerInvocationSupersessionUnsafe();
        }
        incoming = readCompleteProviderInvocationSupersession(paths, transaction, access);
    }
    return deepFreeze({ replacementOf: incoming, supersededBy: outgoing });
}
function readCompleteProviderInvocationSupersession(paths, transaction, access) {
    const receiptPath = providerInvocationSupersessionReceiptPath(paths, transaction.transactionDigest);
    if (!access.exists(receiptPath)) {
        throw providerInvocationSupersessionRecoveryRequired();
    }
    const receipt = assertProviderInvocationSupersessionReceipt(access.read(receiptPath));
    const edgePath = providerInvocationSupersessionEdgePath(paths, transaction.edge.edgeDigest);
    const predecessorIndexPath = providerInvocationSupersessionPredecessorIndexPath(paths, transaction.predecessorInvocationId);
    const successorIndexPath = providerInvocationSupersessionSuccessorIndexPath(paths, transaction.successorInvocationId);
    const successorPointerPath = providerInvocationSupersessionTransactionPointerPath(paths, transaction.successorInvocationId);
    if (!access.exists(edgePath) ||
        !access.exists(predecessorIndexPath) ||
        !access.exists(successorIndexPath) ||
        !access.exists(successorPointerPath)) {
        throw providerInvocationSupersessionUnsafe();
    }
    const edge = assertProviderInvocationSupersessionEdge(access.read(edgePath));
    const predecessorIndex = assertProviderInvocationSupersessionIndex(access.read(predecessorIndexPath));
    const successorIndex = assertProviderInvocationSupersessionIndex(access.read(successorIndexPath));
    const successorPointer = assertProviderInvocationSupersessionTransactionPointer(access.read(successorPointerPath));
    if (canonicalJson(edge) !== canonicalJson(transaction.edge) ||
        receipt.predecessorInvocationId !== transaction.predecessorInvocationId ||
        receipt.successorInvocationId !== transaction.successorInvocationId ||
        receipt.edgeDigest !== edge.edgeDigest ||
        receipt.transactionDigest !== transaction.transactionDigest ||
        predecessorIndex.role !== 'superseded-by' ||
        predecessorIndex.invocationId !== transaction.predecessorInvocationId ||
        predecessorIndex.peerInvocationId !== transaction.successorInvocationId ||
        successorIndex.role !== 'replacement-of' ||
        successorIndex.invocationId !== transaction.successorInvocationId ||
        successorIndex.peerInvocationId !== transaction.predecessorInvocationId ||
        predecessorIndex.edgeDigest !== edge.edgeDigest ||
        successorIndex.edgeDigest !== edge.edgeDigest ||
        predecessorIndex.transactionDigest !== transaction.transactionDigest ||
        successorIndex.transactionDigest !== transaction.transactionDigest ||
        successorPointer.transactionDigest !== transaction.transactionDigest ||
        successorPointer.predecessorInvocationId !==
            transaction.predecessorInvocationId ||
        successorPointer.successorInvocationId !== transaction.successorInvocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    return edge;
}
export function assertProviderInvocationEvidenceSnapshot(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'attempt',
            'createdAt',
            'evidenceDigest',
            'failureCode',
            'invocationId',
            'kind',
            'legacyRevision',
            'manifestDigest',
            'promptDigest',
            'rawOutputDigest',
            'requestDigest',
            'schemaVersion',
            'semanticOutputDigest',
            'subjectDigest',
            'terminalAt',
            'terminalStatus',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-invocation-evidence-snapshot' ||
        !Number.isSafeInteger(value.attempt) ||
        value.attempt < 1 ||
        !Number.isSafeInteger(value.legacyRevision) ||
        value.legacyRevision < 0 ||
        !isDigest(value.requestDigest) ||
        !isDigest(value.manifestDigest) ||
        !isDigest(value.subjectDigest) ||
        !isNullableDigest(value.promptDigest) ||
        !isNullableDigest(value.rawOutputDigest) ||
        !isNullableDigest(value.semanticOutputDigest) ||
        ![null, 'succeeded', 'failed'].includes(value.terminalStatus) ||
        !isNullableTimestamp(value.terminalAt) ||
        (value.failureCode !== null &&
            (typeof value.failureCode !== 'string' ||
                value.failureCode.length < 1)) ||
        !isTimestamp(value.createdAt) ||
        !isDigest(value.evidenceDigest)) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertInvocationId(String(value.invocationId));
    if ((value.terminalStatus === null &&
        (value.terminalAt !== null || value.failureCode !== null)) ||
        (value.terminalStatus !== null && value.terminalAt === null) ||
        (value.terminalStatus === 'succeeded' && value.failureCode !== null) ||
        (value.terminalStatus === 'failed' && value.failureCode === null)) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertOwnDigest(value, 'evidenceDigest');
    return deepFreeze(structuredClone(value));
}
export function assertProviderInvocationSupersessionEdge(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'contextDigest',
            'createdAt',
            'edgeDigest',
            'epoch',
            'jobId',
            'kind',
            'previousEdgeDigest',
            'replacementMode',
            'replacementOf',
            'schemaVersion',
            'supersededBy',
            'workflowId',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-invocation-supersession-edge' ||
        !isBoundedIdentity(value.workflowId) ||
        !isBoundedIdentity(value.jobId) ||
        !Number.isSafeInteger(value.epoch) ||
        value.epoch < 1 ||
        !isDigest(value.contextDigest) ||
        (value.replacementMode !== 'retry' && value.replacementMode !== 'repair') ||
        !isNullableDigest(value.previousEdgeDigest) ||
        !isTimestamp(value.createdAt) ||
        !isDigest(value.edgeDigest)) {
        throw providerInvocationSupersessionUnsafe();
    }
    const replacementOf = assertProviderInvocationEvidenceSnapshot(value.replacementOf);
    const supersededBy = assertProviderInvocationEvidenceSnapshot(value.supersededBy);
    if (replacementOf.terminalStatus !== 'failed' ||
        supersededBy.terminalStatus !== null ||
        replacementOf.invocationId === supersededBy.invocationId ||
        supersededBy.attempt !== replacementOf.attempt + 1 ||
        supersededBy.createdAt !== value.createdAt ||
        Date.parse(supersededBy.createdAt) < Date.parse(replacementOf.createdAt) ||
        Date.parse(supersededBy.createdAt) < Date.parse(replacementOf.terminalAt)) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertOwnDigest(value, 'edgeDigest');
    return deepFreeze({
        ...structuredClone(value),
        replacementOf,
        supersededBy,
    });
}
export function assertProviderInvocationSupersessionTransaction(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'edge',
            'kind',
            'predecessorInvocationId',
            'preparedAt',
            'schemaVersion',
            'successorInvocationId',
            'transactionDigest',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-invocation-supersession-transaction' ||
        !isTimestamp(value.preparedAt) ||
        !isDigest(value.transactionDigest)) {
        throw providerInvocationSupersessionUnsafe();
    }
    const predecessorInvocationId = assertInvocationId(String(value.predecessorInvocationId));
    const successorInvocationId = assertInvocationId(String(value.successorInvocationId));
    const edge = assertProviderInvocationSupersessionEdge(value.edge);
    if (edge.replacementOf.invocationId !== predecessorInvocationId ||
        edge.supersededBy.invocationId !== successorInvocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertOwnDigest(value, 'transactionDigest');
    return deepFreeze({
        ...structuredClone(value),
        edge,
    });
}
export function assertProviderInvocationSupersessionTransactionPointer(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'kind',
            'pointerDigest',
            'predecessorInvocationId',
            'schemaVersion',
            'successorInvocationId',
            'transactionDigest',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-invocation-supersession-transaction-pointer' ||
        !isDigest(value.transactionDigest) ||
        !isDigest(value.pointerDigest)) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertInvocationId(String(value.predecessorInvocationId));
    assertInvocationId(String(value.successorInvocationId));
    assertOwnDigest(value, 'pointerDigest');
    return deepFreeze(structuredClone(value));
}
export function assertProviderInvocationSupersessionIndex(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'edgeDigest',
            'indexDigest',
            'invocationId',
            'kind',
            'peerInvocationId',
            'role',
            'schemaVersion',
            'transactionDigest',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-invocation-supersession-index' ||
        (value.role !== 'replacement-of' && value.role !== 'superseded-by') ||
        !isDigest(value.edgeDigest) ||
        !isDigest(value.transactionDigest) ||
        !isDigest(value.indexDigest)) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertInvocationId(String(value.invocationId));
    assertInvocationId(String(value.peerInvocationId));
    if (value.invocationId === value.peerInvocationId) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertOwnDigest(value, 'indexDigest');
    return deepFreeze(structuredClone(value));
}
export function assertProviderInvocationSupersessionReceipt(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'edgeDigest',
            'kind',
            'predecessorInvocationId',
            'publishedAt',
            'receiptDigest',
            'schemaVersion',
            'successorInvocationId',
            'transactionDigest',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-invocation-supersession-receipt' ||
        !isDigest(value.edgeDigest) ||
        !isDigest(value.transactionDigest) ||
        !isTimestamp(value.publishedAt) ||
        !isDigest(value.receiptDigest)) {
        throw providerInvocationSupersessionUnsafe();
    }
    assertInvocationId(String(value.predecessorInvocationId));
    assertInvocationId(String(value.successorInvocationId));
    assertOwnDigest(value, 'receiptDigest');
    return deepFreeze(structuredClone(value));
}
export function providerInvocationSupersessionConflict() {
    return workflowError('PROVIDER_INVOCATION_SUPERSESSION_CONFLICT', 'The predecessor already has a different durable successor.', ExitCode.conflict);
}
export function providerInvocationSupersessionRecoveryRequired() {
    return workflowError('PROVIDER_INVOCATION_SUPERSESSION_RECOVERY_REQUIRED', 'A prepared provider invocation supersession requires deterministic recovery.', ExitCode.staleState);
}
export function providerInvocationSupersessionUnsafe() {
    return workflowError('PROVIDER_INVOCATION_SUPERSESSION_UNSAFE', 'Provider invocation supersession evidence is missing, malformed, or inconsistent.', ExitCode.guard);
}
function identityFileName(value) {
    return digestText(assertInvocationId(value));
}
function assertOwnDigest(value, key) {
    const payload = { ...value };
    const expected = payload[key];
    delete payload[key];
    if (expected !== digestCanonical(payload)) {
        throw providerInvocationSupersessionUnsafe();
    }
}
function assertDigest(value) {
    if (!FILE_DIGEST.test(value))
        throw providerInvocationSupersessionUnsafe();
    return value;
}
function digestCanonical(value) {
    return digestText(canonicalJson(value));
}
function digestText(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function isDigest(value) {
    return typeof value === 'string' && DIGEST.test(value);
}
function isNullableDigest(value) {
    return value === null || isDigest(value);
}
function isTimestamp(value) {
    return (typeof value === 'string' &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
function isNullableTimestamp(value) {
    return value === null || isTimestamp(value);
}
function isBoundedIdentity(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 512 &&
        value.trim() === value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    return (canonicalJson(Object.keys(value).sort()) ===
        canonicalJson([...expected].sort()));
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
