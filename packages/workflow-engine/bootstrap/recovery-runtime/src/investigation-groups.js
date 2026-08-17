import crypto from 'node:crypto';
import { SCAN_HIT_MAX_CONTEXT_BYTES, } from './investigation-scanner.js';
import { canonicalJson } from './canonical-json.js';
import { ExitCode, WorkflowError, workflowError } from './errors.js';
import { assertStoredEvidenceNode, createEvidenceNode, } from './evidence-node.js';
import { validateClosedEvidenceDag } from './evidence-currentness.js';
import { assertMutationClassPolicy, assertPathIdentity, classifyMutationPath, MUTATION_CLASSES, } from './mutation-class-policy.js';
const EVALUATOR = 'investigation-groups.v1';
const HIT_TYPE = 'investigation-hit';
const HIT_SCHEMA = 'investigation.hit.v1';
const HIT_OUTPUT_SCHEMA = 'investigation.hit-output.v1';
const GROUP_TYPE = 'investigation-group';
const GROUP_SCHEMA = 'investigation.group.v1';
const GROUP_OUTPUT_SCHEMA = 'investigation.group-output.v1';
const DISPOSITION_TYPE = 'investigation-disposition';
const DISPOSITION_SCHEMA = 'investigation.disposition.v1';
const DISPOSITION_OUTPUT_SCHEMA = 'investigation.disposition-output.v1';
const COVERAGE_TYPE = 'investigation-coverage';
const COVERAGE_SCHEMA = 'investigation.coverage.v1';
const COVERAGE_OUTPUT_SCHEMA = 'investigation.coverage-output.v1';
const SCAN_TYPE = 'investigation-term-scan';
const SCAN_SCHEMA = 'investigation.term-scan.v1';
const SCAN_OUTPUT_SCHEMA = 'investigation.term-scan-output.v1';
const INVENTORY_TYPE = 'investigation-tree-inventory';
const INVENTORY_SCHEMA = 'investigation.tree-inventory.v1';
const INVENTORY_OUTPUT_SCHEMA = 'investigation.tree-inventory-output.v1';
const SCANNER_EVALUATOR = 'investigation-scanner.v1';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_MODES = new Set(['100644', '100755', '120000', '160000']);
const SCAN_SKIP_REASONS = new Set([
    'symlink',
    'submodule',
    'binary',
    'invalid-utf8',
    'oversize',
    'sensitive-path',
    'sensitive-suppressed',
    'total-budget',
    'unsupported',
]);
const MUTATION_CLASS_SET = new Set(MUTATION_CLASSES);
const DISPOSITION_CLASSIFICATIONS = new Set([
    'load-bearing',
    'test-or-mirror',
    'generated',
    'incidental-reference',
    'irrelevant',
]);
const RELATIONSHIP_KINDS = new Set(['generated', 'mirror']);
const HIT_KEYS = [
    'path',
    'sourceObject',
    'surface',
    'byteOffset',
    'byteLength',
];
const HIT_KEYS_WITH_CONTEXT = [...HIT_KEYS, 'contextWindow'];
const CONTEXT_WINDOW_KEYS = [
    'rawBase64',
    'utf8',
    'byteOffset',
    'byteLength',
    'truncated',
];
function hasOnlyKeys(value, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const present = Object.keys(value);
    return (present.length === keys.length && present.every((key) => keys.includes(key)));
}
function assertContextWindow(value, invalid) {
    const window = assertExactKeys(value, [...CONTEXT_WINDOW_KEYS], invalid);
    if (typeof window.rawBase64 !== 'string' ||
        (window.utf8 !== null && typeof window.utf8 !== 'string') ||
        !Number.isSafeInteger(window.byteOffset) ||
        window.byteOffset < 0 ||
        !Number.isSafeInteger(window.byteLength) ||
        window.byteLength <= 0 ||
        window.byteLength > SCAN_HIT_MAX_CONTEXT_BYTES ||
        typeof window.truncated !== 'boolean') {
        throw invalid('Scan hit context window is malformed.');
    }
    return {
        rawBase64: window.rawBase64,
        utf8: window.utf8,
        byteOffset: window.byteOffset,
        byteLength: window.byteLength,
        truncated: window.truncated,
    };
}
/**
 * Deterministically project one hit node per raw-byte occurrence and conservative
 * groups keyed by term, nearest declared root, extension, mutation class, and any
 * single reviewed relationship. Output is independent of scan/root/relationship
 * input order and of unrelated terms. Explicit exceptions only split coverage;
 * ambiguous roots or relationships, an invalid policy, or a spoofed path fail
 * closed.
 */
export function deriveInvestigationGroups(input) {
    const context = normalizeContext(input.mutationPolicy, input.declaredRoots, input.reviewedRelationships);
    const baseGroups = new Map();
    const hitBaseSelector = new Map();
    const hitRecords = deriveInvestigationHitRecords(input.scanNodes);
    for (const record of hitRecords) {
        const selector = baseSelectorFor(record.summary.termId, record.summary, context);
        let group = baseGroups.get(selector.selectorId);
        if (!group) {
            group = { selector, members: new Map(), exceptions: [] };
            baseGroups.set(selector.selectorId, group);
        }
        group.members.set(record.hitId, record);
        hitBaseSelector.set(record.hitId, selector.selectorId);
    }
    const finalGroups = applyExceptions(baseGroups, hitBaseSelector, input.exceptions);
    const groupNodes = finalGroups
        .map((group) => buildGroupNode(group, context.groupingPolicyDigest))
        .sort(byNodeId);
    return {
        hitNodes: hitRecords.map(({ node }) => node).sort(byNodeId),
        groupNodes,
    };
}
/**
 * Replay the deterministic hit envelopes from stored scan semantics. Hit
 * identity depends only on the scan, term, pinned tree, and exact byte locator;
 * grouping policy is intentionally not an input.
 */
export function deriveInvestigationHitNodes(scanNodes) {
    return deriveInvestigationHitRecords(scanNodes)
        .map(({ node }) => node)
        .sort(byNodeId);
}
/**
 * Materialize exact group envelopes from their compact selectors and hit
 * membership. The replay records must form a one-to-one partition of the
 * supplied hits, and each expected node ID must match recomputation.
 */
export function replayInvestigationGroupNodes(input) {
    const hitsById = new Map();
    for (const node of input.hitNodes) {
        const summary = readInvestigationHitNode(node);
        if (hitsById.has(node.nodeId)) {
            throw groupsInvalid(`Duplicate hit node: ${node.nodeId}`);
        }
        hitsById.set(node.nodeId, { hitId: node.nodeId, node, summary });
    }
    const covered = new Set();
    const replayed = input.groups.map((record) => {
        if (typeof record.nodeId !== 'string' ||
            !DIGEST_PATTERN.test(record.nodeId) ||
            typeof record.policyDigest !== 'string' ||
            !DIGEST_PATTERN.test(record.policyDigest)) {
            throw groupsInvalid('Group replay identity is malformed.');
        }
        const selector = assertGroupSelector(record.selector, groupsInvalid);
        const hitIds = assertSortedUniqueIds(record.hitIds, DIGEST_PATTERN, groupsInvalid);
        const exceptions = assertExceptionArray(record.exceptions, groupsInvalid);
        const members = new Map();
        for (const hitId of hitIds) {
            const hit = hitsById.get(hitId);
            if (!hit || covered.has(hitId)) {
                throw groupsInvalid('Group replay does not partition the current hit nodes exactly.');
            }
            covered.add(hitId);
            members.set(hitId, hit);
        }
        const node = buildGroupNode({ selector, members, exceptions }, record.policyDigest);
        if (node.nodeId !== record.nodeId) {
            throw groupsInvalid('Group replay node ID does not match recomputation.');
        }
        readInvestigationGroupNode(node);
        return node;
    });
    if (covered.size !== hitsById.size) {
        throw groupsInvalid('Group replay does not cover every current hit node exactly once.');
    }
    return replayed.sort(byNodeId);
}
/**
 * Bind one typed disposition to every current group exactly once. A duplicate
 * group input, and a missing, duplicate, unknown, invalid-classification, or
 * blank answer fails closed. Each disposition binds the group selector, blobs,
 * hit coverage, any split exceptions, and the exact semantic answer. Editing an
 * answer changes that disposition's identity and only its descendants.
 */
export function createInvestigationDispositionNodes(input) {
    const groupsById = new Map();
    for (const node of input.groupNodes) {
        const output = readInvestigationGroupNode(node);
        if (groupsById.has(output.groupId)) {
            throw dispositionsInvalid(`Duplicate group node: ${output.groupId}`);
        }
        groupsById.set(output.groupId, { node, output });
    }
    const seenGroupIds = new Set();
    const nodes = [];
    for (const answer of input.dispositions) {
        assertDispositionAnswer(answer);
        const group = groupsById.get(answer.groupId);
        if (!group) {
            throw dispositionsInvalid(`Unknown disposition group: ${answer.groupId}`);
        }
        if (seenGroupIds.has(answer.groupId)) {
            throw dispositionsInvalid(`Group dispositioned more than once: ${answer.groupId}`);
        }
        seenGroupIds.add(answer.groupId);
        nodes.push(buildDispositionNode(group, answer));
    }
    if (seenGroupIds.size !== groupsById.size) {
        throw dispositionsInvalid('Every current group requires exactly one disposition.');
    }
    return nodes.sort(byNodeId);
}
/**
 * Bind the coverage summary for one investigation: effective terms, zero-hit
 * terms, hit identities, and disposition nodes. Every set-like input is
 * canonically sorted before roles are assigned, so input order cannot change the
 * node. `effectiveTermIds` must be exactly the scanned term set, and every scan
 * plus the inventory must share one pinned tree digest and scanner policy; any
 * mismatch fails closed.
 */
export function createInvestigationCoverageNode(input) {
    const inventory = assertInventoryNode(input.inventoryNode);
    const scans = input.scanNodes.map((node) => readScanNode(node, coverageInvalid));
    let treeDigest = null;
    let scannerPolicy = null;
    for (const scan of scans) {
        if (treeDigest === null) {
            treeDigest = scan.treeDigest;
            scannerPolicy = scan.policyDigest;
        }
        else if (scan.treeDigest !== treeDigest ||
            scan.policyDigest !== scannerPolicy) {
            throw coverageInvalid('Scans disagree on the pinned tree or scanner policy.');
        }
    }
    if (treeDigest === null || scannerPolicy === null) {
        throw coverageInvalid('Coverage requires at least one scan node.');
    }
    if (inventory.exactInputDigests.tree !== treeDigest ||
        inventory.policyDigest !== scannerPolicy) {
        throw coverageInvalid('Inventory must share the scan tree digest and scanner policy.');
    }
    const scanTermIds = scans.map((scan) => scan.termId);
    const effective = [...input.effectiveTermIds].sort();
    if (canonicalJson(effective) !== canonicalJson([...scanTermIds].sort())) {
        throw coverageInvalid('Effective term set does not match the scanned term set.');
    }
    const termsWithHits = new Set();
    const provenance = { inventory: inventory.nodeId };
    const semantic = {
        inventory: inventory.resultDigest,
    };
    const sortedScans = scans.map((scan) => scan.node).sort(byNodeId);
    sortedScans.forEach((node, index) => {
        provenance[`scan-${index}`] = node.nodeId;
        semantic[`scan-${index}`] = node.resultDigest;
    });
    const sortedHits = [...input.hitNodes].sort(byNodeId);
    sortedHits.forEach((node, index) => {
        termsWithHits.add(readInvestigationHitNode(node).termId);
        provenance[`hit-${index}`] = node.nodeId;
        semantic[`hit-${index}`] = node.resultDigest;
    });
    const sortedGroups = [...input.groupNodes].sort(byNodeId);
    sortedGroups.forEach((node, index) => {
        try {
            readInvestigationGroupNode(node);
        }
        catch {
            throw coverageInvalid('Coverage contains a malformed group node.');
        }
        provenance[`group-${index}`] = node.nodeId;
        semantic[`group-${index}`] = node.resultDigest;
    });
    const sortedDispositions = [...input.dispositionNodes].sort(byNodeId);
    sortedDispositions.forEach((node, index) => {
        try {
            readInvestigationDispositionNode(node);
        }
        catch {
            throw coverageInvalid('Coverage contains a malformed disposition node.');
        }
        provenance[`disposition-${index}`] = node.nodeId;
        semantic[`disposition-${index}`] = node.resultDigest;
    });
    const zeroHitTermIds = scanTermIds
        .filter((termId) => !termsWithHits.has(termId))
        .sort();
    return createEvidenceNode({
        type: COVERAGE_TYPE,
        nodeSchema: COVERAGE_SCHEMA,
        evaluator: EVALUATOR,
        policyDigest: scannerPolicy,
        exactInputDigests: {},
        semanticParentResultDigests: semantic,
        provenanceParentNodeIds: provenance,
        outputSchema: COVERAGE_OUTPUT_SCHEMA,
        output: {
            effectiveTermIds: effective,
            zeroHitTermIds,
            hitIds: sortedHits.map((node) => node.nodeId),
            groupIds: sortedGroups.map((node) => node.nodeId),
            dispositionNodeIds: sortedDispositions.map((node) => node.nodeId),
        },
        runtimeMetadata: {},
    });
}
/**
 * Recompute the hit and group projection from the scans and grouping context and
 * reject any envelope whose engine-derived output does not match. Each disposition
 * envelope is recomputed from its parsed semantic answer and current group and
 * compared by node ID and result digest — enforcing policy, exact-input, and
 * exact parent maps, not only output equality — as an exact one-per-group
 * partition. The coverage node is recomputed and the closed provenance DAG is
 * checked. Any forged hit, group, disposition, or coverage output fails closed.
 */
export function validateInvestigationEvidenceDag(input) {
    const recomputed = deriveInvestigationGroups({
        scanNodes: input.scanNodes,
        mutationPolicy: input.mutationPolicy,
        declaredRoots: input.declaredRoots,
        reviewedRelationships: input.reviewedRelationships,
        exceptions: input.exceptions,
    });
    assertSameEnvelopes(recomputed.hitNodes, input.hitNodes);
    assertSameEnvelopes(recomputed.groupNodes, input.groupNodes);
    assertDispositionsPartitionGroups(input.groupNodes, input.dispositionNodes);
    const recomputedCoverage = createInvestigationCoverageNode({
        effectiveTermIds: input.effectiveTermIds,
        scanNodes: input.scanNodes,
        inventoryNode: input.inventoryNode,
        hitNodes: input.hitNodes,
        groupNodes: input.groupNodes,
        dispositionNodes: input.dispositionNodes,
    });
    const coverage = assertStoredEvidenceNode(input.coverageNode, investigationDagInvalid);
    if (recomputedCoverage.nodeId !== coverage.nodeId ||
        recomputedCoverage.resultDigest !== coverage.resultDigest) {
        throw investigationDagInvalid('Coverage node does not match recomputation.');
    }
    try {
        validateClosedEvidenceDag([
            ...input.scanNodes,
            input.inventoryNode,
            ...input.hitNodes,
            ...input.groupNodes,
            ...input.dispositionNodes,
            input.coverageNode,
        ]);
    }
    catch {
        throw investigationDagInvalid('Closed investigation DAG is malformed.');
    }
    const coverageOutput = readInvestigationCoverageNode(coverage);
    return {
        valid: true,
        scanCount: input.scanNodes.length,
        zeroHitTermIds: coverageOutput.zeroHitTermIds,
        hitCount: input.hitNodes.length,
        groupCount: input.groupNodes.length,
        dispositionCount: input.dispositionNodes.length,
    };
}
export function readInvestigationHitNode(node) {
    const validated = assertNodeIdentity(node, HIT_TYPE, HIT_SCHEMA, EVALUATOR, HIT_OUTPUT_SCHEMA, groupsInvalid);
    const output = assertExactKeys(validated.output, ['termId', 'path', 'sourceObject', 'surface', 'byteOffset', 'byteLength'], groupsInvalid);
    if (typeof output.termId !== 'string') {
        throw groupsInvalid('Hit node term ID is malformed.');
    }
    assertNodeRoles(validated, ['hit', 'term', 'tree'], ['scan'], groupsInvalid);
    return assertHitSummaryFields(output, validated.nodeId, output.termId, groupsInvalid);
}
export function readInvestigationGroupNode(node) {
    const validated = assertNodeIdentity(node, GROUP_TYPE, GROUP_SCHEMA, EVALUATOR, GROUP_OUTPUT_SCHEMA, groupsInvalid);
    const output = assertExactKeys(validated.output, ['groupId', 'selector', 'hitIds', 'hits', 'sourceObjects', 'exceptions'], groupsInvalid);
    if (typeof output.groupId !== 'string' ||
        !DIGEST_PATTERN.test(output.groupId)) {
        throw groupsInvalid('Group node group ID is malformed.');
    }
    const selector = assertGroupSelector(output.selector, groupsInvalid);
    if (output.groupId !== selector.selectorId) {
        throw groupsInvalid('Group ID does not match its selector.');
    }
    const hitIds = assertSortedUniqueIds(output.hitIds, DIGEST_PATTERN, groupsInvalid);
    const hits = assertArray(output.hits, groupsInvalid).map((entry) => assertHitSummary(entry, groupsInvalid));
    const sourceObjects = assertSourceObjectArray(output.sourceObjects, groupsInvalid);
    const exceptions = assertExceptionArray(output.exceptions, groupsInvalid);
    assertNodeRoles(validated, ['exceptions', 'selector'], hitIds.map((_, index) => `hit-${index}`), groupsInvalid);
    if (validated.exactInputDigests.selector !== selector.selectorId ||
        validated.exactInputDigests.exceptions !== groupExceptionsDigest(exceptions)) {
        throw groupsInvalid('Group exact inputs do not match its selector and exceptions.');
    }
    if (canonicalJson(hits.map((entry) => entry.hitId)) !== canonicalJson(hitIds)) {
        throw groupsInvalid('Group hit summaries do not match its hit IDs.');
    }
    if (canonicalJson(sourceObjects) !==
        canonicalJson(dedupeSourceObjects(hits.map((entry) => entry.sourceObject)))) {
        throw groupsInvalid('Group source objects do not match its covered hit summaries.');
    }
    if (exceptions.some((exception) => !hitIds.includes(exception.hitId) ||
        selector.splitId === null ||
        exception.splitId !== selector.splitId) ||
        (selector.splitId === null && exceptions.length > 0) ||
        (selector.splitId !== null && exceptions.length === 0)) {
        throw groupsInvalid('Group exceptions do not match its split selector.');
    }
    return {
        groupId: output.groupId,
        selector,
        hitIds,
        hits,
        sourceObjects,
        exceptions,
    };
}
export function readInvestigationDispositionNode(node) {
    const validated = assertNodeIdentity(node, DISPOSITION_TYPE, DISPOSITION_SCHEMA, EVALUATOR, DISPOSITION_OUTPUT_SCHEMA, dispositionsInvalid);
    const output = assertExactKeys(validated.output, [
        'groupId',
        'classification',
        'rationale',
        'author',
        'coveredHitIds',
        'sourceObjects',
        'selectorEvidence',
        'exceptions',
    ], dispositionsInvalid);
    if (typeof output.groupId !== 'string' ||
        !DIGEST_PATTERN.test(output.groupId) ||
        typeof output.classification !== 'string' ||
        !DISPOSITION_CLASSIFICATIONS.has(output.classification) ||
        typeof output.rationale !== 'string' ||
        output.rationale.trim().length === 0 ||
        typeof output.author !== 'string' ||
        output.author.trim().length === 0) {
        throw dispositionsInvalid('Disposition node output is malformed.');
    }
    const coveredHitIds = assertSortedUniqueIds(output.coveredHitIds, DIGEST_PATTERN, dispositionsInvalid);
    const sourceObjects = assertSourceObjectArray(output.sourceObjects, dispositionsInvalid);
    const selectorEvidence = assertGroupSelector(output.selectorEvidence, dispositionsInvalid);
    const exceptions = assertExceptionArray(output.exceptions, dispositionsInvalid);
    assertNodeRoles(validated, ['answer'], ['group'], dispositionsInvalid);
    if (validated.exactInputDigests.answer !==
        dispositionAnswerDigest({
            groupId: output.groupId,
            classification: output.classification,
            rationale: output.rationale,
            author: output.author,
        })) {
        throw dispositionsInvalid('Disposition exact input does not match its semantic answer.');
    }
    return {
        groupId: output.groupId,
        classification: output.classification,
        rationale: output.rationale,
        author: output.author,
        coveredHitIds,
        sourceObjects,
        selectorEvidence,
        exceptions,
    };
}
export function readInvestigationCoverageNode(node) {
    const validated = assertNodeIdentity(node, COVERAGE_TYPE, COVERAGE_SCHEMA, EVALUATOR, COVERAGE_OUTPUT_SCHEMA, coverageInvalid);
    const output = assertExactKeys(validated.output, [
        'effectiveTermIds',
        'zeroHitTermIds',
        'hitIds',
        'groupIds',
        'dispositionNodeIds',
    ], coverageInvalid);
    const effectiveTermIds = assertSortedUniqueIds(output.effectiveTermIds, DIGEST_PATTERN, coverageInvalid);
    const zeroHitTermIds = assertSortedUniqueIds(output.zeroHitTermIds, DIGEST_PATTERN, coverageInvalid);
    const hitIds = assertSortedUniqueIds(output.hitIds, DIGEST_PATTERN, coverageInvalid);
    const groupIds = assertSortedUniqueIds(output.groupIds, DIGEST_PATTERN, coverageInvalid);
    const dispositionNodeIds = assertSortedUniqueIds(output.dispositionNodeIds, DIGEST_PATTERN, coverageInvalid);
    if (zeroHitTermIds.some((termId) => !effectiveTermIds.includes(termId))) {
        throw coverageInvalid('Zero-hit terms must be a subset of effective terms.');
    }
    assertNodeRoles(validated, [], [
        'inventory',
        ...effectiveTermIds.map((_, index) => `scan-${index}`),
        ...hitIds.map((_, index) => `hit-${index}`),
        ...groupIds.map((_, index) => `group-${index}`),
        ...dispositionNodeIds.map((_, index) => `disposition-${index}`),
    ], coverageInvalid);
    return {
        effectiveTermIds,
        zeroHitTermIds,
        hitIds,
        groupIds,
        dispositionNodeIds,
    };
}
function normalizeContext(mutationPolicy, declaredRoots, reviewedRelationships) {
    let normalizedMutationPolicy;
    try {
        normalizedMutationPolicy = assertMutationClassPolicy(mutationPolicy);
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw groupsInvalid(error.message);
        }
        throw error;
    }
    const seenRootIds = new Set();
    const seenRootPaths = new Set();
    const roots = [...declaredRoots].sort((left, right) => left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0);
    for (const root of roots) {
        const record = assertExactKeys(root, ['rootId', 'path'], groupsInvalid);
        if (typeof record.rootId !== 'string' ||
            record.rootId.length === 0 ||
            typeof record.path !== 'string') {
            throw groupsInvalid('Declared root is malformed.');
        }
        if (seenRootIds.has(record.rootId)) {
            throw groupsInvalid(`Duplicate declared root ID: ${record.rootId}`);
        }
        if (seenRootPaths.has(record.path)) {
            throw groupsInvalid(`Ambiguous declared root path: ${record.path}`);
        }
        seenRootIds.add(record.rootId);
        seenRootPaths.add(record.path);
    }
    const relationships = [...reviewedRelationships].sort((left, right) => left.relationshipId < right.relationshipId
        ? -1
        : left.relationshipId > right.relationshipId
            ? 1
            : 0);
    const seenRelationshipIds = new Set();
    const counterpartOf = new Map();
    const subjectOf = new Map();
    for (const relationship of relationships) {
        const record = assertExactKeys(relationship, ['relationshipId', 'kind', 'subjectPath', 'counterpartPath', 'reference'], groupsInvalid);
        if (typeof record.relationshipId !== 'string' ||
            record.relationshipId.length === 0 ||
            typeof record.kind !== 'string' ||
            !RELATIONSHIP_KINDS.has(record.kind) ||
            typeof record.reference !== 'string' ||
            record.reference.trim().length === 0) {
            throw groupsInvalid('Reviewed relationship is malformed.');
        }
        assertPathIdentity(record.subjectPath, groupsInvalid);
        assertPathIdentity(record.counterpartPath, groupsInvalid);
        if (seenRelationshipIds.has(record.relationshipId)) {
            throw groupsInvalid(`Duplicate relationship ID: ${record.relationshipId}`);
        }
        seenRelationshipIds.add(record.relationshipId);
        const counterpartKey = relationship.counterpartPath.rawBase64;
        if (counterpartOf.has(counterpartKey)) {
            throw groupsInvalid('Ambiguous reviewed relationship: counterpart claimed twice.');
        }
        counterpartOf.set(counterpartKey, relationship.relationshipId);
        const subjectKey = relationship.subjectPath.rawBase64;
        const existing = subjectOf.get(subjectKey) ?? [];
        existing.push(relationship.relationshipId);
        subjectOf.set(subjectKey, existing);
    }
    for (const subjectKey of subjectOf.keys()) {
        if (counterpartOf.has(subjectKey)) {
            throw groupsInvalid('Ambiguous relationship chain: a path is both subject and counterpart.');
        }
    }
    const groupingPolicyDigest = sha256(canonicalJson({
        schema: 'investigation.grouping-policy.v1',
        mutationPolicyDigest: normalizedMutationPolicy.policyDigest,
        roots: roots.map((root) => ({ rootId: root.rootId, path: root.path })),
        relationships: relationships.map((relationship) => ({
            relationshipId: relationship.relationshipId,
            kind: relationship.kind,
            reference: relationship.reference,
            subjectPath: {
                rawBase64: relationship.subjectPath.rawBase64,
                utf8: relationship.subjectPath.utf8,
            },
            counterpartPath: {
                rawBase64: relationship.counterpartPath.rawBase64,
                utf8: relationship.counterpartPath.utf8,
            },
        })),
    }));
    return {
        mutationPolicy: normalizedMutationPolicy,
        roots,
        counterpartOf,
        subjectOf,
        groupingPolicyDigest,
    };
}
function baseSelectorFor(termId, hit, context) {
    const rootId = nearestRoot(hit.path.utf8, context.roots);
    const extension = rawExtension(hit.path);
    const { mutationClass } = classifyMutationPath(context.mutationPolicy, {
        rawBase64: hit.path.rawBase64,
        utf8: hit.path.utf8,
    });
    const relationshipId = relationshipFor(hit.path.rawBase64, context);
    const fields = {
        termId,
        rootId,
        extension,
        mutationClass,
        relationshipId,
        splitId: null,
    };
    return { selectorId: selectorId(fields), ...fields };
}
function relationshipFor(rawBase64, context) {
    const counterpart = context.counterpartOf.get(rawBase64);
    if (counterpart !== undefined) {
        return `counterpart:${sha256(canonicalJson([counterpart]))}`;
    }
    const subject = context.subjectOf.get(rawBase64);
    if (subject !== undefined) {
        // A structured canonical digest of the exact sorted relationship-ID set keeps
        // two distinct sets from colliding on a lossy delimiter join.
        return `source:${sha256(canonicalJson([...subject].sort()))}`;
    }
    return null;
}
function applyExceptions(baseGroups, hitBaseSelector, exceptions) {
    const splitGroups = new Map();
    const seenExceptionIds = new Set();
    const seenHitIds = new Set();
    for (const exception of exceptions) {
        const record = assertExactKeys(exception, [
            'exceptionId',
            'hitId',
            'baseSelectorId',
            'splitId',
            'rationale',
            'author',
        ], groupsInvalid);
        if (typeof record.exceptionId !== 'string' ||
            record.exceptionId.length === 0 ||
            typeof record.splitId !== 'string' ||
            record.splitId.length === 0 ||
            typeof record.hitId !== 'string' ||
            typeof record.baseSelectorId !== 'string' ||
            typeof record.rationale !== 'string' ||
            record.rationale.trim().length === 0 ||
            typeof record.author !== 'string' ||
            record.author.trim().length === 0) {
            throw groupsInvalid('Group exception is malformed.');
        }
        if (seenExceptionIds.has(exception.exceptionId)) {
            throw groupsInvalid(`Duplicate exception ID: ${exception.exceptionId}`);
        }
        seenExceptionIds.add(exception.exceptionId);
        if (seenHitIds.has(exception.hitId)) {
            throw groupsInvalid('A hit may be split by at most one exception.');
        }
        seenHitIds.add(exception.hitId);
        const baseSelectorId = hitBaseSelector.get(exception.hitId);
        if (baseSelectorId === undefined) {
            throw groupsInvalid('Exception targets an unknown hit.');
        }
        if (baseSelectorId !== exception.baseSelectorId) {
            throw groupsInvalid('Exception base selector does not match the hit.');
        }
        const baseGroup = baseGroups.get(baseSelectorId);
        const hitRecord = baseGroup.members.get(exception.hitId);
        baseGroup.members.delete(exception.hitId);
        const splitSelectorFields = {
            termId: baseGroup.selector.termId,
            rootId: baseGroup.selector.rootId,
            extension: baseGroup.selector.extension,
            mutationClass: baseGroup.selector.mutationClass,
            relationshipId: baseGroup.selector.relationshipId,
            splitId: exception.splitId,
        };
        const splitSelectorId = selectorId(splitSelectorFields);
        let splitGroup = splitGroups.get(splitSelectorId);
        if (!splitGroup) {
            splitGroup = {
                selector: { selectorId: splitSelectorId, ...splitSelectorFields },
                members: new Map(),
                exceptions: [],
            };
            splitGroups.set(splitSelectorId, splitGroup);
        }
        splitGroup.members.set(hitRecord.hitId, hitRecord);
        splitGroup.exceptions.push(exception);
    }
    const finalGroups = [];
    for (const group of baseGroups.values()) {
        if (group.members.size > 0) {
            finalGroups.push(group);
        }
    }
    for (const group of splitGroups.values()) {
        finalGroups.push(group);
    }
    return finalGroups;
}
function deriveInvestigationHitRecords(scanNodes) {
    const records = [];
    const seenTermIds = new Set();
    let sharedTreeDigest = null;
    let sharedPolicyDigest = null;
    for (const scanNode of scanNodes) {
        const scan = readScanNode(scanNode, groupsInvalid);
        if (seenTermIds.has(scan.termId)) {
            throw groupsInvalid(`Duplicate scan term: ${scan.termId}`);
        }
        seenTermIds.add(scan.termId);
        if (sharedTreeDigest === null) {
            sharedTreeDigest = scan.treeDigest;
            sharedPolicyDigest = scan.policyDigest;
        }
        else if (scan.treeDigest !== sharedTreeDigest ||
            scan.policyDigest !== sharedPolicyDigest) {
            throw groupsInvalid('Scans must share one pinned tree and scanner policy.');
        }
        for (const hit of scan.hits) {
            records.push(buildHitRecord(scan.termId, hit, scan.node));
        }
    }
    return records;
}
function buildHitRecord(termId, hit, scanNode) {
    const locatorDigest = sha256(canonicalJson({
        schema: 'investigation.hit-locator.v1',
        path: hit.path,
        surface: hit.surface,
        byteOffset: hit.byteOffset,
        byteLength: hit.byteLength,
        sourceObject: hit.sourceObject,
    }));
    const node = createEvidenceNode({
        type: HIT_TYPE,
        nodeSchema: HIT_SCHEMA,
        evaluator: EVALUATOR,
        policyDigest: scanNode.policyDigest,
        exactInputDigests: {
            hit: locatorDigest,
            term: scanNode.exactInputDigests.term,
            tree: scanNode.exactInputDigests.tree,
        },
        semanticParentResultDigests: { scan: scanNode.resultDigest },
        provenanceParentNodeIds: { scan: scanNode.nodeId },
        outputSchema: HIT_OUTPUT_SCHEMA,
        output: {
            termId,
            path: hit.path,
            sourceObject: hit.sourceObject,
            surface: hit.surface,
            byteOffset: hit.byteOffset,
            byteLength: hit.byteLength,
        },
        runtimeMetadata: {},
    });
    return {
        hitId: node.nodeId,
        node,
        summary: {
            hitId: node.nodeId,
            termId,
            path: hit.path,
            sourceObject: hit.sourceObject,
            surface: hit.surface,
            byteOffset: hit.byteOffset,
            byteLength: hit.byteLength,
        },
    };
}
function buildGroupNode(group, groupingPolicyDigest) {
    const members = [...group.members.values()].sort((left, right) => left.hitId < right.hitId ? -1 : left.hitId > right.hitId ? 1 : 0);
    const provenance = {};
    const semantic = {};
    members.forEach((member, index) => {
        provenance[`hit-${index}`] = member.hitId;
        semantic[`hit-${index}`] = member.node.resultDigest;
    });
    const sourceObjects = dedupeSourceObjects(members.map((member) => member.summary.sourceObject));
    const exceptions = [...group.exceptions].sort((left, right) => left.exceptionId < right.exceptionId
        ? -1
        : left.exceptionId > right.exceptionId
            ? 1
            : 0);
    return createEvidenceNode({
        type: GROUP_TYPE,
        nodeSchema: GROUP_SCHEMA,
        evaluator: EVALUATOR,
        policyDigest: groupingPolicyDigest,
        exactInputDigests: {
            exceptions: groupExceptionsDigest(exceptions),
            selector: group.selector.selectorId,
        },
        semanticParentResultDigests: semantic,
        provenanceParentNodeIds: provenance,
        outputSchema: GROUP_OUTPUT_SCHEMA,
        output: {
            groupId: group.selector.selectorId,
            selector: group.selector,
            hitIds: members.map((member) => member.hitId),
            hits: members.map((member) => member.summary),
            sourceObjects,
            exceptions,
        },
        runtimeMetadata: {},
    });
}
function buildDispositionNode(group, answer) {
    assertDispositionAnswer(answer);
    return createEvidenceNode({
        type: DISPOSITION_TYPE,
        nodeSchema: DISPOSITION_SCHEMA,
        evaluator: EVALUATOR,
        policyDigest: group.node.policyDigest,
        exactInputDigests: { answer: dispositionAnswerDigest(answer) },
        semanticParentResultDigests: { group: group.node.resultDigest },
        provenanceParentNodeIds: { group: group.node.nodeId },
        outputSchema: DISPOSITION_OUTPUT_SCHEMA,
        output: {
            groupId: group.output.groupId,
            classification: answer.classification,
            rationale: answer.rationale,
            author: answer.author,
            coveredHitIds: group.output.hitIds,
            sourceObjects: group.output.sourceObjects,
            selectorEvidence: group.output.selector,
            exceptions: group.output.exceptions,
        },
        runtimeMetadata: {},
    });
}
function groupExceptionsDigest(exceptions) {
    return sha256(canonicalJson({
        schema: 'investigation.group-exceptions.v1',
        exceptions,
    }));
}
function dispositionAnswerDigest(answer) {
    return sha256(canonicalJson({
        schema: 'investigation.disposition-answer.v1',
        answer: {
            groupId: answer.groupId,
            classification: answer.classification,
            rationale: answer.rationale,
            author: answer.author,
        },
    }));
}
function assertDispositionsPartitionGroups(groupNodes, dispositionNodes) {
    try {
        const groupsById = new Map();
        for (const node of groupNodes) {
            const output = readInvestigationGroupNode(node);
            if (groupsById.has(output.groupId)) {
                throw investigationDagInvalid('Duplicate group in evidence DAG.');
            }
            groupsById.set(output.groupId, { node, output });
        }
        const seen = new Set();
        for (const node of dispositionNodes) {
            const disposition = readInvestigationDispositionNode(node);
            const group = groupsById.get(disposition.groupId);
            if (!group || seen.has(disposition.groupId)) {
                throw investigationDagInvalid('Disposition does not map one-to-one.');
            }
            seen.add(disposition.groupId);
            const expected = buildDispositionNode(group, {
                groupId: disposition.groupId,
                classification: disposition.classification,
                rationale: disposition.rationale,
                author: disposition.author,
            });
            if (expected.nodeId !== node.nodeId ||
                expected.resultDigest !== node.resultDigest) {
                throw investigationDagInvalid('Disposition envelope is forged.');
            }
        }
        if (seen.size !== groupsById.size) {
            throw investigationDagInvalid('Dispositions do not cover every group.');
        }
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw investigationDagInvalid(error.message);
        }
        throw error;
    }
}
function dedupeSourceObjects(sourceObjects) {
    const byId = new Map();
    for (const sourceObject of sourceObjects) {
        const existing = byId.get(sourceObject.objectId);
        if (existing !== undefined &&
            canonicalJson(existing) !== canonicalJson(sourceObject)) {
            throw groupsInvalid('One Git object ID carries conflicting source-object metadata.');
        }
        if (existing === undefined) {
            byId.set(sourceObject.objectId, sourceObject);
        }
    }
    return [...byId.values()].sort((left, right) => left.objectId < right.objectId
        ? -1
        : left.objectId > right.objectId
            ? 1
            : 0);
}
function readScanNode(node, invalid) {
    const validated = assertStoredEvidenceNode(node, invalid);
    if (validated.type !== SCAN_TYPE ||
        validated.nodeSchema !== SCAN_SCHEMA ||
        validated.evaluator !== SCANNER_EVALUATOR ||
        validated.outputSchema !== SCAN_OUTPUT_SCHEMA) {
        throw invalid('Scan node identity is not a scanner term-scan node.');
    }
    assertNodeRoles(validated, ['term', 'tree'], [], invalid);
    const term = validated.exactInputDigests.term;
    const tree = validated.exactInputDigests.tree;
    if (typeof term !== 'string' || typeof tree !== 'string') {
        throw invalid('Scan node is missing its term or tree digest.');
    }
    const output = assertExactKeys(validated.output, ['termId', 'hits'], invalid);
    if (typeof output.termId !== 'string' ||
        !DIGEST_PATTERN.test(output.termId)) {
        throw invalid('Scan node is missing a term ID.');
    }
    const hits = assertArray(output.hits, invalid).map((hit) => parseHit(hit, invalid));
    return {
        node: validated,
        termId: output.termId,
        hits,
        treeDigest: tree,
        policyDigest: validated.policyDigest,
    };
}
function assertInventoryNode(node) {
    const validated = assertStoredEvidenceNode(node, coverageInvalid);
    if (validated.type !== INVENTORY_TYPE ||
        validated.nodeSchema !== INVENTORY_SCHEMA ||
        validated.evaluator !== SCANNER_EVALUATOR ||
        validated.outputSchema !== INVENTORY_OUTPUT_SCHEMA) {
        throw coverageInvalid('Inventory node identity is not a scanner inventory.');
    }
    assertNodeRoles(validated, ['tree'], [], coverageInvalid);
    const output = assertExactKeys(validated.output, ['skippedObjects'], coverageInvalid);
    for (const entry of assertArray(output.skippedObjects, coverageInvalid)) {
        const skipped = assertExactKeys(entry, ['path', 'objectId', 'objectType', 'mode', 'byteSize', 'reason'], coverageInvalid);
        assertFilePathIdentity(skipped.path, coverageInvalid);
        if (typeof skipped.objectId !== 'string' ||
            !GIT_OBJECT_ID_PATTERN.test(skipped.objectId) ||
            typeof skipped.objectType !== 'string' ||
            skipped.objectType.length === 0 ||
            typeof skipped.mode !== 'string' ||
            !GIT_MODES.has(skipped.mode) ||
            (skipped.byteSize !== null &&
                (!Number.isSafeInteger(skipped.byteSize) ||
                    skipped.byteSize < 0)) ||
            typeof skipped.reason !== 'string' ||
            !SCAN_SKIP_REASONS.has(skipped.reason)) {
            throw coverageInvalid('Inventory skipped object is malformed.');
        }
    }
    return validated;
}
/** Exposed so the two accepted hit shapes can be pinned by contract tests. */
export function parseHitForTest(value) {
    return parseHit(value, investigationDagInvalid);
}
function parseHit(value, invalid) {
    // Two accepted shapes: scans recorded before context windows existed carry
    // five keys, and must keep validating exactly as they did.
    const hit = hasOnlyKeys(value, HIT_KEYS_WITH_CONTEXT)
        ? assertExactKeys(value, [...HIT_KEYS_WITH_CONTEXT], invalid)
        : assertExactKeys(value, [...HIT_KEYS], invalid);
    const path = assertFilePathIdentity(hit.path, invalid);
    const sourceObject = assertSourceObject(hit.sourceObject, invalid);
    if ((hit.surface !== 'path' && hit.surface !== 'content') ||
        !Number.isSafeInteger(hit.byteOffset) ||
        hit.byteOffset < 0 ||
        !Number.isSafeInteger(hit.byteLength) ||
        hit.byteLength <= 0 ||
        (hit.surface === 'content' && sourceObject.skipReason !== null)) {
        throw invalid('Scan hit fields are malformed.');
    }
    return {
        path,
        sourceObject,
        surface: hit.surface,
        byteOffset: hit.byteOffset,
        byteLength: hit.byteLength,
        ...(hit.contextWindow === undefined
            ? {}
            : { contextWindow: assertContextWindow(hit.contextWindow, invalid) }),
    };
}
function assertHitSummary(value, invalid) {
    const record = assertExactKeys(value, [
        'hitId',
        'termId',
        'path',
        'sourceObject',
        'surface',
        'byteOffset',
        'byteLength',
    ], invalid);
    if (typeof record.hitId !== 'string' ||
        !DIGEST_PATTERN.test(record.hitId) ||
        typeof record.termId !== 'string') {
        throw invalid('Hit summary identity is malformed.');
    }
    return assertHitSummaryFields(record, record.hitId, record.termId, invalid);
}
function assertHitSummaryFields(record, hitId, termId, invalid) {
    const path = assertFilePathIdentity(record.path, invalid);
    const sourceObject = assertSourceObject(record.sourceObject, invalid);
    if (!DIGEST_PATTERN.test(termId) ||
        (record.surface !== 'path' && record.surface !== 'content') ||
        !Number.isSafeInteger(record.byteOffset) ||
        record.byteOffset < 0 ||
        !Number.isSafeInteger(record.byteLength) ||
        record.byteLength <= 0 ||
        (record.surface === 'content' && sourceObject.skipReason !== null)) {
        throw invalid('Hit summary fields are malformed.');
    }
    return {
        hitId,
        termId,
        path,
        sourceObject,
        surface: record.surface,
        byteOffset: record.byteOffset,
        byteLength: record.byteLength,
    };
}
function assertSourceObject(value, invalid) {
    const record = assertExactKeys(value, [
        'objectId',
        'objectType',
        'mode',
        'byteSize',
        'contentSha256',
        'skipReason',
    ], invalid);
    if (typeof record.objectId !== 'string' ||
        !GIT_OBJECT_ID_PATTERN.test(record.objectId) ||
        typeof record.objectType !== 'string' ||
        record.objectType.length === 0 ||
        typeof record.mode !== 'string' ||
        !GIT_MODES.has(record.mode) ||
        (record.byteSize !== null &&
            (typeof record.byteSize !== 'number' ||
                !Number.isSafeInteger(record.byteSize) ||
                record.byteSize < 0)) ||
        (record.contentSha256 !== null &&
            (typeof record.contentSha256 !== 'string' ||
                !DIGEST_PATTERN.test(record.contentSha256))) ||
        (record.skipReason !== null &&
            (typeof record.skipReason !== 'string' ||
                !SCAN_SKIP_REASONS.has(record.skipReason))) ||
        (record.skipReason === null && record.contentSha256 === null) ||
        (record.skipReason !== null && record.contentSha256 !== null)) {
        throw invalid('Source object is malformed.');
    }
    return {
        objectId: record.objectId,
        objectType: record.objectType,
        mode: record.mode,
        byteSize: record.byteSize,
        contentSha256: record.contentSha256,
        skipReason: record.skipReason,
    };
}
function assertSourceObjectArray(value, invalid) {
    const sourceObjects = assertArray(value, invalid).map((entry) => assertSourceObject(entry, invalid));
    for (let index = 1; index < sourceObjects.length; index += 1) {
        if (sourceObjects[index - 1].objectId >= sourceObjects[index].objectId) {
            throw invalid('Source objects must be sorted and unique.');
        }
    }
    return sourceObjects;
}
function assertGroupSelector(value, invalid) {
    const record = assertExactKeys(value, [
        'selectorId',
        'termId',
        'rootId',
        'extension',
        'mutationClass',
        'relationshipId',
        'splitId',
    ], invalid);
    if (typeof record.selectorId !== 'string' ||
        !DIGEST_PATTERN.test(record.selectorId) ||
        typeof record.termId !== 'string' ||
        typeof record.rootId !== 'string' ||
        typeof record.mutationClass !== 'string' ||
        !MUTATION_CLASS_SET.has(record.mutationClass) ||
        (record.relationshipId !== null &&
            typeof record.relationshipId !== 'string') ||
        (record.splitId !== null && typeof record.splitId !== 'string')) {
        throw invalid('Group selector is malformed.');
    }
    const extension = assertEmbeddedPathIdentity(record.extension, invalid);
    const selector = {
        selectorId: record.selectorId,
        termId: record.termId,
        rootId: record.rootId,
        extension,
        mutationClass: record.mutationClass,
        relationshipId: record.relationshipId,
        splitId: record.splitId,
    };
    if (!DIGEST_PATTERN.test(selector.termId) ||
        selector.rootId.length === 0 ||
        (selector.relationshipId !== null &&
            selector.relationshipId.length === 0) ||
        (selector.splitId !== null && selector.splitId.length === 0) ||
        selector.selectorId !==
            selectorId({
                termId: selector.termId,
                rootId: selector.rootId,
                extension: selector.extension,
                mutationClass: selector.mutationClass,
                relationshipId: selector.relationshipId,
                splitId: selector.splitId,
            })) {
        throw invalid('Group selector identity is inconsistent.');
    }
    return selector;
}
function assertExceptionArray(value, invalid) {
    const exceptions = assertArray(value, invalid).map((entry) => {
        const record = assertExactKeys(entry, [
            'exceptionId',
            'hitId',
            'baseSelectorId',
            'splitId',
            'rationale',
            'author',
        ], invalid);
        if (typeof record.exceptionId !== 'string' ||
            record.exceptionId.length === 0 ||
            typeof record.hitId !== 'string' ||
            !DIGEST_PATTERN.test(record.hitId) ||
            typeof record.baseSelectorId !== 'string' ||
            !DIGEST_PATTERN.test(record.baseSelectorId) ||
            typeof record.splitId !== 'string' ||
            record.splitId.length === 0 ||
            typeof record.rationale !== 'string' ||
            record.rationale.trim().length === 0 ||
            typeof record.author !== 'string' ||
            record.author.trim().length === 0) {
            throw invalid('Group exception is malformed.');
        }
        return {
            exceptionId: record.exceptionId,
            hitId: record.hitId,
            baseSelectorId: record.baseSelectorId,
            splitId: record.splitId,
            rationale: record.rationale,
            author: record.author,
        };
    });
    for (let index = 1; index < exceptions.length; index += 1) {
        if (exceptions[index - 1].exceptionId >= exceptions[index].exceptionId) {
            throw invalid('Group exceptions must be sorted and unique.');
        }
    }
    return exceptions;
}
function assertEmbeddedPathIdentity(value, invalid) {
    const record = assertExactKeys(value, ['rawBase64', 'utf8'], invalid);
    if (record.rawBase64 === '') {
        if (record.utf8 !== '') {
            throw invalid('Empty extension identity is inconsistent.');
        }
        return { rawBase64: '', utf8: '' };
    }
    const identity = assertPathIdentity(record, invalid);
    if (identity.raw.includes(0x2f) || identity.raw[0] !== 0x2e) {
        throw invalid('Extension identity is malformed.');
    }
    return {
        rawBase64: identity.raw.toString('base64'),
        utf8: identity.utf8,
    };
}
function assertFilePathIdentity(value, invalid) {
    const record = assertExactKeys(value, ['rawBase64', 'utf8'], invalid);
    const identity = assertPathIdentity(record, invalid);
    if (identity.raw.includes(0x00) ||
        identity.raw[0] === 0x2f ||
        identity.raw.at(-1) === 0x2f) {
        throw invalid('Path identity is malformed.');
    }
    return {
        rawBase64: identity.raw.toString('base64'),
        utf8: identity.utf8,
    };
}
function nearestRoot(utf8Path, roots) {
    let bestRootId = null;
    let bestLength = -1;
    for (const root of roots) {
        const matches = root.path === '' ||
            (utf8Path !== null &&
                (utf8Path === root.path || utf8Path.startsWith(`${root.path}/`)));
        if (matches && root.path.length > bestLength) {
            bestLength = root.path.length;
            bestRootId = root.rootId;
        }
    }
    if (bestRootId === null) {
        throw groupsInvalid('No declared root contains the hit path.');
    }
    return bestRootId;
}
function rawExtension(path) {
    const raw = Buffer.from(path.rawBase64, 'base64');
    const lastSlash = raw.lastIndexOf(0x2f);
    const basename = raw.subarray(lastSlash + 1);
    const lastDot = basename.lastIndexOf(0x2e);
    const extBytes = lastDot > 0 ? basename.subarray(lastDot) : Buffer.alloc(0);
    let utf8;
    try {
        utf8 = new TextDecoder('utf-8', { fatal: true }).decode(extBytes);
    }
    catch {
        utf8 = null;
    }
    return { rawBase64: extBytes.toString('base64'), utf8 };
}
function selectorId(fields) {
    return sha256(canonicalJson({ schema: 'investigation.selector.v1', ...fields }));
}
function assertDispositionAnswer(answer) {
    const record = assertExactKeys(answer, ['groupId', 'classification', 'rationale', 'author'], dispositionsInvalid);
    if (typeof record.groupId !== 'string' ||
        typeof record.classification !== 'string' ||
        typeof record.rationale !== 'string' ||
        typeof record.author !== 'string') {
        throw dispositionsInvalid('Disposition answer is malformed.');
    }
    if (!DISPOSITION_CLASSIFICATIONS.has(record.classification)) {
        throw dispositionsInvalid(`Invalid disposition classification: ${record.classification}`);
    }
    if (record.rationale.trim().length === 0) {
        throw dispositionsInvalid('Disposition rationale must be non-empty.');
    }
    if (record.author.trim().length === 0) {
        throw dispositionsInvalid('Disposition author is required.');
    }
}
function assertNodeIdentity(node, type, nodeSchema, evaluator, outputSchema, invalid) {
    const validated = assertStoredEvidenceNode(node, invalid);
    if (validated.type !== type ||
        validated.nodeSchema !== nodeSchema ||
        validated.evaluator !== evaluator ||
        validated.outputSchema !== outputSchema) {
        throw invalid('Evidence node identity does not match the expected schema.');
    }
    return validated;
}
function assertNodeRoles(node, exactInputRoles, parentRoles, invalid) {
    const expectedInputs = [...exactInputRoles].sort();
    const expectedParents = [...parentRoles].sort();
    const actualInputs = Object.keys(node.exactInputDigests).sort();
    const actualSemantic = Object.keys(node.semanticParentResultDigests).sort();
    const actualProvenance = Object.keys(node.provenanceParentNodeIds).sort();
    if (canonicalJson(actualInputs) !== canonicalJson(expectedInputs) ||
        canonicalJson(actualSemantic) !== canonicalJson(expectedParents) ||
        canonicalJson(actualProvenance) !== canonicalJson(expectedParents)) {
        throw invalid('Evidence node input or parent roles are unexpected.');
    }
}
function assertExactKeys(output, keys, invalid) {
    if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        throw invalid('Evidence node output is malformed.');
    }
    const record = output;
    const own = Object.keys(record);
    if (own.length !== keys.length ||
        !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))) {
        throw invalid('Evidence node output keys are unexpected.');
    }
    return record;
}
function assertArray(value, invalid) {
    if (!Array.isArray(value)) {
        throw invalid('Expected an array value.');
    }
    return value;
}
function assertSortedUniqueIds(value, pattern, invalid) {
    const array = assertArray(value, invalid);
    let previous = null;
    for (const item of array) {
        if (typeof item !== 'string' || (pattern !== null && !pattern.test(item))) {
            throw invalid('Identifier array element is malformed.');
        }
        if (previous !== null && item <= previous) {
            throw invalid('Identifier array is not sorted and unique.');
        }
        previous = item;
    }
    return array;
}
function assertSameEnvelopes(recomputed, provided) {
    const expected = envelopeMap(recomputed);
    const actual = envelopeMap(provided);
    if (canonicalJson([...expected].sort()) !== canonicalJson([...actual].sort())) {
        throw investigationDagInvalid('Provided evidence does not match the recomputed projection.');
    }
}
function envelopeMap(nodes) {
    return nodes.map((node) => {
        const validated = assertStoredEvidenceNode(node, investigationDagInvalid);
        return `${validated.nodeId}:${validated.resultDigest}`;
    });
}
function byNodeId(left, right) {
    return left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0;
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function groupsInvalid(message = 'Investigation grouping input is malformed.') {
    return workflowError('INVESTIGATION_GROUPS_INVALID', message, ExitCode.usage);
}
function dispositionsInvalid(message = 'Investigation disposition input is malformed.') {
    return workflowError('INVESTIGATION_DISPOSITIONS_INVALID', message, ExitCode.usage);
}
function coverageInvalid(message = 'Investigation coverage input is malformed.') {
    return workflowError('INVESTIGATION_COVERAGE_INVALID', message, ExitCode.usage);
}
function investigationDagInvalid(message = 'Investigation evidence DAG is invalid.') {
    return workflowError('INVESTIGATION_EVIDENCE_DAG_INVALID', message, ExitCode.usage);
}
/**
 * Rejoins each group's hits with the context windows their scans recorded.
 *
 * A group node summarises its hits without their windows, and a hit node never
 * carried one, so neither can answer whether a class predicate describes what
 * the search actually found. The scans still hold that text, and the join is
 * exact: a hit is the same hit when its term, path, and byte range agree.
 *
 * This is the only bridge between what the engine grouped and what a class may
 * claim, which is why it recomputes rather than trusting anything an author
 * sends. A hit whose scan carried no window arrives with a null window and can
 * therefore satisfy no predicate: silence is not evidence of a match.
 */
export function deriveClassGroupsWithContext(input) {
    const windows = new Map();
    for (const scanNode of input.scanNodes) {
        const scan = readScanNode(scanNode, groupsInvalid);
        for (const hit of scan.hits) {
            windows.set(scanHitJoinKey(scan.termId, hit.path.rawBase64, hit.byteOffset, hit.byteLength), hit.contextWindow ?? null);
        }
    }
    return input.groupNodes.map((node) => {
        const group = readInvestigationGroupNode(node);
        return Object.freeze({
            groupId: group.groupId,
            termId: group.selector.termId,
            hits: Object.freeze(group.hits.map((hit) => Object.freeze({
                path: hit.path.utf8 ?? `base64:${hit.path.rawBase64}`,
                surface: hit.surface,
                window: windows.get(scanHitJoinKey(hit.termId, hit.path.rawBase64, hit.byteOffset, hit.byteLength)) ?? null,
                matchOffset: hit.byteOffset,
                matchLength: hit.byteLength,
            }))),
        });
    });
}
function scanHitJoinKey(termId, rawBase64, byteOffset, byteLength) {
    return `${termId} ${rawBase64} ${byteOffset} ${byteLength}`;
}
