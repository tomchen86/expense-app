import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { createReplacementAttempt, projectProviderInvocationExecution, providerExecutionEnvironmentDigest, providerExecutionPolicySnapshot, } from "../../modules/provider-orchestration/execution-core.js";
import { assembleCurrentPromptFromStore, buildContextManifest, buildRepairContext, canonicalRepairBudget, canonicalRepairContext, createRepairBudget, initializeDurableEpochContextStore, inspectDurableEpochContextStore, inspectDurableRetentionCatalog, parseRepairBudget, parseRepairContext, rolloverDurableEpochContextStore, storeDurableEvidence, consumeRepairBudget, withCurrentDurableEpochContextStore, } from "../../modules/authority/execution-governance.js";
import { ExitCode, WorkflowError, workflowError, } from "../../foundation/errors/errors.js";
import { createPrivateCanonicalJson, privatePathExists, readPrivateCanonicalJson, } from "../storage-journal/investigation-session-store.js";
import { assertInvestigationId, } from "../session-workspace/paths.js";
const MAX_REPAIR_VALUE_BYTES = 262_144;
const MAX_REPAIR_ERRORS = 64;
const MAX_REPAIR_ERROR_MESSAGE_BYTES = 4_096;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
/**
 * Replay and consume the legacy per-kind RepairBudget without publishing a
 * replacement artifact. Retry callers run this before their durable
 * reservation/ref transition so a stricter semantic/schema budget cannot fail
 * after partial invocation files have appeared.
 */
export function preflightProviderRepairRetry(paths, input) {
    const failed = projectProviderInvocationExecution({
        record: input.failedRecord,
        request: input.failedRequest,
    });
    if (failed.attempt.failure?.retryClass !== 'repairable')
        return null;
    const evidencePath = repairEvidencePath(paths, input.failedRecord.invocationId);
    if (!privatePathExists(paths, evidencePath, providerRepairUnsafe)) {
        throw workflowError('PROVIDER_REPAIR_EVIDENCE_REQUIRED', 'A repairable failure requires its durable structured repair artifact.', ExitCode.guard);
    }
    const evidence = readProviderRepairEvidence(paths, input.failedRecord, input.failedRequest);
    const jobHistory = input.history.filter((entry) => projectProviderInvocationExecution(entry).job.jobId === failed.job.jobId);
    const budget = replayRepairBudget(paths, jobHistory);
    return consumeRepairBudget(budget, evidence.repairContext.repairKind, evidence.failureFingerprint);
}
/**
 * Resolve the investigation root from the already-canonical invocation
 * directory accepted by the provider runner. No repository or caller path is
 * searched for context data.
 */
export function providerPromptContextStoreRoot(invocationDirectory) {
    const absolute = path.resolve(invocationDirectory);
    const invocations = path.dirname(absolute);
    if (!path.isAbsolute(invocationDirectory) ||
        absolute !== invocationDirectory ||
        path.basename(invocations) !== 'invocations') {
        throw providerContextInvalid('Provider invocation directory is not an exact runtime invocation path.');
    }
    return path.dirname(invocations);
}
/**
 * Materialize the provider's legacy input manifest as the sole item in an
 * exact durable epoch context. Replays verify the complete expected manifest;
 * they never discover or append evidence by walking historical storage.
 */
export function ensureProviderPromptContext(storeRoot, request, manifestValue, requestedOwnerWorkflowId) {
    return resolveProviderPromptContext(storeRoot, request, manifestValue, requestedOwnerWorkflowId, { allowRollover: false, now: new Date() });
}
/**
 * Publish the context selected by a newly-created lifecycle-owned invocation.
 * This is the sole provider bridge allowed to advance an existing context: a
 * worker replay continues to use ensureProviderPromptContext and therefore
 * cannot roll the current manifest back to stale request bytes.
 */
export function prepareProviderPromptContextForInvocation(storeRoot, request, manifestValue, requestedOwnerWorkflowId, now) {
    return resolveProviderPromptContext(storeRoot, request, manifestValue, requestedOwnerWorkflowId, { allowRollover: true, now });
}
/**
 * Stable catalog identity for one Attempt's private provider runtime. A pin
 * recorded against this identity is what keeps the raw prompt, schema, and
 * semantic output from expiring on the ordinary schedule.
 *
 * It lives beside the writer so that the module recording the handle and the
 * pass consulting it share one derivation. Two copies of this formula would be
 * two identities, and a pin recorded under one would be invisible to the other.
 */
export function providerRuntimeEvidenceId(attemptId) {
    return `provider-runtime-${crypto
        .createHash('sha256')
        .update(attemptId)
        .digest('hex')
        .slice(0, 32)}`;
}
/**
 * Records the handle a maintainer pins to keep one Attempt's private provider
 * runtime.
 *
 * The pruning pass has always honoured a pin and the pin ceremony has always
 * been reachable, but nothing created the record the two meet on, so the
 * ceremony protected no bytes at all. This is that record, written where the
 * runtime comes into existence: the descriptor names the runtime rather than
 * copying it, so the raw bytes stay where they are.
 *
 * It has to be written now rather than when deletion looms, for two reasons.
 * Only the current epoch may publish active evidence, and a handle that first
 * appears once the bytes are already eligible for deletion would arrive too
 * late for anyone to act on.
 */
export function registerProviderRuntimeEvidence(storeRoot, input) {
    const evidenceId = providerRuntimeEvidenceId(input.attemptId);
    const catalog = inspectDurableRetentionCatalog(storeRoot, input.binding.workflowId);
    if (catalog.records.some((record) => record.evidenceId === evidenceId)) {
        return { evidenceId, created: false };
    }
    const content = `${canonicalJson({
        kind: 'provider-runtime-evidence.v1',
        workflowId: input.binding.workflowId,
        epoch: input.binding.epoch,
        attemptId: input.attemptId,
        invocationId: input.invocationId,
        legacyRevision: input.legacyRevision,
    })}\n`;
    storeDurableEvidence(storeRoot, {
        workflowId: input.binding.workflowId,
        expectedCatalogGeneration: catalog.generation,
        record: {
            schemaVersion: 1,
            kind: 'evidence-retention',
            evidenceId,
            itemIdentity: `attempt:${input.attemptId}`,
            workflowId: input.binding.workflowId,
            epoch: input.binding.epoch,
            evidenceClass: 'raw',
            digest: `sha256:${crypto
                .createHash('sha256')
                .update(content)
                .digest('hex')}`,
            retention: 'active',
            createdAt: input.now.toISOString(),
            expiresAt: null,
            pin: null,
        },
        content,
    });
    return { evidenceId, created: true };
}
/**
 * Resolve one already-published invocation manifest against the authoritative
 * durable provider-context epoch without advancing or otherwise mutating it.
 * A compacted or ambiguous historical transition returns null so retention
 * defaults to preserving the raw evidence.
 */
export function inspectProviderPromptContextRetentionBinding(storeRoot, request, manifestValue, requestedOwnerWorkflowId, invocationCreatedAt) {
    const ownerWorkflowId = assertInvestigationId(requestedOwnerWorkflowId);
    if (!isTimestamp(invocationCreatedAt))
        return null;
    const content = canonicalJson(manifestValue);
    if (sha256Hex(content) !== request.inputManifestDigest)
        return null;
    const workflowId = providerContextWorkflowId(ownerWorkflowId, request);
    let current;
    try {
        current = inspectDurableEpochContextStore(storeRoot, workflowId);
    }
    catch {
        return null;
    }
    const candidateEpochs = new Set([
        current.workflow.currentEpoch,
        ...current.transitionReceipts.flatMap(({ fromEpoch, toEpoch }) => [
            fromEpoch,
            toEpoch,
        ]),
    ]);
    const createdAt = Date.parse(invocationCreatedAt);
    const matches = [...candidateEpochs]
        .sort((left, right) => left - right)
        .flatMap((epoch) => {
        const contractVersions = new Set([
            ...(epoch === current.workflow.currentEpoch
                ? [current.workflow.contractVersion]
                : []),
            ...current.transitionReceipts.flatMap((receipt) => [
                ...(receipt.fromEpoch === epoch ? [receipt.fromContractVersion] : []),
                ...(receipt.toEpoch === epoch ? [receipt.toContractVersion] : []),
            ]),
        ]);
        const enteredAt = current.transitionReceipts.find(({ toEpoch }) => toEpoch === epoch)?.createdAt;
        const exitedAt = current.transitionReceipts.find(({ fromEpoch }) => fromEpoch === epoch)?.createdAt;
        if ((enteredAt !== undefined && createdAt < Date.parse(enteredAt)) ||
            (exitedAt !== undefined && createdAt > Date.parse(exitedAt))) {
            return [];
        }
        return [...contractVersions].flatMap((contractVersion) => {
            const manifest = providerPromptManifest(request, workflowId, epoch, contractVersion, content);
            const digestBound = (epoch === current.workflow.currentEpoch &&
                canonicalJson(manifest) ===
                    canonicalJson(current.currentManifest)) ||
                current.transitionReceipts.some((receipt) => (receipt.fromEpoch === epoch &&
                    receipt.previousContextDigest === manifest.contextDigest) ||
                    (receipt.toEpoch === epoch &&
                        receipt.newContextDigest === manifest.contextDigest));
            return digestBound
                ? [{ epoch, contextDigest: manifest.contextDigest }]
                : [];
        });
    });
    if (matches.length !== 1)
        return null;
    return Object.freeze({
        workflowId,
        epoch: matches[0].epoch,
        contextDigest: matches[0].contextDigest,
        currentEpoch: current.workflow.currentEpoch,
        currentContextDigest: current.workflow.contextDigest,
        currentGeneration: current.generation,
    });
}
function resolveProviderPromptContext(storeRoot, request, manifestValue, requestedOwnerWorkflowId, options) {
    const ownerWorkflowId = assertInvestigationId(requestedOwnerWorkflowId);
    const content = canonicalJson(manifestValue);
    if (sha256Hex(content) !== request.inputManifestDigest) {
        throw providerContextInvalid('Provider input manifest bytes do not match the request binding.');
    }
    const workflowId = providerContextWorkflowId(ownerWorkflowId, request);
    const items = [{ identity: 'provider-input-manifest', content }];
    let current;
    try {
        current = inspectDurableEpochContextStore(storeRoot, workflowId);
    }
    catch (error) {
        if (!(error instanceof WorkflowError) ||
            error.code !== 'EXECUTION_CONTEXT_NOT_FOUND') {
            throw error;
        }
        const manifest = providerPromptManifest(request, workflowId, 1, 1, content);
        const workflow = providerPromptWorkflow(request, manifest);
        try {
            current = initializeDurableEpochContextStore(storeRoot, {
                workflow,
                manifest,
                items,
                now: options.now,
            });
        }
        catch (initializeError) {
            if (!(initializeError instanceof WorkflowError) ||
                initializeError.code !== 'EXECUTION_CONTEXT_EXISTS') {
                throw initializeError;
            }
            current = inspectDurableEpochContextStore(storeRoot, workflowId);
        }
    }
    const semanticContractChanged = current.currentManifest.termSetDigest !==
        providerSemanticContractDigest(request);
    const contractVersion = semanticContractChanged
        ? current.workflow.contractVersion + 1
        : current.workflow.contractVersion;
    let manifest = providerPromptManifest(request, workflowId, current.workflow.currentEpoch, contractVersion, content);
    let workflow = providerPromptWorkflow(request, manifest);
    if (canonicalJson(current.workflow) !== canonicalJson(workflow) ||
        canonicalJson(current.currentManifest) !== canonicalJson(manifest)) {
        if (!options.allowRollover)
            throw providerContextStale();
        manifest = providerPromptManifest(request, workflowId, current.workflow.currentEpoch + 1, contractVersion, content);
        const nextItems = new Map(manifest.items.map(({ identity, digest }) => [identity, digest]));
        const carriedForward = current.currentManifest.items
            .filter(({ identity, digest }) => nextItems.get(identity) === digest)
            .map(({ identity }) => identity);
        const carriedForwardSet = new Set(carriedForward);
        current = rolloverDurableEpochContextStore(storeRoot, {
            workflowId,
            expectedGeneration: current.generation,
            expectedEpoch: current.workflow.currentEpoch,
            expectedContextDigest: current.workflow.contextDigest,
            nextManifest: manifest,
            items,
            reason: semanticContractChanged
                ? 'Lifecycle selected a new provider semantic output contract.'
                : 'Lifecycle selected a new provider semantic input manifest.',
            restartFrom: request.purpose,
            carriedForward,
            carryForwardManifest: {
                sourceWorkflow: workflowId,
                sourceEpoch: current.workflow.currentEpoch,
                carriedForward: carriedForward.map((identity) => ({
                    identity,
                    reason: 'The exact provider input manifest remains selected semantic input in the new epoch.',
                })),
                excluded: current.currentManifest.items
                    .filter(({ identity }) => !carriedForwardSet.has(identity))
                    .map(({ identity }) => ({
                    identity,
                    reason: 'The prior provider input manifest is bound to the superseded semantic request.',
                })),
            },
            invalidated: semanticContractChanged
                ? ['provider-input-manifest', 'provider-semantic-contract']
                : ['provider-input-manifest'],
            verification: null,
            createdAt: options.now,
        });
        workflow = providerPromptWorkflow(request, manifest);
        if (canonicalJson(current.workflow) !== canonicalJson(workflow) ||
            canonicalJson(current.currentManifest) !== canonicalJson(manifest)) {
            throw providerContextStale();
        }
    }
    return Object.freeze({
        ownerWorkflowId,
        purpose: request.purpose,
        workflowId,
        generation: current.generation,
        epoch: current.workflow.currentEpoch,
        contextDigest: manifest.contextDigest,
        manifest,
    });
}
function providerPromptManifest(request, workflowId, epoch, contractVersion, content) {
    return buildContextManifest({
        workflowId,
        epoch,
        contractVersion,
        baselineDigest: digestCanonical({
            baseCommit: request.baseCommit,
            baseTree: request.baseTree,
        }),
        intentDigest: digestCanonical({ targetDigest: request.targetDigest }),
        termSetDigest: providerSemanticContractDigest(request),
        planningSnapshotDigest: digestCanonical({
            inputManifestDigest: request.inputManifestDigest,
        }),
        items: [{ identity: 'provider-input-manifest', content }],
    });
}
function providerSemanticContractDigest(request) {
    return digestCanonical({
        schemaVersion: 1,
        kind: 'provider-semantic-output-contract',
        purpose: request.purpose,
        outputSchema: request.outputSchema,
        evaluatorVersion: request.evaluatorVersion,
    });
}
function providerPromptWorkflow(request, manifest) {
    return {
        workflowId: manifest.workflowId,
        currentEpoch: manifest.epoch,
        contractVersion: manifest.contractVersion,
        contextDigest: manifest.contextDigest,
        snapshotDigest: manifest.baselineDigest,
        status: 'active',
        checkpoint: request.purpose,
        blocker: null,
    };
}
export function assembleProviderPromptManifest(storeRoot, request, manifestValue, ownerWorkflowId) {
    const binding = ensureProviderPromptContext(storeRoot, request, manifestValue, ownerWorkflowId);
    const assembled = assembleCurrentPromptFromStore(storeRoot, {
        workflowId: binding.workflowId,
        expectedEpoch: binding.epoch,
        expectedContextDigest: binding.contextDigest,
    });
    if (sha256Hex(assembled) !== request.inputManifestDigest) {
        throw workflowError('PROVIDER_CONTEXT_ITEM_MISMATCH', 'Current durable context did not assemble the exact request manifest.', ExitCode.staleState);
    }
    try {
        const parsed = JSON.parse(assembled);
        if (canonicalJson(parsed) !== assembled)
            throw new Error('non-canonical');
        return parsed;
    }
    catch {
        throw providerContextInvalid('Current durable provider manifest is not canonical JSON.');
    }
}
export function assertProviderPromptContextCurrent(storeRoot, binding) {
    assertProviderPromptContextBinding(binding);
    const current = inspectDurableEpochContextStore(storeRoot, binding.workflowId);
    if (current.generation !== binding.generation ||
        current.workflow.status !== 'active' ||
        current.workflow.currentEpoch !== binding.epoch ||
        current.workflow.contextDigest !== binding.contextDigest ||
        canonicalJson(current.currentManifest) !== canonicalJson(binding.manifest)) {
        throw providerContextStale();
    }
}
export function withCurrentProviderPromptContext(storeRoot, binding, operation) {
    assertProviderPromptContextBinding(binding);
    try {
        return withCurrentDurableEpochContextStore(storeRoot, {
            workflowId: binding.workflowId,
            expectedGeneration: binding.generation,
            expectedEpoch: binding.epoch,
            expectedContextDigest: binding.contextDigest,
            expectedManifest: binding.manifest,
        }, operation);
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'EXECUTION_CONTEXT_CAS_MISMATCH') {
            throw providerContextStale();
        }
        throw error;
    }
}
export function extractProviderRepairFailure(error, targetSchema) {
    if (!(error instanceof WorkflowError) ||
        error.code !== 'PROVIDER_NATIVE_OUTPUT_INVALID') {
        return null;
    }
    const repair = error.details?.repair;
    if (!isRecord(repair) ||
        !hasExactKeys(repair, ['previousOutput', 'repairKind', 'validationErrors'])) {
        return null;
    }
    return normalizeRepairFailureInput({
        repairKind: repair.repairKind,
        previousOutput: repair.previousOutput,
        validationErrors: repair.validationErrors,
        targetSchema,
    });
}
export function persistProviderRepairEvidence(paths, input) {
    const repair = normalizeRepairFailureInput(input.repair);
    if (input.failure.kind !== 'retryable' ||
        !isTimestamp(input.recordedAt) ||
        sha256Hex(canonicalJson(repair.targetSchema)) !==
            input.request.outputSchema.digest) {
        throw providerRepairInvalid('Repair evidence is not bound to the request.');
    }
    const failedRecord = {
        ...input.record,
        revision: input.record.revision + 1,
        state: 'failed',
        lease: null,
        result: null,
        failure: input.failure,
        updatedAt: input.recordedAt,
    };
    const projection = projectProviderInvocationExecution({
        record: failedRecord,
        request: input.request,
    });
    if (projection.attempt.failure === null ||
        projection.attempt.failure.retryClass !== 'repairable') {
        throw providerRepairInvalid('Only a validator-classified failure may publish repair evidence.');
    }
    const context = buildRepairContext({
        repairKind: repair.repairKind,
        workflowId: projection.workflow.workflowId,
        epoch: projection.job.epoch,
        jobId: projection.job.jobId,
        attemptId: projection.attempt.attemptId,
        contextDigest: projection.job.contextDigest,
        previousOutput: repair.previousOutput,
        validationErrors: repair.validationErrors,
        targetSchema: repair.targetSchema,
    });
    const payload = {
        schemaVersion: 1,
        kind: 'provider-repair-evidence',
        failedInvocationId: input.record.invocationId,
        failedAttemptId: projection.attempt.attemptId,
        failureCode: projection.attempt.failure.code,
        failureFingerprint: projection.attempt.failure.fingerprint,
        workflowId: projection.workflow.workflowId,
        jobId: projection.job.jobId,
        epoch: projection.job.epoch,
        contextDigest: projection.job.contextDigest,
        repairContext: context,
        recordedAt: input.recordedAt,
    };
    const evidence = Object.freeze({
        ...payload,
        evidenceDigest: digestCanonical(payload),
    });
    const filePath = repairEvidencePath(paths, input.record.invocationId);
    if (privatePathExists(paths, filePath, providerRepairUnsafe)) {
        const existing = readProviderRepairEvidence(paths, failedRecord, input.request);
        if (canonicalJson(existing) !== canonicalJson(evidence)) {
            throw workflowError('PROVIDER_REPAIR_EVIDENCE_CONFLICT', 'A different repair artifact already exists for this Attempt.', ExitCode.conflict);
        }
        return existing;
    }
    createPrivateCanonicalJson(paths, filePath, evidence, providerRepairUnsafe, 'PROVIDER_REPAIR_EVIDENCE_CONFLICT');
    return readProviderRepairEvidence(paths, failedRecord, input.request);
}
export function readProviderRepairEvidence(paths, record, request) {
    const value = readPrivateCanonicalJson(paths, repairEvidencePath(paths, record.invocationId), providerRepairUnsafe);
    const evidence = assertProviderRepairEvidence(value);
    const projection = projectProviderInvocationExecution({ record, request });
    if (record.state !== 'failed' ||
        projection.attempt.failure === null ||
        evidence.failedInvocationId !== record.invocationId ||
        evidence.failedAttemptId !== projection.attempt.attemptId ||
        evidence.failureCode !== projection.attempt.failure.code ||
        evidence.failureFingerprint !== projection.attempt.failure.fingerprint ||
        evidence.workflowId !== projection.workflow.workflowId ||
        evidence.jobId !== projection.job.jobId ||
        evidence.epoch !== projection.job.epoch ||
        evidence.contextDigest !== projection.job.contextDigest) {
        throw providerRepairUnsafe();
    }
    return evidence;
}
export function loadProviderExecutionRepairContext(paths, record, request) {
    return executionRepairContext(readProviderRepairEvidence(paths, record, request));
}
export function createProviderRepairLineage(paths, input) {
    const replacementProjection = projectProviderInvocationExecution({
        record: input.replacementRecord,
        request: input.replacementRequest,
    });
    const jobHistory = input.history.filter((entry) => projectProviderInvocationExecution(entry).job.jobId ===
        replacementProjection.job.jobId);
    const previousEntry = jobHistory
        .filter(({ record }) => record.investigationId === input.replacementRecord.investigationId &&
        record.purpose === input.replacementRecord.purpose &&
        record.attempt === input.replacementRecord.attempt - 1)
        .at(0);
    if (previousEntry === undefined)
        return null;
    const previous = projectProviderInvocationExecution(previousEntry);
    if (previous.attempt.failure?.retryClass !== 'repairable')
        return null;
    const evidencePath = repairEvidencePath(paths, previousEntry.record.invocationId);
    if (!privatePathExists(paths, evidencePath, providerRepairUnsafe)) {
        throw workflowError('PROVIDER_REPAIR_EVIDENCE_REQUIRED', 'A repairable failure requires its durable structured repair artifact.', ExitCode.guard);
    }
    const evidence = readProviderRepairEvidence(paths, previousEntry.record, previousEntry.request);
    const budget = replayRepairBudget(paths, jobHistory);
    const repairBudget = consumeRepairBudget(budget, evidence.repairContext.repairKind, evidence.failureFingerprint);
    const repairContext = executionRepairContext(evidence);
    if (replacementProjection.job.jobId !== previous.job.jobId ||
        replacementProjection.job.contextDigest !== previous.job.contextDigest) {
        throw providerRepairInvalid('Repair replacement changed the semantic Job or context identity.');
    }
    const replacement = createReplacementAttempt({
        workflow: previous.workflow,
        job: {
            ...previous.job,
            repairAttemptCount: repairBudget.schemaAttempts + repairBudget.semanticAttempts - 1,
        },
        previousAttempt: previous.attempt,
        attemptId: `attempt-legacy-${input.replacementRecord.invocationId}`,
        retryMode: 'repair',
        currentExecutionPolicy: providerExecutionPolicySnapshot(input.replacementRequest),
        repairContext,
        environmentDigest: providerExecutionEnvironmentDigest(input.replacementRequest),
        createdAt: input.replacementRecord.createdAt,
    });
    if (replacement.attempt.attemptNumber !== input.replacementRecord.attempt ||
        replacement.job.jobId !== previous.job.jobId) {
        throw providerRepairInvalid('Repair replacement does not preserve the durable Job lineage.');
    }
    const payload = {
        schemaVersion: 1,
        kind: 'provider-repair-lineage',
        replacementInvocationId: input.replacementRecord.invocationId,
        replacementAttemptId: replacement.attempt.attemptId,
        replacementRequestDigest: input.replacementRequest.requestDigest,
        failedInvocationId: previousEntry.record.invocationId,
        failedAttemptId: previous.attempt.attemptId,
        repairEvidenceDigest: evidence.evidenceDigest,
        failureFingerprint: evidence.failureFingerprint,
        workflowId: previous.workflow.workflowId,
        jobId: previous.job.jobId,
        epoch: previous.job.epoch,
        contextDigest: previous.job.contextDigest,
        retryMode: 'repair',
        repairKind: evidence.repairContext.repairKind,
        repairContext,
        repairBudget,
        createdAt: input.replacementRecord.createdAt,
    };
    const lineage = Object.freeze({
        ...payload,
        lineageDigest: digestCanonical(payload),
    });
    const filePath = repairLineagePath(paths, input.replacementRecord.invocationId);
    if (privatePathExists(paths, filePath, providerRepairUnsafe)) {
        const existing = readProviderRepairLineage(paths, input.replacementRecord, input.replacementRequest);
        if (canonicalJson(existing) !== canonicalJson(lineage)) {
            throw workflowError('PROVIDER_REPAIR_LINEAGE_CONFLICT', 'A different repair lineage already exists for this replacement.', ExitCode.conflict);
        }
        return existing;
    }
    createPrivateCanonicalJson(paths, filePath, lineage, providerRepairUnsafe, 'PROVIDER_REPAIR_LINEAGE_CONFLICT');
    return readProviderRepairLineage(paths, input.replacementRecord, input.replacementRequest);
}
export function readProviderRepairLineage(paths, record, request) {
    const filePath = repairLineagePath(paths, record.invocationId);
    if (!privatePathExists(paths, filePath, providerRepairUnsafe))
        return null;
    const lineage = assertProviderRepairLineage(readPrivateCanonicalJson(paths, filePath, providerRepairUnsafe));
    const projection = projectProviderInvocationExecution({ record, request });
    if (lineage.replacementInvocationId !== record.invocationId ||
        lineage.replacementAttemptId !== projection.attempt.attemptId ||
        lineage.replacementRequestDigest !== request.requestDigest ||
        lineage.workflowId !== projection.workflow.workflowId ||
        lineage.jobId !== projection.job.jobId ||
        lineage.epoch !== projection.job.epoch ||
        lineage.contextDigest !== projection.job.contextDigest) {
        throw providerRepairUnsafe();
    }
    return lineage;
}
export function readProviderRepairPromptContext(paths, record, request) {
    return (readProviderRepairLineage(paths, record, request)?.repairContext ?? null);
}
export function readProviderRepairPrompt(paths, request) {
    const lineagePath = repairLineagePath(paths, request.invocationId);
    if (!privatePathExists(paths, lineagePath, providerRepairUnsafe))
        return null;
    const lineage = assertProviderRepairLineage(readPrivateCanonicalJson(paths, lineagePath, providerRepairUnsafe));
    if (lineage.replacementInvocationId !== request.invocationId ||
        lineage.replacementRequestDigest !== request.requestDigest) {
        throw providerRepairUnsafe();
    }
    const evidence = assertProviderRepairEvidence(readPrivateCanonicalJson(paths, repairEvidencePath(paths, lineage.failedInvocationId), providerRepairUnsafe));
    if (evidence.evidenceDigest !== lineage.repairEvidenceDigest ||
        evidence.failedInvocationId !== lineage.failedInvocationId ||
        evidence.failedAttemptId !== lineage.failedAttemptId ||
        evidence.failureFingerprint !== lineage.failureFingerprint ||
        evidence.workflowId !== lineage.workflowId ||
        evidence.jobId !== lineage.jobId ||
        evidence.epoch !== lineage.epoch ||
        evidence.contextDigest !== lineage.contextDigest) {
        throw providerRepairUnsafe();
    }
    return evidence.repairContext;
}
export function readProviderRepairAuthorityBinding(paths, record, request) {
    const lineagePath = repairLineagePath(paths, record.invocationId);
    const currentEvidencePath = repairEvidencePath(paths, record.invocationId);
    const lineage = readProviderRepairLineage(paths, record, request);
    if (lineage === null) {
        if (privatePathExists(paths, currentEvidencePath, providerRepairUnsafe)) {
            throw providerRepairUnsafe();
        }
        return Object.freeze({
            invocationId: record.invocationId,
            lineagePath,
            lineageDigest: null,
            currentEvidencePath,
            evidencePath: null,
            evidenceDigest: null,
        });
    }
    if (privatePathExists(paths, currentEvidencePath, providerRepairUnsafe)) {
        throw providerRepairUnsafe();
    }
    // Reuse the complete evidence/lineage cross-check used for prompt assembly;
    // the returned prompt is intentionally discarded here.
    readProviderRepairPrompt(paths, request);
    const evidencePath = repairEvidencePath(paths, lineage.failedInvocationId);
    const evidence = assertProviderRepairEvidence(readPrivateCanonicalJson(paths, evidencePath, providerRepairUnsafe));
    if (evidence.evidenceDigest !== lineage.repairEvidenceDigest) {
        throw providerRepairUnsafe();
    }
    return Object.freeze({
        invocationId: record.invocationId,
        lineagePath,
        lineageDigest: lineage.lineageDigest,
        currentEvidencePath,
        evidencePath,
        evidenceDigest: evidence.evidenceDigest,
    });
}
export function assertProviderRepairAuthorityCurrent(paths, record, request, expected) {
    if (canonicalJson(readProviderRepairAuthorityBinding(paths, record, request)) !== canonicalJson(expected)) {
        throw workflowError('PROVIDER_REPAIR_AUTHORITY_STALE', 'Provider repair authority changed after execution admission.', ExitCode.staleState);
    }
}
function replayRepairBudget(paths, history) {
    let budget = createRepairBudget();
    for (const entry of [...history].sort((left, right) => left.record.attempt - right.record.attempt)) {
        const lineage = readProviderRepairLineage(paths, entry.record, entry.request);
        if (lineage === null)
            continue;
        budget = consumeRepairBudget(budget, lineage.repairKind, lineage.failureFingerprint);
        if (canonicalRepairBudget(budget) !==
            canonicalRepairBudget(lineage.repairBudget)) {
            throw providerRepairUnsafe();
        }
    }
    return budget;
}
function executionRepairContext(evidence) {
    return {
        previousOutputDigest: digestCanonical(evidence.repairContext.previousOutput),
        validationErrors: evidence.repairContext.validationErrors.map((error) => ({
            ...error,
            path: error.path === '' ? '/' : error.path,
        })),
        targetSchemaDigest: digestCanonical(evidence.repairContext.targetSchema),
        instruction: 'return-complete-replacement-object',
        epoch: evidence.epoch,
        contextDigest: evidence.contextDigest,
    };
}
function normalizeRepairFailureInput(input) {
    if (!isRecord(input) ||
        !hasExactKeys(input, [
            'previousOutput',
            'repairKind',
            'targetSchema',
            'validationErrors',
        ]) ||
        (input.repairKind !== 'schema' && input.repairKind !== 'semantic') ||
        !Array.isArray(input.validationErrors)) {
        throw providerRepairInvalid('Repair failure input is malformed.');
    }
    const previousOutput = boundedJsonValue(input.previousOutput, true);
    const targetSchema = boundedJsonValue(input.targetSchema, false);
    if (input.validationErrors.length < 1 ||
        input.validationErrors.length > MAX_REPAIR_ERRORS) {
        throw providerRepairInvalid('Repair validation errors are not bounded.');
    }
    const validationErrors = input.validationErrors
        .map((value) => {
        if (!isRecord(value) ||
            !hasExactKeys(value, ['code', 'message', 'path']) ||
            typeof value.path !== 'string' ||
            (value.path !== '' && !value.path.startsWith('/')) ||
            typeof value.code !== 'string' ||
            !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) ||
            typeof value.message !== 'string' ||
            value.message.length < 1 ||
            Buffer.byteLength(value.message) > MAX_REPAIR_ERROR_MESSAGE_BYTES) {
            throw providerRepairInvalid('Repair validation error is malformed.');
        }
        return {
            path: value.path,
            code: value.code,
            message: value.message,
        };
    })
        .sort((left, right) => `${left.path}\0${left.code}\0${left.message}`.localeCompare(`${right.path}\0${right.code}\0${right.message}`));
    return Object.freeze({
        repairKind: input.repairKind,
        previousOutput,
        validationErrors,
        targetSchema,
    });
}
function boundedJsonValue(value, summarizeOversized) {
    let encoded;
    try {
        encoded = canonicalJson(value);
    }
    catch {
        throw providerRepairInvalid('Repair value is not canonical JSON.');
    }
    if (Buffer.byteLength(encoded) <= MAX_REPAIR_VALUE_BYTES) {
        return JSON.parse(encoded);
    }
    if (!summarizeOversized) {
        throw providerRepairInvalid('Repair target schema exceeds its size bound.');
    }
    return {
        kind: 'omitted-oversized-provider-output',
        digest: digestText(encoded),
        byteLength: Buffer.byteLength(encoded),
    };
}
function assertProviderRepairEvidence(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'contextDigest',
            'epoch',
            'evidenceDigest',
            'failedAttemptId',
            'failedInvocationId',
            'failureCode',
            'failureFingerprint',
            'jobId',
            'kind',
            'recordedAt',
            'repairContext',
            'schemaVersion',
            'workflowId',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-repair-evidence' ||
        !isTimestamp(value.recordedAt) ||
        !isDigest(value.evidenceDigest)) {
        throw providerRepairUnsafe();
    }
    const context = parseRepairContext(canonicalRepairContext(value.repairContext));
    const payload = { ...value };
    delete payload.evidenceDigest;
    if (digestCanonical(payload) !== value.evidenceDigest) {
        throw providerRepairUnsafe();
    }
    return Object.freeze({
        ...value,
        repairContext: context,
    });
}
function assertProviderRepairLineage(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'contextDigest',
            'createdAt',
            'epoch',
            'failedAttemptId',
            'failedInvocationId',
            'failureFingerprint',
            'jobId',
            'kind',
            'lineageDigest',
            'repairBudget',
            'repairContext',
            'repairEvidenceDigest',
            'repairKind',
            'replacementAttemptId',
            'replacementInvocationId',
            'replacementRequestDigest',
            'retryMode',
            'schemaVersion',
            'workflowId',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'provider-repair-lineage' ||
        value.retryMode !== 'repair' ||
        (value.repairKind !== 'schema' && value.repairKind !== 'semantic') ||
        !isTimestamp(value.createdAt) ||
        !isDigest(value.lineageDigest) ||
        !isDigest(value.repairEvidenceDigest) ||
        !isDigest(value.failureFingerprint)) {
        throw providerRepairUnsafe();
    }
    const budget = parseRepairBudget(canonicalRepairBudget(value.repairBudget));
    const payload = { ...value };
    delete payload.lineageDigest;
    if (digestCanonical(payload) !== value.lineageDigest) {
        throw providerRepairUnsafe();
    }
    return Object.freeze({
        ...value,
        repairBudget: budget,
    });
}
function providerContextWorkflowId(ownerWorkflowId, request) {
    return `provider-context-${request.purpose}-${sha256Hex(canonicalJson({
        schemaVersion: 1,
        kind: 'provider-context-owner',
        ownerWorkflowId: assertInvestigationId(ownerWorkflowId),
        purpose: request.purpose,
    })).slice(0, 32)}`;
}
function assertProviderPromptContextBinding(binding) {
    const ownerWorkflowId = assertInvestigationId(binding.ownerWorkflowId);
    if ((binding.purpose !== 'survey' &&
        binding.purpose !== 'plan-review' &&
        binding.purpose !== 'task-diff-review' &&
        binding.purpose !== 'task-implementation') ||
        binding.workflowId !==
            providerContextWorkflowId(ownerWorkflowId, binding) ||
        !Number.isSafeInteger(binding.generation) ||
        binding.generation < 1 ||
        !Number.isSafeInteger(binding.epoch) ||
        binding.epoch < 1 ||
        !isDigest(binding.contextDigest) ||
        binding.manifest.workflowId !== binding.workflowId ||
        binding.manifest.epoch !== binding.epoch ||
        binding.manifest.contextDigest !== binding.contextDigest) {
        throw providerContextInvalid('Provider context binding is malformed.');
    }
}
function repairEvidencePath(paths, invocationId) {
    return path.join(paths.invocations, invocationId, 'repair-evidence.json');
}
function repairLineagePath(paths, invocationId) {
    return path.join(paths.invocations, invocationId, 'repair-lineage.json');
}
function digestCanonical(value) {
    return digestText(canonicalJson(value));
}
function digestText(value) {
    return `sha256:${sha256Hex(value)}`;
}
function sha256Hex(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function isDigest(value) {
    return typeof value === 'string' && SHA256.test(value);
}
function isTimestamp(value) {
    return (typeof value === 'string' &&
        !Number.isNaN(Date.parse(value)) &&
        new Date(value).toISOString() === value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return canonicalJson(actual) === canonicalJson(expected);
}
function providerContextInvalid(message) {
    return workflowError('PROVIDER_CONTEXT_INVALID', message, ExitCode.verification);
}
function providerContextStale() {
    return workflowError('PROVIDER_CONTEXT_STALE_OR_WRONG', 'Durable provider context is no longer the exact current request manifest.', ExitCode.staleState);
}
function providerRepairInvalid(message) {
    return workflowError('PROVIDER_REPAIR_INVALID', message, ExitCode.verification);
}
function providerRepairUnsafe() {
    return workflowError('PROVIDER_REPAIR_ARTIFACT_UNSAFE', 'Provider repair artifact is missing, malformed, or not identity-bound.', ExitCode.unsafeEnvironment);
}
