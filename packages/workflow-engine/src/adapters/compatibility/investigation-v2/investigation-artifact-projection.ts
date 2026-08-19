import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import type { InvestigationArtifact } from '../../consumer/expense-app/work-registry/contracts.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import { runGit } from '../../../runtime/repository-transaction/git.ts';
import {
  createInvestigationCoverageNode,
  createInvestigationDispositionNodes,
  deriveInvestigationHitNodes,
  readInvestigationCoverageNode,
  readInvestigationDispositionNode,
  readInvestigationGroupNode,
  replayInvestigationGroupNodes,
  type InvestigationGroupReplayRecord,
} from '../../../modules/investigation/domain/investigation-groups.ts';
import {
  assertInvestigationApplicability,
  type SealedInvestigationApplicability,
} from '../../../modules/investigation/domain/investigation-applicability.ts';
import {
  scanInvestigationTree,
  type ScanInvestigationTerm,
} from '../../../modules/investigation/domain/investigation-scanner.ts';
import { normalizeInvestigationTerm } from '../../../modules/investigation/domain/investigation-terms.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPLAYED_NODE_TYPES = new Set([
  'investigation-term-scan',
  'investigation-tree-inventory',
  'investigation-hit',
  'investigation-group',
  'investigation-disposition',
  'investigation-coverage',
]);

type Baseline = Readonly<{ head: string; tree: string }>;

type ScanReplay = Readonly<{
  nodeIds: string[];
  inventoryNodeId: string;
  policyDigest: string;
}>;

type DispositionReplay = Readonly<{
  nodeId: string;
  groupId: string;
  classification: string;
  rationale: string;
  author: string;
}>;

export type GitBackedInvestigationReplay = Readonly<{
  schemaVersion: 1;
  kind: 'git-backed-investigation-replay';
  baseline: Baseline;
  fullNodeCount: number;
  fullNodesDigest: string;
  termUnionNodeId: string;
  scan: ScanReplay;
  groups: InvestigationGroupReplayRecord[];
  dispositions: DispositionReplay[];
  coverageNodeId: string;
}>;

export type ProjectedInvestigationArtifact = Readonly<{
  schemaVersion: 2;
  kind: 'investigation-artifact';
  changeId: string;
  legacyMigration: false;
  nodes: EvidenceNode[];
  currentRefs: Record<string, string>;
  applicability: SealedInvestigationApplicability;
  roleResults?: unknown[];
  replay: GitBackedInvestigationReplay;
}>;

/**
 * Replace deterministic investigation envelopes with a Git-backed replay
 * recipe. Provider judgments, WHY, review, authorization, and seal nodes remain
 * tracked verbatim; only facts reproducible from the pinned source tree and the
 * retained semantic decisions are omitted.
 */
export function projectInvestigationArtifactForTracking(
  repositoryRoot: string,
  artifact: InvestigationArtifact,
): InvestigationArtifact | ProjectedInvestigationArtifact {
  const applicability = artifact.applicability;
  if (
    artifact.legacyMigration ||
    applicability === undefined ||
    applicability.kind !== 'sealed-investigation'
  ) {
    return artifact;
  }

  const termUnions = nodesOfType(artifact.nodes, 'investigation-term-union');
  const scans = nodesOfType(artifact.nodes, 'investigation-term-scan');
  const inventories = nodesOfType(
    artifact.nodes,
    'investigation-tree-inventory',
  );
  const groups = nodesOfType(artifact.nodes, 'investigation-group');
  const dispositions = nodesOfType(artifact.nodes, 'investigation-disposition');
  const coverages = nodesOfType(artifact.nodes, 'investigation-coverage');

  // A converged artifact may retain more than one historical deterministic
  // epoch. V1 remains the safe compatibility form until replay v2 gains an
  // explicit multi-epoch recipe.
  if (
    termUnions.length !== 1 ||
    scans.length === 0 ||
    inventories.length !== 1 ||
    coverages.length !== 1
  ) {
    return artifact;
  }

  try {
    readInvestigationCoverageNode(coverages[0]!);
    const replay: GitBackedInvestigationReplay = {
      schemaVersion: 1,
      kind: 'git-backed-investigation-replay',
      baseline: { ...applicability.baseline },
      fullNodeCount: artifact.nodes.length,
      fullNodesDigest: digest(artifact.nodes),
      termUnionNodeId: termUnions[0]!.nodeId,
      scan: {
        nodeIds: scans.map(({ nodeId }) => nodeId).sort(),
        inventoryNodeId: inventories[0]!.nodeId,
        policyDigest: scans[0]!.policyDigest,
      },
      groups: groups
        .map((node) => {
          const output = readInvestigationGroupNode(node);
          return {
            nodeId: node.nodeId,
            policyDigest: node.policyDigest,
            selector: output.selector,
            hitIds: output.hitIds,
            exceptions: output.exceptions,
          };
        })
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      dispositions: dispositions
        .map((node) => {
          const output = readInvestigationDispositionNode(node);
          return {
            nodeId: node.nodeId,
            groupId: output.groupId,
            classification: output.classification,
            rationale: output.rationale,
            author: output.author,
          };
        })
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
      coverageNodeId: coverages[0]!.nodeId,
    };
    const projected: ProjectedInvestigationArtifact = {
      schemaVersion: 2,
      kind: 'investigation-artifact',
      changeId: artifact.changeId,
      legacyMigration: false,
      nodes: artifact.nodes.filter(
        ({ type }) => !REPLAYED_NODE_TYPES.has(type),
      ),
      currentRefs: { ...artifact.currentRefs },
      applicability,
      ...(artifact.roleResults === undefined
        ? {}
        : { roleResults: structuredClone(artifact.roleResults) }),
      replay,
    };
    const materialized = materializeProjectedInvestigationArtifact(
      repositoryRoot,
      projected,
      artifact.changeId,
    );
    if (canonicalJson(materialized) !== canonicalJson(artifact)) {
      return artifact;
    }
    return projected;
  } catch {
    // Projection is an optional storage optimization. A valid full artifact
    // remains the compatibility form whenever this recipe cannot reproduce it.
    return artifact;
  }
}

/** Materialize one tracked v2 projection into the existing in-memory v1 form. */
export function materializeProjectedInvestigationArtifact(
  repositoryRoot: string,
  value: unknown,
  expectedChangeId: string,
): InvestigationArtifact {
  try {
    return materialize(repositoryRoot, value, expectedChangeId);
  } catch {
    throw invalidProjection(
      'Git-backed investigation evidence cannot be replayed from its pinned source tree.',
    );
  }
}

function materialize(
  repositoryRoot: string,
  value: unknown,
  expectedChangeId: string,
): InvestigationArtifact {
  const artifact = exactRecord(value, [
    'schemaVersion',
    'kind',
    'changeId',
    'legacyMigration',
    'nodes',
    'currentRefs',
    'applicability',
    ...(isRecord(value) && Object.hasOwn(value, 'roleResults')
      ? ['roleResults']
      : []),
    'replay',
  ]);
  if (
    artifact.schemaVersion !== 2 ||
    artifact.kind !== 'investigation-artifact' ||
    artifact.changeId !== expectedChangeId ||
    artifact.legacyMigration !== false ||
    !Array.isArray(artifact.nodes) ||
    artifact.nodes.length === 0 ||
    !isRecord(artifact.currentRefs)
  ) {
    throw new Error('invalid projected artifact');
  }
  const applicability = assertInvestigationApplicability(
    artifact.applicability,
  );
  if (applicability.kind !== 'sealed-investigation') {
    throw new Error('projected artifact is not sealed');
  }
  const replay = parseReplay(artifact.replay);
  if (
    canonicalJson(replay.baseline) !== canonicalJson(applicability.baseline)
  ) {
    throw new Error('replay baseline mismatch');
  }
  const resolvedCommit = runGit(repositoryRoot, [
    'rev-parse',
    `${replay.baseline.head}^{commit}`,
  ]).trim();
  if (resolvedCommit !== replay.baseline.head) {
    throw new Error('replay head is not the exact baseline commit');
  }
  const resolvedTree = runGit(repositoryRoot, [
    'rev-parse',
    `${replay.baseline.head}^{tree}`,
  ]).trim();
  if (resolvedTree !== replay.baseline.tree) {
    throw new Error('base commit does not resolve to replay tree');
  }

  const invalidNode = () =>
    invalidProjection('Retained evidence node is invalid.');
  const retained = artifact.nodes.map((node) =>
    assertStoredEvidenceNode(node, invalidNode),
  );
  if (
    !isSortedUnique(retained.map(({ nodeId }) => nodeId)) ||
    retained.some(({ type }) => REPLAYED_NODE_TYPES.has(type))
  ) {
    throw new Error('retained evidence is not a canonical projection');
  }
  const termUnions = retained.filter(
    ({ nodeId, type }) =>
      nodeId === replay.termUnionNodeId && type === 'investigation-term-union',
  );
  if (
    termUnions.length !== 1 ||
    retained.filter(({ type }) => type === 'investigation-term-union')
      .length !== 1
  ) {
    throw new Error('term union is unavailable or ambiguous');
  }
  const termUnion = termUnions[0]!;
  const terms = termsFromUnion(termUnion);
  const scanned = scanInvestigationTree({
    repositoryRoot,
    treeOid: replay.baseline.tree,
    terms,
    allowSaturatedTerms: true,
  });
  if (scanned.outcome !== 'ready') {
    throw new Error('scan replay requires narrowing');
  }
  if (
    canonicalJson(scanned.nodes.map(({ nodeId }) => nodeId).sort()) !==
      canonicalJson(replay.scan.nodeIds) ||
    scanned.inventory.evidenceNode.nodeId !== replay.scan.inventoryNodeId ||
    scanned.nodes.some(
      ({ policyDigest }) => policyDigest !== replay.scan.policyDigest,
    )
  ) {
    throw new Error('scan replay identity mismatch');
  }

  const hitNodes = deriveInvestigationHitNodes(scanned.nodes);
  const groupNodes = replayInvestigationGroupNodes({
    hitNodes,
    groups: replay.groups,
  });
  const dispositionNodes = createInvestigationDispositionNodes({
    groupNodes,
    dispositions: replay.dispositions.map(
      ({ groupId, classification, rationale, author }) => ({
        groupId,
        classification,
        rationale,
        author,
      }),
    ),
  });
  if (
    canonicalJson(dispositionNodes.map(({ nodeId }) => nodeId).sort()) !==
    canonicalJson(replay.dispositions.map(({ nodeId }) => nodeId).sort())
  ) {
    throw new Error('disposition replay identity mismatch');
  }
  const coverageNode = createInvestigationCoverageNode({
    effectiveTermIds: terms.map(({ termId }) => termId),
    scanNodes: scanned.nodes,
    inventoryNode: scanned.inventory.evidenceNode,
    hitNodes,
    groupNodes,
    dispositionNodes,
  });
  if (coverageNode.nodeId !== replay.coverageNodeId) {
    throw new Error('coverage replay identity mismatch');
  }

  const nodes = [
    ...retained,
    ...scanned.nodes,
    scanned.inventory.evidenceNode,
    ...hitNodes,
    ...groupNodes,
    ...dispositionNodes,
    coverageNode,
  ].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (
    nodes.length !== replay.fullNodeCount ||
    digest(nodes) !== replay.fullNodesDigest ||
    new Set(nodes.map(({ nodeId }) => nodeId)).size !== nodes.length
  ) {
    throw new Error('full investigation replay digest mismatch');
  }

  return {
    schemaVersion: 1,
    kind: 'investigation-artifact',
    changeId: expectedChangeId,
    legacyMigration: false,
    nodes,
    currentRefs: structuredClone(
      artifact.currentRefs as Record<string, string>,
    ),
    applicability,
    ...(Object.hasOwn(artifact, 'roleResults')
      ? { roleResults: structuredClone(artifact.roleResults as unknown[]) }
      : {}),
  };
}

function parseReplay(value: unknown): GitBackedInvestigationReplay {
  const replay = exactRecord(value, [
    'schemaVersion',
    'kind',
    'baseline',
    'fullNodeCount',
    'fullNodesDigest',
    'termUnionNodeId',
    'scan',
    'groups',
    'dispositions',
    'coverageNodeId',
  ]);
  const baseline = exactRecord(replay.baseline, ['head', 'tree']);
  const scan = exactRecord(replay.scan, [
    'nodeIds',
    'inventoryNodeId',
    'policyDigest',
  ]);
  if (
    replay.schemaVersion !== 1 ||
    replay.kind !== 'git-backed-investigation-replay' ||
    !GIT_OID.test(String(baseline.head)) ||
    !GIT_OID.test(String(baseline.tree)) ||
    !Number.isSafeInteger(replay.fullNodeCount) ||
    (replay.fullNodeCount as number) < 1 ||
    !isDigest(replay.fullNodesDigest) ||
    !isDigest(replay.termUnionNodeId) ||
    !isDigest(replay.coverageNodeId) ||
    !isSortedUniqueDigests(scan.nodeIds) ||
    !isDigest(scan.inventoryNodeId) ||
    !isDigest(scan.policyDigest) ||
    !Array.isArray(replay.groups) ||
    !Array.isArray(replay.dispositions)
  ) {
    throw new Error('invalid replay recipe');
  }
  const groups = replay.groups.map((entry) => {
    const group = exactRecord(entry, [
      'nodeId',
      'policyDigest',
      'selector',
      'hitIds',
      'exceptions',
    ]);
    if (
      !isDigest(group.nodeId) ||
      !isDigest(group.policyDigest) ||
      !isSortedUniqueDigests(group.hitIds) ||
      !Array.isArray(group.exceptions)
    ) {
      throw new Error('invalid replay group');
    }
    return {
      nodeId: group.nodeId,
      policyDigest: group.policyDigest,
      selector: structuredClone(group.selector),
      hitIds: [...group.hitIds],
      exceptions: structuredClone(group.exceptions),
    } satisfies InvestigationGroupReplayRecord;
  });
  const dispositions = replay.dispositions.map((entry) => {
    const disposition = exactRecord(entry, [
      'nodeId',
      'groupId',
      'classification',
      'rationale',
      'author',
    ]);
    if (
      !isDigest(disposition.nodeId) ||
      !isDigest(disposition.groupId) ||
      typeof disposition.classification !== 'string' ||
      typeof disposition.rationale !== 'string' ||
      typeof disposition.author !== 'string'
    ) {
      throw new Error('invalid replay disposition');
    }
    return {
      nodeId: disposition.nodeId,
      groupId: disposition.groupId,
      classification: disposition.classification,
      rationale: disposition.rationale,
      author: disposition.author,
    };
  });
  if (
    !isSortedUnique(groups.map(({ nodeId }) => nodeId)) ||
    !isSortedUnique(dispositions.map(({ nodeId }) => nodeId))
  ) {
    throw new Error('replay records are not canonical');
  }
  return {
    schemaVersion: 1,
    kind: 'git-backed-investigation-replay',
    baseline: { head: baseline.head as string, tree: baseline.tree as string },
    fullNodeCount: replay.fullNodeCount as number,
    fullNodesDigest: replay.fullNodesDigest,
    termUnionNodeId: replay.termUnionNodeId,
    scan: {
      nodeIds: [...(scan.nodeIds as string[])],
      inventoryNodeId: scan.inventoryNodeId,
      policyDigest: scan.policyDigest,
    },
    groups,
    dispositions,
    coverageNodeId: replay.coverageNodeId,
  } as GitBackedInvestigationReplay;
}

function termsFromUnion(node: EvidenceNode): ScanInvestigationTerm[] {
  const output = isRecord(node.output) ? node.output : null;
  if (!output || !Array.isArray(output.terms) || output.terms.length === 0) {
    throw new Error('term union output is malformed');
  }
  return output.terms.map((value) => {
    if (!isRecord(value) || !Array.isArray(value.provenance)) {
      throw new Error('term union entry is malformed');
    }
    const normalized = normalizeInvestigationTerm({
      kind: value.kind,
      value: value.value,
    } as never);
    if (
      value.termId !== normalized.termId ||
      value.matching !== normalized.matching
    ) {
      throw new Error('term union identity is malformed');
    }
    return {
      ...normalized,
      provenance: structuredClone(value.provenance),
    } as ScanInvestigationTerm;
  });
}

function nodesOfType(nodes: EvidenceNode[], type: string): EvidenceNode[] {
  return nodes.filter((node) => node.type === type);
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected record');
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error('record shape mismatch');
  }
  return value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isSortedUniqueDigests(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(isDigest) &&
    isSortedUnique(value as string[])
  );
}

function isSortedUnique(values: string[]): boolean {
  return (
    new Set(values).size === values.length &&
    canonicalJson(values) === canonicalJson([...values].sort())
  );
}

function invalidProjection(message: string) {
  return workflowError(
    'INVALID_INVESTIGATION_ARTIFACT',
    message,
    ExitCode.guard,
  );
}
