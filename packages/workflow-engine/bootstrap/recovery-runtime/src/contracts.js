import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, workflowError } from './errors.js';
import { assertInvestigationApplicability, } from './investigation-applicability.js';
import { workflowContractArtifactPaths } from './contract-artifacts.js';
import { isRecord, isStringArray } from './contract-values.js';
import { assertStoredEvidenceNode, } from './evidence-node.js';
import { validateClosedEvidenceDag } from './evidence-currentness.js';
import { createConvergenceRecord, createDescendantReuseProof, readConvergenceBinding, readReuseProofBinding, } from './evidence-convergence.js';
import { validateTrackedEvidenceReusePaths } from './evidence-reuse-path.js';
import { assertChangeId, assertPolicyPathInsideRepository, assertTaskId, matchesAllowedPath, normalizePolicyPath, } from './paths.js';
const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isPlanningAssuranceBinding(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'applicabilityKind',
            'applicabilityDigest',
            'applicabilityNodeId',
            'investigationBaseline',
            'planningGenerationId',
            'planTargetDigest',
            'reviewNodeId',
            'reviewResultDigest',
            'reviewDispositionNodeId',
            'reviewRoleResultDigest',
            'reviewRoleResultForm',
            'reviewOrchestration',
            'reviewGrantId',
            'reviewGrantEnvelopeDigest',
            'reviewGrantUseDigest',
            'reviewGrantTransitionDigest',
            'directHumanReviewAttestationDigest',
            'requiredIndependence',
            'achievedIndependence',
            'degradationAuthorized',
            'advisoryVerdict',
        ]) ||
        !['sealed-investigation', 'investigation-exemption'].includes(String(value.applicabilityKind)) ||
        !isDigest(value.applicabilityDigest) ||
        !isDigest(value.applicabilityNodeId) ||
        !isRecord(value.investigationBaseline) ||
        !hasExactKeys(value.investigationBaseline, ['head', 'tree']) ||
        !isCommitHash(value.investigationBaseline.head) ||
        !isCommitHash(value.investigationBaseline.tree) ||
        !isDigest(value.planningGenerationId) ||
        !isDigest(value.planTargetDigest) ||
        !isDigest(value.reviewNodeId) ||
        !isDigest(value.reviewResultDigest) ||
        (value.reviewDispositionNodeId !== null &&
            !isDigest(value.reviewDispositionNodeId)) ||
        !isDigest(value.reviewRoleResultDigest) ||
        ![
            'ordinary-provider',
            'granted-same-provider',
            'granted-caller-supplied',
            'direct-human-attestation',
        ].includes(String(value.reviewRoleResultForm)) ||
        ![
            'engine-spawned-provider',
            'caller-supplied',
            'direct-human-review',
        ].includes(String(value.reviewOrchestration)) ||
        (value.reviewGrantId !== null && !isUuid(value.reviewGrantId)) ||
        !isNullableDigest(value.reviewGrantEnvelopeDigest) ||
        !isNullableDigest(value.reviewGrantUseDigest) ||
        !isNullableDigest(value.reviewGrantTransitionDigest) ||
        !isNullableDigest(value.directHumanReviewAttestationDigest) ||
        value.requiredIndependence !== 'provider-independent' ||
        ![
            'provider-independent',
            'principal-independent',
            'session-independent',
            'none',
        ].includes(String(value.achievedIndependence)) ||
        typeof value.degradationAuthorized !== 'boolean' ||
        !['advisory-approve', 'advisory-reject'].includes(String(value.advisoryVerdict))) {
        return false;
    }
    const hasGrant = value.reviewRoleResultForm !== 'ordinary-provider';
    const grantRefs = [
        value.reviewGrantId,
        value.reviewGrantEnvelopeDigest,
        value.reviewGrantUseDigest,
        value.reviewGrantTransitionDigest,
    ];
    return (grantRefs.every((reference) => hasGrant ? reference !== null : reference === null) &&
        value.degradationAuthorized === hasGrant &&
        (hasGrant
            ? value.achievedIndependence !== 'provider-independent'
            : value.achievedIndependence === 'provider-independent') &&
        (value.reviewRoleResultForm === 'direct-human-attestation'
            ? value.directHumanReviewAttestationDigest !== null
            : value.directHumanReviewAttestationDigest === null));
}
export function loadWorkflowConfig(repositoryRoot) {
    const configPath = path.join(repositoryRoot, 'workflow/config.json');
    const value = readJson(configPath, 'workflow configuration');
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.repositoryName !== 'string' ||
        typeof value.changeRoot !== 'string' ||
        typeof value.runtimeDirectory !== 'string' ||
        !isStringArray(value.protectedBranches) ||
        typeof value.branchTemplate !== 'string' ||
        !value.branchTemplate.includes('{changeId}')) {
        throw invalidContract('INVALID_WORKFLOW_CONFIG', 'workflow/config.json does not match schema version 1.', configPath);
    }
    normalizePolicyPath(value.changeRoot);
    normalizePolicyPath(value.runtimeDirectory);
    return value;
}
export function loadChecksConfig(repositoryRoot) {
    const checksPath = path.join(repositoryRoot, 'workflow/checks.json');
    const value = readJson(checksPath, 'check configuration');
    if (!isRecord(value) ||
        value.schemaVersion !== 1 ||
        !isRecord(value.checks)) {
        throw invalidContract('INVALID_CHECKS_CONFIG', 'workflow/checks.json does not match schema version 1.', checksPath);
    }
    for (const [checkId, definition] of Object.entries(value.checks)) {
        if (!CHECK_ID_PATTERN.test(checkId) ||
            !isRecord(definition) ||
            !isStringArray(definition.command) ||
            !parseCheckCommand(definition.command) ||
            typeof definition.destructiveDatabase !== 'boolean') {
            throw invalidContract('INVALID_CHECK_DEFINITION', `Invalid check definition: ${checkId}`, checksPath);
        }
    }
    return value;
}
export function parseCheckCommand(command) {
    if (command.length < 2 ||
        command.some((part) => part.trim() !== part ||
            [...part].some((character) => {
                const codePoint = character.codePointAt(0) ?? 0;
                return codePoint <= 31 || codePoint === 127;
            }))) {
        return undefined;
    }
    if (command[0] === 'node') {
        const args = command.slice(1);
        const entrypoints = nodeEntrypoints(args);
        return entrypoints ? { runner: 'node', args, entrypoints } : undefined;
    }
    if (command[0] !== 'node-package-bin' || command.length < 4) {
        return undefined;
    }
    const [, workspace, packageName, binName, ...args] = command;
    if ((workspace !== '.' && !isExactPolicyPath(workspace)) ||
        !isPackageName(packageName) ||
        !isPackageSegment(binName)) {
        return undefined;
    }
    return {
        runner: 'node-package-bin',
        workspace,
        packageName,
        binName,
        args,
    };
}
function nodeEntrypoints(args) {
    let entrypoints;
    if (args[0] === '--test') {
        entrypoints = args.slice(1);
    }
    else if (args[0] === '--experimental-strip-types' && args[1] === '--test') {
        entrypoints = args.slice(2);
    }
    else {
        if (!args[0] || args[0].startsWith('-')) {
            return undefined;
        }
        entrypoints = [args[0]];
    }
    return entrypoints.length > 0 && entrypoints.every(isExactPolicyPath)
        ? entrypoints
        : undefined;
}
function isExactPolicyPath(value) {
    if (value.startsWith('-')) {
        return false;
    }
    try {
        normalizePolicyPath(value);
        return value !== '.' && !value.endsWith('/**');
    }
    catch {
        return false;
    }
}
function isPackageName(value) {
    if (value.length > 214) {
        return false;
    }
    const segments = value.startsWith('@') ? value.slice(1).split('/') : [value];
    return ((segments.length === 1 || segments.length === 2) &&
        segments.every(isPackageSegment));
}
function isPackageSegment(value) {
    return /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value);
}
export function loadChangeContract(repositoryRootInput, requestedChangeId, expectedSchemaName) {
    const repositoryRoot = path.resolve(repositoryRootInput);
    const changeId = assertChangeId(requestedChangeId);
    if (changeId === 'archive') {
        throw workflowError('PLANNING_CHANGE_ID_RESERVED', 'The OpenSpec archive container cannot be used as an active change ID.', ExitCode.guard);
    }
    const config = loadWorkflowConfig(repositoryRoot);
    const checks = loadChecksConfig(repositoryRoot);
    const changeDirectory = path.join(repositoryRoot, config.changeRoot, changeId);
    const metadataPath = path.join(changeDirectory, '.openspec.yaml');
    const schemaName = readChangeSchemaName(repositoryRoot, metadataPath);
    if (expectedSchemaName && schemaName !== expectedSchemaName) {
        throw workflowError('OPENSPEC_CHANGE_STATE_CHANGED', 'Managed change schema selection changed while the contract was loaded.', ExitCode.staleState);
    }
    const proposalPath = path.join(changeDirectory, 'proposal.md');
    const designPath = path.join(changeDirectory, 'design.md');
    const tasksPath = path.join(changeDirectory, 'tasks.md');
    const guardPath = path.join(changeDirectory, 'guard.json');
    const investigationPath = path.join(changeDirectory, 'investigation.json');
    const executionPath = path.join(changeDirectory, 'execution.json');
    const planReviewPath = path.join(changeDirectory, 'plan-review.json');
    const requiredPaths = [
        proposalPath,
        designPath,
        tasksPath,
        guardPath,
        ...(schemaName === 'expense-app-v2'
            ? [investigationPath, executionPath, planReviewPath]
            : []),
    ];
    for (const requiredPath of requiredPaths) {
        if (!fs.statSync(requiredPath, { throwIfNoEntry: false })?.isFile()) {
            throw invalidContract('MISSING_CHANGE_ARTIFACT', `Required change artifact is missing: ${relative(repositoryRoot, requiredPath)}`, requiredPath);
        }
    }
    const specPaths = listMarkdownFiles(path.join(changeDirectory, 'specs'));
    if (specPaths.length === 0) {
        throw invalidContract('MISSING_DELTA_SPEC', `Change ${changeId} must contain at least one delta spec.`, path.join(changeDirectory, 'specs'));
    }
    const behaviorContracts = indexBehaviorContracts(changeDirectory, specPaths);
    const guard = parseGuardContract(guardPath, changeId);
    const tasks = parseTasks(fs.readFileSync(tasksPath, 'utf8'));
    if (tasks.length === 0) {
        throw invalidContract('EMPTY_TASK_LIST', `Change ${changeId} has no parseable tasks.`, tasksPath);
    }
    const markdownTaskIds = new Set(tasks.map((task) => task.id));
    const guardTaskIds = new Set(Object.keys(guard.tasks));
    for (const [taskId, policy] of Object.entries(guard.tasks)) {
        assertTaskId(taskId);
        validateTaskPolicy(repositoryRoot, taskId, policy, checks);
    }
    const missingPolicies = [...markdownTaskIds].filter((taskId) => !guardTaskIds.has(taskId));
    const unknownPolicies = [...guardTaskIds].filter((taskId) => !markdownTaskIds.has(taskId));
    if (missingPolicies.length > 0 || unknownPolicies.length > 0) {
        throw invalidContract('TASK_POLICY_MISMATCH', `tasks.md and guard.json task IDs differ for change ${changeId}.`, guardPath, { missingPolicies, unknownPolicies });
    }
    const investigation = schemaName === 'expense-app-v2'
        ? parseInvestigationArtifact(readCanonicalJson(investigationPath, 'investigation artifact', 'INVALID_INVESTIGATION_ARTIFACT'), changeId)
        : undefined;
    const execution = schemaName === 'expense-app-v2'
        ? parseExecutionArtifact(readCanonicalJson(executionPath, 'execution artifact', 'INVALID_EXECUTION_ARTIFACT'), changeId, tasks, guard, checks, behaviorContracts)
        : undefined;
    const planReview = schemaName === 'expense-app-v2'
        ? parsePlanReviewArtifact(readCanonicalJson(planReviewPath, 'plan review artifact', 'INVALID_PLAN_REVIEW_ARTIFACT'), changeId)
        : undefined;
    const artifactPaths = [
        proposalPath,
        designPath,
        tasksPath,
        guardPath,
        ...(schemaName === 'expense-app-v2'
            ? [investigationPath, executionPath, planReviewPath]
            : []),
        ...specPaths,
        ...workflowContractArtifactPaths(repositoryRoot),
    ];
    return {
        changeId,
        changeDirectory,
        schemaName,
        config,
        checks,
        guard,
        tasks,
        behaviorContracts,
        ...(investigation ? { investigation } : {}),
        ...(execution ? { execution } : {}),
        ...(planReview ? { planReview } : {}),
        artifactPaths,
        artifactDigests: digestArtifacts(repositoryRoot, artifactPaths),
    };
}
export function readManagedSchemaName(repositoryRoot, metadataPath) {
    const schemaName = readChangeSchemaName(repositoryRoot, metadataPath);
    if (schemaName === 'spec-driven') {
        throw workflowError('OPENSPEC_MANAGED_SCHEMA_REQUIRED', 'Managed changes must declare a reviewed expense-app schema.', ExitCode.verification);
    }
    return schemaName;
}
export function readChangeSchemaName(repositoryRoot, metadataPath) {
    let descriptor;
    let content;
    try {
        const repository = canonicalRepositoryRoot(repositoryRoot);
        const absolutePath = path.resolve(metadataPath);
        const artifactRelativePath = repositoryRelativePath(repository, absolutePath);
        if (!artifactRelativePath) {
            throw new Error('metadata path escapes the repository');
        }
        const before = fs.lstatSync(absolutePath, { bigint: true });
        if (!before.isFile() ||
            before.isSymbolicLink() ||
            fs.realpathSync(absolutePath) !==
                path.join(repository.canonicalRoot, artifactRelativePath) ||
            logicalGitFileMode(before.mode) !== '100644') {
            throw new Error('unsafe metadata');
        }
        descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
            throw new Error('metadata identity changed before reading');
        }
        content = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
        if (!sameArtifactIdentity(opened, after) ||
            !sameArtifactIdentity(before, pathAfter) ||
            fs.realpathSync(absolutePath) !==
                path.join(repository.canonicalRoot, artifactRelativePath)) {
            throw new Error('metadata identity changed while reading');
        }
    }
    catch {
        throw unsafeManagedMetadata();
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    }
    catch {
        throw invalidMetadata();
    }
    if (text.startsWith('\uFEFF') || text.includes('\0') || text.includes('\r')) {
        throw invalidMetadata();
    }
    if (text === 'schema: spec-driven\n') {
        return 'spec-driven';
    }
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
    const fields = new Map();
    for (const line of lines) {
        const match = /^([a-z][a-z0-9-]*): ([^\s].*)$/.exec(line);
        if (!match || fields.has(match[1])) {
            throw invalidMetadata();
        }
        fields.set(match[1], match[2]);
    }
    if (fields.size !== 2 ||
        !fields.has('schema') ||
        !fields.has('created') ||
        !isCanonicalDate(fields.get('created') ?? '')) {
        throw invalidMetadata();
    }
    const schemaName = fields.get('schema');
    if (schemaName !== 'spec-driven' &&
        schemaName !== 'expense-app' &&
        schemaName !== 'expense-app-v2') {
        throw workflowError('OPENSPEC_MANAGED_SCHEMA_REQUIRED', 'Managed changes must declare a reviewed expense-app schema.', ExitCode.verification);
    }
    return schemaName;
}
export function parseInvestigationArtifact(value, expectedChangeId) {
    const optionalKeys = optionalArtifactKeys(value, [
        'applicability',
        'roleResults',
    ]);
    const artifact = parseEvidenceArtifactBundle(value, expectedChangeId, 'investigation-artifact', 'INVALID_INVESTIGATION_ARTIFACT', [
        'changeId',
        'currentRefs',
        'kind',
        'legacyMigration',
        'nodes',
        'schemaVersion',
        ...optionalKeys,
    ]);
    if (!isRecord(value) ||
        typeof value.legacyMigration !== 'boolean' ||
        (value.legacyMigration &&
            expectedChangeId !== 'establish-investigation-first-planning')) {
        throw artifactInvalid('INVALID_INVESTIGATION_ARTIFACT', 'investigation.json does not match schema version 1.');
    }
    const applicability = isRecord(value) && Object.hasOwn(value, 'applicability')
        ? assertInvestigationApplicability(value.applicability)
        : undefined;
    const roleResults = parseOptionalRoleResults(value);
    return {
        ...artifact,
        kind: 'investigation-artifact',
        legacyMigration: value.legacyMigration,
        ...(applicability ? { applicability } : {}),
        ...(roleResults ? { roleResults } : {}),
    };
}
export function parsePlanReviewArtifact(value, expectedChangeId) {
    const optionalKeys = optionalArtifactKeys(value, ['roleResults']);
    const artifact = parseEvidenceArtifactBundle(value, expectedChangeId, 'plan-review-artifact', 'INVALID_PLAN_REVIEW_ARTIFACT', [
        'changeId',
        'currentRefs',
        'kind',
        'nodes',
        'schemaVersion',
        ...optionalKeys,
    ]);
    const roleResults = parseOptionalRoleResults(value);
    return {
        ...artifact,
        kind: 'plan-review-artifact',
        ...(roleResults ? { roleResults } : {}),
    };
}
function optionalArtifactKeys(value, allowed) {
    if (!isRecord(value)) {
        return [];
    }
    return allowed.filter((key) => Object.hasOwn(value, key));
}
function parseOptionalRoleResults(value) {
    if (!isRecord(value) || !Object.hasOwn(value, 'roleResults')) {
        return undefined;
    }
    if (!Array.isArray(value.roleResults) || value.roleResults.length === 0) {
        throw artifactInvalid(value.kind === 'investigation-artifact'
            ? 'INVALID_INVESTIGATION_ARTIFACT'
            : 'INVALID_PLAN_REVIEW_ARTIFACT', 'Tracked role results must be a non-empty array when present.');
    }
    return structuredClone(value.roleResults);
}
export function parseExecutionArtifact(value, expectedChangeId, tasks, guard, checks, behaviorContracts) {
    const invalid = () => artifactInvalid('INVALID_EXECUTION_ARTIFACT', 'execution.json does not match schema version 1.');
    if (!isRecord(value) ||
        !hasExactKeys(value, ['changeId', 'kind', 'schemaVersion', 'tasks']) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'execution-artifact' ||
        value.changeId !== expectedChangeId ||
        !isRecord(value.tasks) ||
        Object.keys(value.tasks).length === 0) {
        throw invalid();
    }
    const expectedTaskIds = tasks.map(({ id }) => id);
    const executionTaskIds = Object.keys(value.tasks);
    if (!sameMembers(executionTaskIds, expectedTaskIds) ||
        !sameMembers(executionTaskIds, Object.keys(guard.tasks))) {
        throw invalid();
    }
    const parsedTasks = {};
    for (const taskId of expectedTaskIds) {
        const policy = guard.tasks[taskId];
        const task = tasks.find(({ id }) => id === taskId);
        const candidate = value.tasks[taskId];
        if (!policy || !task || !isRecord(candidate)) {
            throw invalid();
        }
        const commonKeys = [
            'allowedPaths',
            'diffReview',
            'enforcement',
            'requiredChecks',
            'strategy',
        ];
        if (!isStringArray(candidate.allowedPaths) ||
            !isStringArray(candidate.requiredChecks) ||
            JSON.stringify(candidate.allowedPaths) !==
                JSON.stringify(policy.allowedPaths) ||
            JSON.stringify(candidate.requiredChecks) !==
                JSON.stringify(policy.requiredChecks) ||
            (candidate.enforcement !== 'available' &&
                candidate.enforcement !== 'planned') ||
            (candidate.diffReview !== 'required' &&
                candidate.diffReview !== 'policy-required') ||
            candidate.requiredChecks.some((checkId) => !Object.hasOwn(checks.checks, checkId))) {
            throw invalid();
        }
        if (candidate.strategy === 'cross-agent-tdd' ||
            candidate.strategy === 'tdd-single-agent') {
            if (!hasExactKeys(candidate, [
                ...commonKeys,
                'behaviorContractRefs',
                'fixturePathScopes',
                'greenChecks',
                'implementationPathScopes',
                'redCheck',
                'requiredImplementerIndependence',
                'testPathScopes',
            ]) ||
                !areResolvedBehaviorContractRefs(candidate.behaviorContractRefs, behaviorContracts) ||
                !isScopePartition(candidate.testPathScopes, policy.allowedPaths, true) ||
                !isScopePartition(candidate.fixturePathScopes, policy.allowedPaths) ||
                !isScopePartition(candidate.implementationPathScopes, policy.allowedPaths, true) ||
                !implementationScopesAreDisjoint(candidate.implementationPathScopes, candidate.testPathScopes, candidate.fixturePathScopes) ||
                typeof candidate.redCheck !== 'string' ||
                !isStringArray(candidate.greenChecks) ||
                JSON.stringify(candidate.greenChecks) !==
                    JSON.stringify(policy.requiredChecks) ||
                !candidate.greenChecks.includes(candidate.redCheck) ||
                candidate.enforcement !== 'planned' ||
                candidate.requiredImplementerIndependence !==
                    (candidate.strategy === 'cross-agent-tdd'
                        ? 'provider-independent'
                        : 'none')) {
                throw invalid();
            }
            parsedTasks[taskId] = candidate;
            continue;
        }
        if (candidate.strategy === 'mechanical-transform') {
            if (!hasExactKeys(candidate, [...commonKeys, 'transformationContract']) ||
                candidate.enforcement !== 'planned' ||
                !isTransformationContract(candidate.transformationContract, policy.allowedPaths)) {
                throw invalid();
            }
            parsedTasks[taskId] = candidate;
            continue;
        }
        if (candidate.strategy === 'direct-reviewed') {
            if (!hasExactKeys(candidate, [
                ...commonKeys,
                'exemptionKind',
                'exemptionReason',
                'legacyBootstrap',
            ]) ||
                ![
                    'documentation-only',
                    'formatting-only',
                    'dependency-only',
                    'narrowly-scoped-non-behavioral',
                    'legacy-bootstrap',
                ].includes(String(candidate.exemptionKind)) ||
                !isSemanticText(candidate.exemptionReason)) {
                throw invalid();
            }
            const legacyBootstrap = candidate.legacyBootstrap;
            if (candidate.exemptionKind === 'legacy-bootstrap'
                ? expectedChangeId !== 'establish-investigation-first-planning' ||
                    taskId !== '7.1' ||
                    legacyBootstrap !== 'establish-investigation-first-planning'
                : legacyBootstrap !== null) {
                throw invalid();
            }
            parsedTasks[taskId] = candidate;
            continue;
        }
        throw invalid();
    }
    return {
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: expectedChangeId,
        tasks: parsedTasks,
    };
}
function parseEvidenceArtifactBundle(value, expectedChangeId, expectedKind, errorCode, exactKeys) {
    const invalid = () => artifactInvalid(errorCode, `${expectedKind} does not match schema version 1.`);
    if (!isRecord(value) ||
        !hasExactKeys(value, exactKeys) ||
        value.schemaVersion !== 1 ||
        value.kind !== expectedKind ||
        value.changeId !== expectedChangeId ||
        !Array.isArray(value.nodes) ||
        value.nodes.length === 0 ||
        !isRecord(value.currentRefs) ||
        Object.keys(value.currentRefs).length === 0) {
        throw invalid();
    }
    const nodes = value.nodes.map((node) => assertStoredEvidenceNode(node, invalid));
    try {
        validateEvidenceArtifactNodes(nodes);
    }
    catch {
        throw invalid();
    }
    const nodeIds = nodes.map(({ nodeId }) => nodeId);
    if (new Set(nodeIds).size !== nodeIds.length ||
        JSON.stringify(nodeIds) !== JSON.stringify([...nodeIds].sort()) ||
        nodes.some(({ runtimeMetadata }) => Object.keys(runtimeMetadata).length > 0)) {
        throw invalid();
    }
    const nodeIdSet = new Set(nodeIds);
    if (nodes.some((node) => Object.values(node.provenanceParentNodeIds).some((parentNodeId) => !nodeIdSet.has(parentNodeId)))) {
        throw invalid();
    }
    const currentRefs = {};
    for (const [role, nodeId] of Object.entries(value.currentRefs)) {
        if (!/^[a-zA-Z0-9]+(?:[._:/-][a-zA-Z0-9]+)*$/.test(role) ||
            typeof nodeId !== 'string' ||
            !/^[0-9a-f]{64}$/.test(nodeId) ||
            !nodeIdSet.has(nodeId)) {
            throw invalid();
        }
        currentRefs[role] = nodeId;
    }
    try {
        validateTrackedEvidenceReusePaths(nodes, currentRefs);
    }
    catch {
        throw invalid();
    }
    return {
        schemaVersion: 1,
        kind: expectedKind,
        changeId: expectedChangeId,
        nodes,
        currentRefs,
    };
}
function validateEvidenceArtifactNodes(nodes) {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const ordinaryNodes = nodes.filter(({ type }) => type !== 'evidence-convergence' && type !== 'evidence-reuse-proof');
    validateClosedEvidenceDag(ordinaryNodes);
    for (const node of nodes.filter(({ type }) => type === 'evidence-convergence')) {
        const binding = readConvergenceBinding(node);
        const oldParent = binding ? byId.get(binding.oldParentNode) : undefined;
        const newParent = binding ? byId.get(binding.newParentNode) : undefined;
        if (!binding || !oldParent || !newParent) {
            throw new Error('invalid convergence record');
        }
        const reconstructed = createConvergenceRecord({
            oldParent,
            newParent,
            validatorVersion: binding.validatorVersion,
            runtimeMetadata: {},
        });
        if (canonicalJson(reconstructed) !== canonicalJson(node)) {
            throw new Error('invalid convergence record');
        }
    }
    for (const node of nodes.filter(({ type }) => type === 'evidence-reuse-proof')) {
        const binding = readReuseProofBinding(node);
        const descendant = binding ? byId.get(binding.descendantNode) : undefined;
        const oldParent = binding ? byId.get(binding.oldParentNode) : undefined;
        const newParent = binding ? byId.get(binding.newParentNode) : undefined;
        const convergenceRecord = binding
            ? byId.get(binding.convergenceNode)
            : undefined;
        if (!binding ||
            !descendant ||
            !oldParent ||
            !newParent ||
            !convergenceRecord) {
            throw new Error('invalid descendant reuse proof');
        }
        const reconstructed = createDescendantReuseProof({
            descendant,
            parentRole: binding.parentRole,
            oldParent,
            newParent,
            convergenceRecord,
            validatorVersion: binding.validatorVersion,
            runtimeMetadata: {},
        });
        if (canonicalJson(reconstructed) !== canonicalJson(node)) {
            throw new Error('invalid descendant reuse proof');
        }
    }
}
export function parseTasks(markdown) {
    const tasks = [];
    const seen = new Set();
    const lines = markdown.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        const match = /^- \[([ xX])\] (\d+(?:\.\d+)+)\s+(.+)$/.exec(lines[index]);
        if (!match || match[3].trim().length === 0) {
            if (looksLikeTaskCheckbox(lines[index])) {
                throw workflowError('MALFORMED_TASK_LINE', `Malformed workflow task at line ${index + 1}.`, ExitCode.guard, { details: { lineNumber: index + 1 } });
            }
            continue;
        }
        const id = assertTaskId(match[2]);
        if (seen.has(id)) {
            throw workflowError('DUPLICATE_TASK_ID', `Duplicate task ID in tasks.md: ${id}`, ExitCode.guard);
        }
        seen.add(id);
        const titleParts = [match[3].trim()];
        while (/^\s{2,}\S/.test(lines[index + 1] ?? '')) {
            titleParts.push(lines[index + 1].trim());
            index += 1;
        }
        tasks.push({
            id,
            completed: match[1].toLowerCase() === 'x',
            title: titleParts.join(' '),
        });
    }
    return tasks;
}
function looksLikeTaskCheckbox(line) {
    const match = /^- \[([^\]]*)\](.*)$/.exec(line);
    if (!match) {
        return false;
    }
    if (match[2].startsWith('(') || match[2].startsWith('[')) {
        return false;
    }
    return match[1] === '' || /^[ xX]$/.test(match[1]) || /^\s+\d/.test(match[2]);
}
export function digestArtifacts(repositoryRoot, artifactPaths) {
    const root = canonicalRepositoryRoot(repositoryRoot);
    const entries = artifactPaths
        .map((artifactPath) => inspectArtifact(root, artifactPath))
        .sort((left, right) => compareText(left.path, right.path));
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
        throw unsafeContractArtifact();
    }
    return Object.fromEntries(entries.map((entry) => [entry.path, entry.digest]));
}
function inspectArtifact(repository, artifactPath) {
    let descriptor;
    try {
        if (!path.isAbsolute(artifactPath)) {
            throw new Error('artifact path is not absolute');
        }
        const absolutePath = path.resolve(artifactPath);
        const artifactRelativePath = repositoryRelativePath(repository, absolutePath);
        if (absolutePath !== artifactPath || !artifactRelativePath) {
            throw new Error('artifact path escapes the repository');
        }
        const before = fs.lstatSync(absolutePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (!before?.isFile() ||
            before.isSymbolicLink() ||
            fs.realpathSync(absolutePath) !==
                path.join(repository.canonicalRoot, artifactRelativePath)) {
            throw new Error('artifact is not a canonical regular file');
        }
        descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(descriptor, { bigint: true });
        if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
            throw new Error('artifact identity changed before reading');
        }
        const content = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        if (!sameArtifactIdentity(opened, after)) {
            throw new Error('artifact identity changed while reading');
        }
        const mode = logicalGitFileMode(after.mode);
        return {
            path: artifactRelativePath,
            digest: mode === '100644'
                ? crypto.createHash('sha256').update(content).digest('hex')
                : crypto
                    .createHash('sha256')
                    .update('workflow-contract-artifact\0mode:100755\0')
                    .update(content)
                    .digest('hex'),
        };
    }
    catch (error) {
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'UNSAFE_CONTRACT_ARTIFACT') {
            throw error;
        }
        throw unsafeContractArtifact();
    }
    finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}
function canonicalRepositoryRoot(repositoryRoot) {
    try {
        const absoluteRoot = path.resolve(repositoryRoot);
        const stats = fs.lstatSync(absoluteRoot);
        const canonicalRoot = fs.realpathSync(absoluteRoot);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error('repository root is not canonical');
        }
        return { lexicalRoot: absoluteRoot, canonicalRoot };
    }
    catch {
        throw unsafeContractArtifact();
    }
}
function repositoryRelativePath(repository, artifactPath) {
    for (const root of [repository.lexicalRoot, repository.canonicalRoot]) {
        const candidate = relative(root, artifactPath);
        if (candidate !== '' &&
            candidate !== '..' &&
            !candidate.startsWith('../') &&
            !path.isAbsolute(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
function logicalGitFileMode(mode) {
    return (mode & 73n) === 0n ? '100644' : '100755';
}
function sameArtifactIdentity(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
function unsafeContractArtifact() {
    return workflowError('UNSAFE_CONTRACT_ARTIFACT', 'Workflow contract artifacts must be canonical repository regular files.', ExitCode.guard);
}
function parseGuardContract(guardPath, expectedChangeId) {
    const value = readJson(guardPath, 'guard policy');
    if (!isRecord(value) ||
        !hasExactKeys(value, ['changeId', 'schemaVersion', 'tasks']) ||
        value.schemaVersion !== 1 ||
        value.changeId !== expectedChangeId ||
        !isRecord(value.tasks) ||
        Object.keys(value.tasks).length === 0) {
        throw invalidContract('INVALID_GUARD_CONTRACT', `guard.json is invalid or does not name change ${expectedChangeId}.`, guardPath);
    }
    for (const [taskId, policy] of Object.entries(value.tasks)) {
        if (!isRecord(policy) ||
            !hasExactKeys(policy, ['allowedPaths', 'requiredChecks']) ||
            !isStringArray(policy.allowedPaths) ||
            policy.allowedPaths.length === 0 ||
            !isStringArray(policy.requiredChecks) ||
            policy.requiredChecks.length === 0) {
            throw invalidContract('INVALID_TASK_POLICY', `Invalid guard policy for task ${taskId}.`, guardPath);
        }
    }
    return value;
}
function validateTaskPolicy(repositoryRoot, taskId, policy, checks) {
    const normalizedPaths = policy.allowedPaths.map((policyPath) => {
        const normalized = normalizePolicyPath(policyPath);
        assertPolicyPathInsideRepository(repositoryRoot, normalized);
        return normalized;
    });
    if (new Set(normalizedPaths).size !== normalizedPaths.length) {
        throw workflowError('DUPLICATE_ALLOWED_PATH', `Task ${taskId} contains duplicate allowed paths.`, ExitCode.guard);
    }
    const malformedChecks = policy.requiredChecks.filter((checkId) => !CHECK_ID_PATTERN.test(checkId));
    if (malformedChecks.length > 0) {
        throw workflowError('INVALID_REQUIRED_CHECK_ID', `Task ${taskId} contains malformed required check IDs: ${malformedChecks.join(', ')}`, ExitCode.guard, { details: { taskId, malformedChecks } });
    }
    if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) {
        throw workflowError('DUPLICATE_REQUIRED_CHECK', `Task ${taskId} contains duplicate required checks.`, ExitCode.guard);
    }
    const unknownChecks = policy.requiredChecks.filter((checkId) => !Object.hasOwn(checks.checks, checkId));
    if (unknownChecks.length > 0) {
        throw workflowError('UNKNOWN_REQUIRED_CHECK', `Task ${taskId} references unknown checks: ${unknownChecks.join(', ')}`, ExitCode.guard, { details: { taskId, unknownChecks } });
    }
}
function hasExactKeys(value, expectedKeys) {
    const actualKeys = Object.keys(value);
    return (actualKeys.length === expectedKeys.length &&
        expectedKeys.every((key) => Object.hasOwn(value, key)));
}
function isDigest(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function isNullableDigest(value) {
    return value === null || isDigest(value);
}
function isCommitHash(value) {
    return (typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value));
}
function isUuid(value) {
    return (typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));
}
function listMarkdownFiles(directory) {
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
        return [];
    }
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...listMarkdownFiles(entryPath));
        }
        else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(entryPath);
        }
    }
    return files.sort();
}
function indexBehaviorContracts(changeDirectory, specPaths) {
    const refs = [];
    for (const specPath of specPaths) {
        const relativeSpecPath = relative(changeDirectory, specPath);
        if (!isDeltaSpecReferencePath(relativeSpecPath)) {
            continue;
        }
        const requirements = new Map();
        let currentRequirement;
        for (const line of fs.readFileSync(specPath, 'utf8').split('\n')) {
            const requirementMatch = /^### Requirement: (.+)$/.exec(line);
            if (requirementMatch) {
                const title = requirementMatch[1];
                if (!isReferenceTitle(title)) {
                    currentRequirement = undefined;
                    continue;
                }
                currentRequirement = requirements.get(title) ?? {
                    count: 0,
                    scenarios: new Map(),
                };
                currentRequirement.count += 1;
                requirements.set(title, currentRequirement);
                continue;
            }
            if (/^#{1,3}(?:\s|$)/.test(line)) {
                currentRequirement = undefined;
                continue;
            }
            const scenarioMatch = /^#### Scenario: (.+)$/.exec(line);
            if (!scenarioMatch ||
                !currentRequirement ||
                !isReferenceTitle(scenarioMatch[1])) {
                continue;
            }
            const title = scenarioMatch[1];
            currentRequirement.scenarios.set(title, (currentRequirement.scenarios.get(title) ?? 0) + 1);
        }
        for (const [requirement, entry] of requirements) {
            if (entry.count !== 1) {
                continue;
            }
            refs.push({ specPath: relativeSpecPath, requirement, scenario: null });
            for (const [scenario, count] of entry.scenarios) {
                if (count === 1) {
                    refs.push({ specPath: relativeSpecPath, requirement, scenario });
                }
            }
        }
    }
    return refs.sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
}
function readCanonicalJson(filePath, label, errorCode) {
    let text;
    let value;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath));
        value = JSON.parse(text);
        if (text !== `${canonicalJson(value)}\n`) {
            throw new Error('noncanonical JSON');
        }
    }
    catch {
        throw invalidContract(errorCode, `Unable to read canonical ${label}.`, filePath);
    }
    return value;
}
function isScopePartition(value, allowedPaths, requireNonEmpty = false) {
    return (isStringArray(value) &&
        (!requireNonEmpty || value.length > 0) &&
        new Set(value).size === value.length &&
        value.every((scope) => isPolicyScopeInside(scope, allowedPaths)));
}
function implementationScopesAreDisjoint(implementationScopes, testScopes, fixtureScopes) {
    return implementationScopes.every((implementationScope) => [...testScopes, ...fixtureScopes].every((redScope) => !policyScopesOverlap(implementationScope, redScope)));
}
function policyScopesOverlap(left, right) {
    try {
        const normalizedLeft = normalizePolicyPath(left);
        const normalizedRight = normalizePolicyPath(right);
        const leftPrefix = normalizedLeft.endsWith('/**');
        const rightPrefix = normalizedRight.endsWith('/**');
        if (!leftPrefix && !rightPrefix) {
            return normalizedLeft === normalizedRight;
        }
        if (!leftPrefix) {
            return matchesAllowedPath(normalizedLeft, normalizedRight);
        }
        if (!rightPrefix) {
            return matchesAllowedPath(normalizedRight, normalizedLeft);
        }
        return (matchesAllowedPath(normalizedLeft.slice(0, -3), normalizedRight) ||
            matchesAllowedPath(normalizedRight.slice(0, -3), normalizedLeft));
    }
    catch {
        return true;
    }
}
function isPolicyScopeInside(scope, allowedPaths) {
    try {
        const normalizedScope = normalizePolicyPath(scope);
        if (!normalizedScope.endsWith('/**')) {
            return allowedPaths.some((allowedPath) => matchesAllowedPath(normalizedScope, allowedPath));
        }
        const scopeBase = normalizedScope.slice(0, -3);
        return allowedPaths.some((allowedPath) => {
            const normalizedAllowed = normalizePolicyPath(allowedPath);
            return (normalizedAllowed.endsWith('/**') &&
                matchesAllowedPath(scopeBase, normalizedAllowed));
        });
    }
    catch {
        return false;
    }
}
function isTransformationContract(value, allowedPaths) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'examples',
            'fileScopes',
            'oldTerms',
            'redInapplicableReason',
            'replacementTerms',
            'rule',
        ]) ||
        !isSemanticText(value.rule) ||
        !isSemanticText(value.redInapplicableReason) ||
        !isScopePartition(value.fileScopes, allowedPaths, true) ||
        !Array.isArray(value.examples) ||
        value.examples.length === 0 ||
        !Array.isArray(value.oldTerms) ||
        value.oldTerms.length === 0 ||
        !Array.isArray(value.replacementTerms)) {
        return false;
    }
    const examplesValid = value.examples.every((example) => isRecord(example) &&
        hasExactKeys(example, ['after', 'before']) &&
        isSemanticText(example.before) &&
        isSemanticText(example.after) &&
        example.before !== example.after);
    const terms = [...value.oldTerms, ...value.replacementTerms];
    if (!examplesValid || !terms.every(isTransformationTerm)) {
        return false;
    }
    const oldTermKeys = new Set(value.oldTerms.map((term) => canonicalJson(term)));
    const replacementTermKeys = new Set(value.replacementTerms.map((term) => canonicalJson(term)));
    if (new Set(value.examples.map((example) => canonicalJson(example))).size !==
        value.examples.length ||
        oldTermKeys.size !== value.oldTerms.length ||
        replacementTermKeys.size !== value.replacementTerms.length ||
        [...oldTermKeys].some((term) => replacementTermKeys.has(term))) {
        return false;
    }
    return true;
}
function isTransformationTerm(value) {
    return (isRecord(value) &&
        hasExactKeys(value, ['kind', 'value']) &&
        ['path', 'content', 'symbol', 'config'].includes(String(value.kind)) &&
        isReferenceTitle(value.value));
}
function areResolvedBehaviorContractRefs(value, availableRefs) {
    if (!Array.isArray(value) || value.length === 0) {
        return false;
    }
    const available = new Set(availableRefs.map((ref) => canonicalJson(ref)));
    const seen = new Set();
    for (const candidate of value) {
        if (!isRecord(candidate) ||
            !hasExactKeys(candidate, ['requirement', 'scenario', 'specPath']) ||
            typeof candidate.specPath !== 'string' ||
            !isDeltaSpecReferencePath(candidate.specPath) ||
            !isReferenceTitle(candidate.requirement) ||
            (candidate.scenario !== null && !isReferenceTitle(candidate.scenario))) {
            return false;
        }
        const key = canonicalJson(candidate);
        if (seen.has(key) || !available.has(key)) {
            return false;
        }
        seen.add(key);
    }
    return true;
}
function isDeltaSpecReferencePath(value) {
    return /^specs\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/spec\.md$/.test(value);
}
function isReferenceTitle(value) {
    return (isSemanticText(value) &&
        ![...value].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
        }));
}
function isSemanticText(value) {
    if (typeof value !== 'string' || value.trim() !== value || !value) {
        return false;
    }
    const normalized = value.toLowerCase();
    return (!normalized.includes('<!--') &&
        !normalized.includes('<todo>') &&
        !normalized.includes('<placeholder>') &&
        normalized !== 'todo' &&
        normalized !== 'tbd');
}
function sameMembers(left, right) {
    return (left.length === right.length && left.every((value) => right.includes(value)));
}
function isCanonicalDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
    return (!Number.isNaN(milliseconds) &&
        new Date(milliseconds).toISOString().slice(0, 10) === value);
}
function invalidMetadata() {
    return workflowError('OPENSPEC_CHANGE_METADATA_INVALID', 'Managed change metadata must contain one reviewed schema and canonical created date.', ExitCode.guard);
}
function unsafeManagedMetadata() {
    return workflowError('OPENSPEC_CHANGE_TREE_UNSAFE', 'Managed change metadata must be a canonical non-executable repository file.', ExitCode.unsafeEnvironment);
}
function artifactInvalid(code, message) {
    return workflowError(code, message, ExitCode.guard);
}
function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch (error) {
        throw workflowError('UNREADABLE_CONTRACT', `Unable to read ${label}: ${relative(process.cwd(), filePath)}`, ExitCode.unsafeEnvironment, {
            details: {
                filePath,
                cause: error instanceof Error ? error.message : String(error),
            },
        });
    }
}
function invalidContract(code, message, filePath, details = {}) {
    return workflowError(code, message, ExitCode.guard, {
        details: { filePath, ...details },
    });
}
function relative(root, target) {
    return path.relative(root, target).split(path.sep).join('/');
}
