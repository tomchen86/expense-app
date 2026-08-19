import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.js';
import { readContentRecord, writeContentRecord, } from './content-record-store.js';
import { compareAndSwapEvidenceRefsDocument, compareAndSwapEvidenceRef, readInvestigationEvidenceRefsClosure, readEvidenceNode, readEvidenceRefs, writeEvidenceNode, } from './evidence-object-store.js';
import { assertStoredEvidenceNode, createEvidenceNode, } from '../../adapters/compatibility/investigation-v2/evidence-node.js';
import { ExitCode, workflowError } from '../../foundation/errors/errors.js';
import { assertInvestigationApplicability, } from '../../modules/investigation/domain/investigation-applicability.js';
import { assertChangeId, } from '../session-workspace/paths.js';
import { assertHeldChangeTransitionAuthority, } from '../session-workspace/planning-lock.js';
import { PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST } from '../../modules/provider-orchestration/provider-contracts.js';
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SESSION_PREFIX = 'investigation-exemption-';
const CURRENT_REF = 'propose/exemption-session';
export function createProposeExemptionSession(paths, input) {
    const changeId = assertChangeId(input.changeId);
    const requestDigest = sessionRequestDigest(input);
    const current = readCurrentProposeExemptionSession(paths, changeId);
    if (current !== null) {
        if (sessionRequestDigest(current) !== requestDigest) {
            throw sessionConflict();
        }
        return current;
    }
    const applicability = assertInvestigationApplicability(input.applicability);
    if (applicability.kind !== 'investigation-exemption') {
        throw sessionInvalid();
    }
    const applicabilityNode = assertStoredEvidenceNode(input.applicabilityNode, sessionInvalid);
    assertApplicabilityNode(applicability, applicabilityNode);
    writeEvidenceNode(paths, applicabilityNode);
    const record = {
        schemaVersion: 1,
        kind: 'propose-exemption-session',
        createdAt: canonicalIsoDate(input.createdAt ?? new Date().toISOString()),
        changeId,
        ...(input.mandateBinding ? { mandateBinding: input.mandateBinding } : {}),
        repositoryRoot: nonEmptyString(input.repositoryRoot),
        gitCommonDirectory: nonEmptyString(input.gitCommonDirectory),
        branch: nullableNonEmptyString(input.branch),
        baseline: assertBaseline(input.baseline),
        intentDigest: assertDigest(input.intentDigest),
        intent: structuredClone(input.intent),
        applicability,
        applicabilityNodeId: applicabilityNode.nodeId,
        actor: assertActor(input.actor),
        signals: assertSignals(input.signals, input.actor.providerId),
    };
    if (record.intentDigest !== sha256(canonicalJson(record.intent))) {
        throw sessionInvalid();
    }
    const recordsDirectory = exemptionRecordsDirectory(paths);
    const recordId = writeContentRecord(recordsDirectory, record);
    const investigationId = `${SESSION_PREFIX}${recordId}`;
    const reservation = createEvidenceNode({
        type: 'propose-exemption-session-reservation',
        nodeSchema: 'workflow.propose-exemption-session-reservation.v1',
        evaluator: 'workflow-propose.v1',
        policyDigest: PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST,
        exactInputDigests: {
            record: recordId,
            request: requestDigest,
        },
        semanticParentResultDigests: {
            applicability: applicabilityNode.resultDigest,
        },
        provenanceParentNodeIds: {
            applicability: applicabilityNode.nodeId,
        },
        outputSchema: 'workflow.propose-exemption-session-reservation-output.v1',
        output: {
            changeId,
            investigationId,
            recordId,
            requestDigest,
        },
        runtimeMetadata: {},
    });
    writeEvidenceNode(paths, reservation);
    try {
        compareAndSwapEvidenceRef(paths, {
            changeId,
            refName: CURRENT_REF,
            expectedNodeId: null,
            nextNodeId: reservation.nodeId,
        });
    }
    catch (error) {
        const converged = readCurrentProposeExemptionSession(paths, changeId);
        if (converged !== null &&
            sessionRequestDigest(converged) === requestDigest) {
            return converged;
        }
        throw error;
    }
    return readProposeExemptionSession(paths, investigationId);
}
export function readCurrentProposeExemptionSession(paths, requestedChangeId) {
    const changeId = assertChangeId(requestedChangeId);
    const reservationNodeId = readEvidenceRefs(paths, changeId)[CURRENT_REF];
    if (!reservationNodeId) {
        return null;
    }
    const reservation = readEvidenceNode(paths, reservationNodeId);
    const output = reservation.output;
    if (reservation.type !== 'propose-exemption-session-reservation' ||
        reservation.nodeSchema !==
            'workflow.propose-exemption-session-reservation.v1' ||
        reservation.evaluator !== 'workflow-propose.v1' ||
        reservation.policyDigest !==
            PROPOSE_EXEMPTION_SESSION_STORE_POLICY_DIGEST ||
        reservation.outputSchema !==
            'workflow.propose-exemption-session-reservation-output.v1' ||
        !isRecord(output) ||
        !hasExactKeys(output, [
            'changeId',
            'investigationId',
            'recordId',
            'requestDigest',
        ]) ||
        output.changeId !== changeId ||
        typeof output.investigationId !== 'string' ||
        typeof output.recordId !== 'string' ||
        !DIGEST.test(output.recordId) ||
        output.investigationId !== `${SESSION_PREFIX}${output.recordId}` ||
        reservation.exactInputDigests.record !== output.recordId ||
        reservation.exactInputDigests.request !== output.requestDigest) {
        throw sessionStale();
    }
    const session = readProposeExemptionSession(paths, output.investigationId);
    if (session.changeId !== changeId ||
        sessionRequestDigest(session) !== output.requestDigest ||
        reservation.provenanceParentNodeIds.applicability !==
            session.applicabilityNode.nodeId ||
        reservation.semanticParentResultDigests.applicability !==
            session.applicabilityNode.resultDigest) {
        throw sessionStale();
    }
    return session;
}
export function readProposeExemptionSession(paths, requestedInvestigationId) {
    const recordId = exemptionRecordId(requestedInvestigationId);
    const record = assertStoredSession(readContentRecord(exemptionRecordsDirectory(paths), recordId));
    const applicabilityNode = readEvidenceNode(paths, record.applicabilityNodeId);
    assertApplicabilityNode(record.applicability, applicabilityNode);
    return deepFreeze({
        schemaVersion: 1,
        kind: 'propose-exemption-session',
        investigationId: `${SESSION_PREFIX}${recordId}`,
        revision: 0,
        state: 'investigation-exempt',
        changeId: record.changeId,
        ...(record.mandateBinding ? { mandateBinding: record.mandateBinding } : {}),
        repositoryRoot: record.repositoryRoot,
        gitCommonDirectory: record.gitCommonDirectory,
        branch: record.branch,
        baseline: record.baseline,
        intentDigest: record.intentDigest,
        intent: record.intent,
        applicability: record.applicability,
        applicabilityNode,
        actor: record.actor,
        signals: record.signals,
        createdAt: record.createdAt,
    });
}
export function retireCurrentProposeExemptionSession(paths, session, authority) {
    const assertOwned = assertHeldChangeTransitionAuthority(authority, session.changeId);
    const current = readCurrentProposeExemptionSession(paths, session.changeId);
    if (current === null ||
        current.investigationId !== session.investigationId ||
        current.intentDigest !== session.intentDigest ||
        current.applicability.applicabilityDigest !==
            session.applicability.applicabilityDigest) {
        throw sessionStale();
    }
    const closure = readInvestigationEvidenceRefsClosure(paths, session.changeId);
    if (closure.snapshot.digest === null ||
        closure.snapshot.refs === null ||
        closure.owners[CURRENT_REF] !== session.investigationId) {
        throw sessionStale();
    }
    const retainedRefs = Object.fromEntries(Object.entries(closure.snapshot.refs)
        .filter(([refName]) => closure.owners[refName] !== session.investigationId)
        .sort(([left], [right]) => left.localeCompare(right)));
    assertOwned();
    compareAndSwapEvidenceRefsDocument(paths, {
        changeId: session.changeId,
        expectedDigest: closure.snapshot.digest,
        nextRefs: Object.keys(retainedRefs).length === 0 ? null : retainedRefs,
    });
    assertOwned();
    if (readCurrentProposeExemptionSession(paths, session.changeId) !== null) {
        throw sessionStale();
    }
}
export function isProposeExemptionInvestigationId(value) {
    return new RegExp(`^${SESSION_PREFIX}[0-9a-f]{64}$`).test(value);
}
function assertStoredSession(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'createdAt',
            'changeId',
            ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
                ? ['mandateBinding']
                : []),
            'repositoryRoot',
            'gitCommonDirectory',
            'branch',
            'baseline',
            'intentDigest',
            'intent',
            'applicability',
            'applicabilityNodeId',
            'actor',
            'signals',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'propose-exemption-session') {
        throw sessionInvalid();
    }
    const applicability = assertInvestigationApplicability(value.applicability);
    if (applicability.kind !== 'investigation-exemption') {
        throw sessionInvalid();
    }
    const record = {
        schemaVersion: 1,
        kind: 'propose-exemption-session',
        createdAt: canonicalIsoDate(value.createdAt),
        changeId: assertChangeId(String(value.changeId)),
        ...(Object.prototype.hasOwnProperty.call(value, 'mandateBinding')
            ? {
                mandateBinding: assertTaskMandateBinding(value.mandateBinding, String(value.changeId)),
            }
            : {}),
        repositoryRoot: nonEmptyString(value.repositoryRoot),
        gitCommonDirectory: nonEmptyString(value.gitCommonDirectory),
        branch: nullableNonEmptyString(value.branch),
        baseline: assertBaseline(value.baseline),
        intentDigest: assertDigest(value.intentDigest),
        intent: structuredClone(value.intent),
        applicability,
        applicabilityNodeId: assertDigest(value.applicabilityNodeId),
        actor: assertActor(value.actor),
        signals: assertSignals(value.signals, assertActor(value.actor).providerId),
    };
    if (record.intentDigest !== sha256(canonicalJson(record.intent)) ||
        record.applicability.intentDigest !== record.intentDigest ||
        canonicalJson(record.applicability.baseline) !==
            canonicalJson(record.baseline)) {
        throw sessionInvalid();
    }
    return record;
}
function assertApplicabilityNode(applicability, node) {
    if (node.type !== 'investigation-applicability' ||
        node.nodeSchema !== 'investigation.applicability.v1' ||
        node.evaluator !== 'investigation-applicability.v1' ||
        node.policyDigest !== applicability.policyDigest ||
        node.outputSchema !== 'investigation.applicability-output.v1' ||
        node.exactInputDigests.applicability !==
            applicability.applicabilityDigest ||
        canonicalJson(node.output) !== canonicalJson(applicability)) {
        throw sessionInvalid();
    }
}
function sessionRequestDigest(value) {
    return sha256(canonicalJson({
        schema: 'workflow-propose-exemption-session-request.v1',
        changeId: value.changeId,
        mandateBinding: value.mandateBinding ?? null,
        repositoryRoot: value.repositoryRoot,
        gitCommonDirectory: value.gitCommonDirectory,
        branch: value.branch,
        baseline: value.baseline,
        intentDigest: value.intentDigest,
        intent: value.intent,
        applicability: value.applicability,
        actor: value.actor,
        signals: value.signals,
    }));
}
function exemptionRecordsDirectory(paths) {
    return path.join(paths.root, 'propose-exemption-sessions');
}
function exemptionRecordId(investigationId) {
    if (!isProposeExemptionInvestigationId(investigationId)) {
        throw sessionInvalid();
    }
    return investigationId.slice(SESSION_PREFIX.length);
}
function assertTaskMandateBinding(value, changeId) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'mandateTaskId',
            'mandateId',
            'mandateDigest',
            'changeId',
            'externalAuditRoot',
        ]) ||
        value.schemaVersion !== 1 ||
        value.changeId !== changeId ||
        typeof value.mandateTaskId !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
        typeof value.mandateId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.mandateId) ||
        typeof value.mandateDigest !== 'string' ||
        !DIGEST.test(value.mandateDigest) ||
        typeof value.externalAuditRoot !== 'string' ||
        !path.isAbsolute(value.externalAuditRoot) ||
        path.normalize(value.externalAuditRoot) !== value.externalAuditRoot) {
        throw sessionInvalid();
    }
    return structuredClone(value);
}
function assertBaseline(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['head', 'tree']) ||
        typeof value.head !== 'string' ||
        typeof value.tree !== 'string' ||
        !GIT_OBJECT_ID.test(value.head) ||
        !GIT_OBJECT_ID.test(value.tree) ||
        value.head.length !== value.tree.length) {
        throw sessionInvalid();
    }
    return { head: value.head, tree: value.tree };
}
function assertActor(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['providerId', 'assurance']) ||
        !['codex', 'claude'].includes(String(value.providerId)) ||
        !['self-declared', 'runtime-hint', 'adapter-assigned'].includes(String(value.assurance))) {
        throw sessionInvalid();
    }
    return value;
}
function assertSignals(value, providerId) {
    if (!Array.isArray(value)) {
        throw sessionInvalid();
    }
    return value.map((signal) => {
        if (!isRecord(signal) ||
            !hasExactKeys(signal, ['source', 'name', 'providerId', 'assurance']) ||
            !['explicit', 'runtime-hint'].includes(String(signal.source)) ||
            typeof signal.name !== 'string' ||
            signal.name.length === 0 ||
            signal.providerId !== providerId ||
            !['self-declared', 'runtime-hint'].includes(String(signal.assurance))) {
            throw sessionInvalid();
        }
        return signal;
    });
}
function assertDigest(value) {
    if (typeof value !== 'string' || !DIGEST.test(value)) {
        throw sessionInvalid();
    }
    return value;
}
function nonEmptyString(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw sessionInvalid();
    }
    return value;
}
function nullableNonEmptyString(value) {
    return value === null ? null : nonEmptyString(value);
}
function canonicalIsoDate(value) {
    if (typeof value !== 'string' ||
        Number.isNaN(Date.parse(value)) ||
        new Date(Date.parse(value)).toISOString() !== value) {
        throw sessionInvalid();
    }
    return value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    return (canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort()));
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object') {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function sessionInvalid() {
    return workflowError('PROPOSE_EXEMPTION_SESSION_INVALID', 'Durable structured investigation-exemption state is invalid.', ExitCode.staleState);
}
function sessionStale() {
    return workflowError('PROPOSE_EXEMPTION_SESSION_STALE', 'Durable structured investigation-exemption state is stale.', ExitCode.staleState);
}
function sessionConflict() {
    return workflowError('CURRENT_INVESTIGATION_EXEMPTION_CONFLICT', 'The current structured investigation exemption differs from this request.', ExitCode.conflict);
}
