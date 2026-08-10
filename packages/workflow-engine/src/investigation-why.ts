import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.ts';
import { ExitCode, WorkflowError, workflowError } from './errors.ts';
import {
  assertStoredEvidenceNode,
  createEvidenceNode,
  type EvidenceNode,
} from './evidence-node.ts';
import {
  readInvestigationDispositionNode,
  readInvestigationGroupNode,
  readInvestigationHitNode,
} from './investigation-groups.ts';
import { assertPathIdentity as assertCanonicalPathIdentity } from './mutation-class-policy.ts';
import type { TrackedTreeSnapshot } from './tracked-tree-reader.ts';

const WHY_TYPE = 'investigation-why';
const WHY_SCHEMA = 'investigation.why.v1';
const WHY_EVALUATOR = 'investigation-why.v1';
const WHY_OUTPUT_SCHEMA = 'investigation.why-output.v1';
const MANIFEST_SCHEMA = 'investigation.full-blob-manifest.v1';
const SEMANTIC_ASSURANCE = 'actor-attested-not-engine-verified';
const LOAD_BEARING = 'load-bearing';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);
const LF = 0x0a;

const MANIFEST_ENTRY_KEYS = [
  'manifestEntryId',
  'path',
  'treeDigest',
  'blob',
  'coveredHitIds',
  'matchedTermIds',
  'groupIds',
  'dispositionNodeIds',
  'relevantLocations',
  'relationshipsToChange',
] as const;

const MANIFEST_BLOB_KEYS = [
  'objectId',
  'objectType',
  'mode',
  'byteSize',
  'contentSha256',
  'lineCount',
  'contentBase64',
] as const;

const WHY_ANSWER_KEYS = [
  'manifestEntryId',
  'why',
  'protectedInvariant',
  'reviewerQuestion',
  'answer',
  'semanticAuthor',
  'readComplete',
] as const;

const WHY_OUTPUT_KEYS = [
  'manifestEntryId',
  'path',
  'treeDigest',
  'blob',
  'coveredHitIds',
  'matchedTermIds',
  'groupIds',
  'dispositionNodeIds',
  'relevantLocations',
  'relationshipsToChange',
  'why',
  'protectedInvariant',
  'reviewerQuestion',
  'answer',
  'semanticAuthor',
  'readComplete',
  'semanticAssurance',
] as const;

const WHY_BLOB_KEYS = [
  'objectId',
  'objectType',
  'mode',
  'byteSize',
  'contentSha256',
  'lineCount',
] as const;

const WHY_POLICY_DIGEST = sha256(
  canonicalJson({ schema: 'investigation.why-policy.v1' }),
);

type ErrorFactory = (message?: string) => WorkflowError;

type HitOutput = ReturnType<typeof readInvestigationHitNode>;
type GroupOutput = ReturnType<typeof readInvestigationGroupNode>;
type DispositionOutput = ReturnType<typeof readInvestigationDispositionNode>;
type HitRecord = { node: EvidenceNode; output: HitOutput };
type GroupRecord = { node: EvidenceNode; output: GroupOutput };
type DispositionRecord = { node: EvidenceNode; output: DispositionOutput };

type PathIdentity = { rawBase64: string; utf8: string | null };

type ManifestBlob = {
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number;
  contentSha256: string;
  lineCount: number;
  contentBase64: string;
};

type WhyBlob = Omit<ManifestBlob, 'contentBase64'>;

type RelevantLocation = {
  path: PathIdentity;
  surface: 'path' | 'content';
  byteOffset: number;
  byteLength: number;
  termId: string;
  hitId: string;
};

type RelationshipToChange = {
  groupId: string;
  dispositionNodeId: string;
  classification: string;
  rationale: string;
  author: string;
};

export type InvestigationFullBlobManifestEntry = {
  manifestEntryId: string;
  path: PathIdentity;
  treeDigest: string;
  blob: ManifestBlob;
  coveredHitIds: string[];
  matchedTermIds: string[];
  groupIds: string[];
  dispositionNodeIds: string[];
  relevantLocations: RelevantLocation[];
  relationshipsToChange: RelationshipToChange[];
};

export type InvestigationWhyAnswer = {
  manifestEntryId: string;
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: string;
  readComplete: boolean;
};

export type InvestigationWhyOutput = {
  manifestEntryId: string;
  path: PathIdentity;
  treeDigest: string;
  blob: WhyBlob;
  coveredHitIds: string[];
  matchedTermIds: string[];
  groupIds: string[];
  dispositionNodeIds: string[];
  relevantLocations: RelevantLocation[];
  relationshipsToChange: RelationshipToChange[];
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: string;
  readComplete: true;
  semanticAssurance: typeof SEMANTIC_ASSURANCE;
};

type PathAccumulator = {
  path: PathIdentity;
  hits: Map<string, HitOutput>;
  dispositionNodeIds: Set<string>;
  groupIds: Set<string>;
  relationships: Map<string, RelationshipToChange>;
};

/**
 * Deterministically merge every load-bearing disposition's covered hits into one
 * full-blob manifest row per required file, keyed and sorted by raw path bytes —
 * never by group or Git object ID. Each row pins the complete tracked bytes of
 * that path from the snapshot after verifying the recorded object, mode, size,
 * and content digest are internally consistent; identical blobs at distinct
 * paths stay distinct rows. Missing tracked content fails closed.
 */
export function deriveInvestigationFullBlobManifest(input: {
  snapshot: TrackedTreeSnapshot;
  hitNodes: EvidenceNode[];
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
}): InvestigationFullBlobManifestEntry[] {
  assertDigest(
    input.snapshot.treeDigest,
    'Investigation snapshot tree digest is malformed.',
  );
  const entryByPath = indexSnapshotEntries(input.snapshot);
  const hitsById = indexHitNodes(input.hitNodes);
  const groupsById = indexGroupNodes(input.groupNodes);
  const dispositionsById = indexDispositionNodes(input.dispositionNodes);

  for (const hit of hitsById.values()) {
    validateHitAgainstSnapshot(hit, input.snapshot, entryByPath);
  }
  validateGroupCoverage(hitsById, groupsById);
  validateDispositionCoverage(hitsById, groupsById, dispositionsById);

  const perPath = new Map<string, PathAccumulator>();
  for (const { node, output: disposition } of dispositionsById.values()) {
    if (disposition.classification !== LOAD_BEARING) {
      continue;
    }
    for (const hitId of disposition.coveredHitIds) {
      const hit = hitsById.get(hitId)!.output;
      const key = hit.path.rawBase64;
      let accumulator = perPath.get(key);
      if (!accumulator) {
        accumulator = {
          path: hit.path,
          hits: new Map(),
          dispositionNodeIds: new Set(),
          groupIds: new Set(),
          relationships: new Map(),
        };
        perPath.set(key, accumulator);
      }
      accumulator.hits.set(hitId, hit);
      accumulator.dispositionNodeIds.add(node.nodeId);
      accumulator.groupIds.add(disposition.groupId);
      accumulator.relationships.set(node.nodeId, {
        groupId: disposition.groupId,
        dispositionNodeId: node.nodeId,
        classification: disposition.classification,
        rationale: disposition.rationale,
        author: disposition.author,
      });
    }
  }

  return [...perPath.values()]
    .map((accumulator) =>
      buildManifestEntry(accumulator, input.snapshot, entryByPath),
    )
    .sort((left, right) =>
      Buffer.compare(rawPath(left.path), rawPath(right.path)),
    );
}

/**
 * Bind one strict WHY evidence node per required load-bearing manifest row. Every
 * row demands exactly one non-blank, non-placeholder semantic answer; a missing,
 * duplicate, unknown, blank, placeholder, or over-keyed answer, a non-attested
 * `readComplete`, or a forged author fails closed. `readComplete` is recorded
 * only as an actor attestation, never as engine verification, and the complete
 * pinned bytes never leave the runtime manifest.
 */
export function createInvestigationWhyNodes(input: {
  /**
   * Rows that still owe a fresh WHY answer. A semantic-ledger carry may make
   * this a strict subset of the load-bearing coverage manifest.
   */
  manifest: InvestigationFullBlobManifestEntry[];
  /**
   * Complete engine-derived load-bearing coverage, including rows whose exact
   * understanding was carried from the ledger. When omitted, `manifest`
   * remains the complete coverage for historical callers.
   */
  coverageManifest?: InvestigationFullBlobManifestEntry[];
  hitNodes: EvidenceNode[];
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
  answers: InvestigationWhyAnswer[];
}): EvidenceNode[] {
  const manifest = assertManifestEntries(input.manifest);
  const coverageManifest =
    input.coverageManifest === undefined
      ? manifest
      : assertManifestEntries(input.coverageManifest);
  const coverageById = new Map(
    coverageManifest.map((entry) => [entry.manifestEntryId, entry]),
  );
  for (const entry of manifest) {
    const covered = coverageById.get(entry.manifestEntryId);
    if (
      covered === undefined ||
      canonicalJson(covered) !== canonicalJson(entry)
    ) {
      throw whyInvalid(
        'Fresh WHY rows must be an exact subset of complete load-bearing coverage.',
      );
    }
  }
  const manifestById = new Map(
    manifest.map((entry): [string, InvestigationFullBlobManifestEntry] => [
      entry.manifestEntryId,
      entry,
    ]),
  );
  const hitRecords = indexHitNodes(input.hitNodes);
  const groupRecords = indexGroupNodes(input.groupNodes);
  const dispositionRecords = indexDispositionNodes(input.dispositionNodes);
  validateManifestEvidenceBindings(
    coverageManifest,
    hitRecords,
    groupRecords,
    dispositionRecords,
  );
  const hitNodeById = new Map(
    [...hitRecords].map(([nodeId, record]): [string, EvidenceNode] => [
      nodeId,
      record.node,
    ]),
  );
  const dispositionNodeById = new Map(
    [...dispositionRecords].map(([nodeId, record]): [string, EvidenceNode] => [
      nodeId,
      record.node,
    ]),
  );

  const answerByEntry = new Map<string, InvestigationWhyAnswer>();
  for (const answer of input.answers) {
    const validated = assertWhyAnswer(answer);
    if (!manifestById.has(validated.manifestEntryId)) {
      throw whyInvalid('WHY answer targets an unknown manifest row.');
    }
    if (answerByEntry.has(validated.manifestEntryId)) {
      throw whyInvalid('WHY answer duplicates a manifest row.');
    }
    answerByEntry.set(validated.manifestEntryId, validated);
  }
  if (answerByEntry.size !== manifestById.size) {
    throw whyInvalid('Every load-bearing row requires exactly one WHY answer.');
  }

  return manifest.map((entry) =>
    buildWhyNode(
      entry,
      answerByEntry.get(entry.manifestEntryId)!,
      hitNodeById,
      dispositionNodeById,
    ),
  );
}

export function readInvestigationWhyNode(
  node: EvidenceNode,
): InvestigationWhyOutput {
  const validated = assertStoredEvidenceNode(node, whyInvalid);
  if (
    validated.type !== WHY_TYPE ||
    validated.nodeSchema !== WHY_SCHEMA ||
    validated.evaluator !== WHY_EVALUATOR ||
    validated.outputSchema !== WHY_OUTPUT_SCHEMA ||
    validated.policyDigest !== WHY_POLICY_DIGEST
  ) {
    throw whyInvalid('WHY node identity does not match the expected schema.');
  }
  const output = assertExactKeys(validated.output, WHY_OUTPUT_KEYS, whyInvalid);

  const manifestEntryId = assertDigest(
    output.manifestEntryId,
    'WHY manifest row identity is malformed.',
  );
  const path = assertPathIdentity(output.path);
  const treeDigest = assertDigest(
    output.treeDigest,
    'WHY tree digest is malformed.',
  );
  const blob = assertWhyBlob(output.blob);
  const coveredHitIds = assertSortedUniqueDigests(output.coveredHitIds);
  const matchedTermIds = assertSortedUniqueDigests(output.matchedTermIds);
  const groupIds = assertSortedUniqueDigests(output.groupIds);
  const dispositionNodeIds = assertSortedUniqueDigests(
    output.dispositionNodeIds,
  );
  const relevantLocations = assertArray(output.relevantLocations).map(
    assertRelevantLocation,
  );
  const relationshipsToChange = assertArray(output.relationshipsToChange).map(
    assertRelationshipToChange,
  );
  const semantic = assertWhySemanticFields(output);
  assertWhyRowRelationships({
    path,
    blob,
    coveredHitIds,
    matchedTermIds,
    groupIds,
    dispositionNodeIds,
    relevantLocations,
    relationshipsToChange,
  });

  if (output.semanticAssurance !== SEMANTIC_ASSURANCE) {
    throw whyInvalid('WHY semantic assurance label is not actor-attested.');
  }

  assertNodeRoles(
    validated,
    ['answer', 'manifest'],
    [
      ...coveredHitIds.map((_, index) => `hit-${index}`),
      ...dispositionNodeIds.map((_, index) => `disposition-${index}`),
    ],
    whyInvalid,
  );
  const expectedProvenance = parentProvenance(
    coveredHitIds,
    dispositionNodeIds,
  );
  if (
    canonicalJson(validated.provenanceParentNodeIds) !==
    canonicalJson(expectedProvenance)
  ) {
    throw whyInvalid('WHY parent provenance does not match the row evidence.');
  }
  if (validated.exactInputDigests.manifest !== manifestEntryId) {
    throw whyInvalid('WHY manifest input does not match its row identity.');
  }
  if (
    validated.exactInputDigests.answer !==
    whyAnswerDigest({
      manifestEntryId,
      why: semantic.why,
      protectedInvariant: semantic.protectedInvariant,
      reviewerQuestion: semantic.reviewerQuestion,
      answer: semantic.answer,
      semanticAuthor: semantic.semanticAuthor,
      readComplete: true,
    })
  ) {
    throw whyInvalid('WHY answer input does not match its semantic answer.');
  }

  return {
    manifestEntryId,
    path,
    treeDigest,
    blob,
    coveredHitIds,
    matchedTermIds,
    groupIds,
    dispositionNodeIds,
    relevantLocations,
    relationshipsToChange,
    why: semantic.why,
    protectedInvariant: semantic.protectedInvariant,
    reviewerQuestion: semantic.reviewerQuestion,
    answer: semantic.answer,
    semanticAuthor: semantic.semanticAuthor,
    readComplete: true,
    semanticAssurance: SEMANTIC_ASSURANCE,
  };
}

/**
 * Recompute the required full-blob manifest from the current snapshot and reject
 * any WHY evidence set that is not exactly one faithful, current row per
 * load-bearing path. A row whose pinned blob no longer matches its path is stale;
 * a missing, extra, forged, or duplicate row fails closed.
 */
export function validateInvestigationWhyEvidence(input: {
  snapshot: TrackedTreeSnapshot;
  hitNodes: EvidenceNode[];
  groupNodes: EvidenceNode[];
  dispositionNodes: EvidenceNode[];
  whyNodes: EvidenceNode[];
}): { valid: true; requiredRowCount: number } {
  const manifest = deriveInvestigationFullBlobManifest({
    snapshot: input.snapshot,
    hitNodes: input.hitNodes,
    groupNodes: input.groupNodes,
    dispositionNodes: input.dispositionNodes,
  });
  const hitRecords = indexHitNodes(input.hitNodes);
  const dispositionRecords = indexDispositionNodes(input.dispositionNodes);
  const byId = new Map(
    manifest.map((entry): [string, InvestigationFullBlobManifestEntry] => [
      entry.manifestEntryId,
      entry,
    ]),
  );
  const byPath = new Map(
    manifest.map((entry): [string, InvestigationFullBlobManifestEntry] => [
      entry.path.rawBase64,
      entry,
    ]),
  );

  const seen = new Set<string>();
  for (const node of input.whyNodes) {
    const why = readInvestigationWhyNode(node);
    assertCurrentWhyParents(node, why, hitRecords, dispositionRecords);
    const current = byId.get(why.manifestEntryId);
    if (!current) {
      if (byPath.has(why.path.rawBase64)) {
        throw whyStale('WHY row pins a blob that no longer matches the tree.');
      }
      throw whyInvalid('WHY row does not correspond to any load-bearing path.');
    }
    if (
      canonicalJson(whyRowView(why)) !== canonicalJson(manifestRowView(current))
    ) {
      throw whyInvalid(
        'WHY row output does not match the recomputed manifest.',
      );
    }
    if (seen.has(why.manifestEntryId)) {
      throw whyInvalid('WHY evidence duplicates a load-bearing row.');
    }
    seen.add(why.manifestEntryId);
  }
  if (seen.size !== manifest.length) {
    throw whyInvalid('WHY evidence omits a required load-bearing row.');
  }
  return { valid: true, requiredRowCount: manifest.length };
}

function buildManifestEntry(
  accumulator: PathAccumulator,
  snapshot: TrackedTreeSnapshot,
  entryByPath: Map<string, TrackedTreeSnapshot['entries'][number]>,
): InvestigationFullBlobManifestEntry {
  const entry = entryByPath.get(accumulator.path.rawBase64);
  if (!entry) {
    throw whyInvalid('A load-bearing path is absent from the snapshot.');
  }
  if (
    entry.skipReason !== undefined ||
    entry.content === undefined ||
    entry.contentSha256 === undefined
  ) {
    throw whyInvalid('A load-bearing path has no available tracked bytes.');
  }
  const content = entry.content;
  if (
    typeof entry.objectId !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(entry.objectId) ||
    entry.objectType !== 'blob' ||
    typeof entry.mode !== 'string' ||
    !REGULAR_BLOB_MODES.has(entry.mode) ||
    entry.byteSize !== content.byteLength ||
    !DIGEST_PATTERN.test(entry.contentSha256) ||
    sha256Buffer(content) !== entry.contentSha256
  ) {
    throw whyInvalid('Tracked blob metadata is inconsistent with its bytes.');
  }

  const hits = [...accumulator.hits.values()];
  const blob: ManifestBlob = {
    objectId: entry.objectId,
    objectType: entry.objectType,
    mode: entry.mode,
    byteSize: content.byteLength,
    contentSha256: entry.contentSha256,
    lineCount: countLines(content),
    contentBase64: content.toString('base64'),
  };
  const coveredHitIds = [...accumulator.hits.keys()].sort(compareString);
  const matchedTermIds = sortedUnique(hits.map((hit) => hit.termId));
  const groupIds = [...accumulator.groupIds].sort(compareString);
  const dispositionNodeIds = [...accumulator.dispositionNodeIds].sort(
    compareString,
  );
  const relevantLocations = hits
    .map((hit) => ({
      path: hit.path,
      surface: hit.surface,
      byteOffset: hit.byteOffset,
      byteLength: hit.byteLength,
      termId: hit.termId,
      hitId: hit.hitId,
    }))
    .sort((left, right) => compareString(left.hitId, right.hitId));
  const relationshipsToChange = [...accumulator.relationships.values()].sort(
    (left, right) =>
      compareString(left.dispositionNodeId, right.dispositionNodeId),
  );

  const row = {
    path: accumulator.path,
    treeDigest: snapshot.treeDigest,
    blob,
    coveredHitIds,
    matchedTermIds,
    groupIds,
    dispositionNodeIds,
    relevantLocations,
    relationshipsToChange,
  };
  return { manifestEntryId: manifestEntryDigest(row), ...row };
}

function buildWhyNode(
  entry: InvestigationFullBlobManifestEntry,
  answer: InvestigationWhyAnswer,
  hitNodeById: Map<string, EvidenceNode>,
  dispositionNodeById: Map<string, EvidenceNode>,
): EvidenceNode {
  const hitParents = entry.coveredHitIds
    .map((hitId) => resolveNode(hitNodeById, hitId, 'hit'))
    .sort(byNodeId);
  const dispositionParents = entry.dispositionNodeIds
    .map((nodeId) => resolveNode(dispositionNodeById, nodeId, 'disposition'))
    .sort(byNodeId);

  const semantic: Record<string, string> = {};
  const provenance: Record<string, string> = {};
  hitParents.forEach((node, index) => {
    semantic[`hit-${index}`] = node.resultDigest;
    provenance[`hit-${index}`] = node.nodeId;
  });
  dispositionParents.forEach((node, index) => {
    semantic[`disposition-${index}`] = node.resultDigest;
    provenance[`disposition-${index}`] = node.nodeId;
  });

  const blob = whyBlobView(entry.blob);
  const output: InvestigationWhyOutput = {
    manifestEntryId: entry.manifestEntryId,
    path: entry.path,
    treeDigest: entry.treeDigest,
    blob,
    coveredHitIds: entry.coveredHitIds,
    matchedTermIds: entry.matchedTermIds,
    groupIds: entry.groupIds,
    dispositionNodeIds: entry.dispositionNodeIds,
    relevantLocations: entry.relevantLocations,
    relationshipsToChange: entry.relationshipsToChange,
    why: answer.why,
    protectedInvariant: answer.protectedInvariant,
    reviewerQuestion: answer.reviewerQuestion,
    answer: answer.answer,
    semanticAuthor: answer.semanticAuthor,
    readComplete: true,
    semanticAssurance: SEMANTIC_ASSURANCE,
  };

  return createEvidenceNode({
    type: WHY_TYPE,
    nodeSchema: WHY_SCHEMA,
    evaluator: WHY_EVALUATOR,
    policyDigest: WHY_POLICY_DIGEST,
    exactInputDigests: {
      answer: whyAnswerDigest(answer),
      manifest: entry.manifestEntryId,
    },
    semanticParentResultDigests: semantic,
    provenanceParentNodeIds: provenance,
    outputSchema: WHY_OUTPUT_SCHEMA,
    output,
    runtimeMetadata: {},
  });
}

function resolveNode(
  nodesById: Map<string, EvidenceNode>,
  nodeId: string,
  role: string,
): EvidenceNode {
  const node = nodesById.get(nodeId);
  if (!node) {
    throw whyInvalid(`WHY row references an unavailable ${role} node.`);
  }
  return node;
}

function assertWhyAnswer(value: unknown): InvestigationWhyAnswer {
  const record = assertExactKeys(value, WHY_ANSWER_KEYS, whyInvalid);
  const manifestEntryId = assertDigest(
    record.manifestEntryId,
    'WHY answer manifest row identity is malformed.',
  );
  const why = assertSemanticText(record.why, 'why');
  const protectedInvariant = assertSemanticText(
    record.protectedInvariant,
    'protected invariant',
  );
  const reviewerQuestion = assertSemanticText(
    record.reviewerQuestion,
    'reviewer question',
  );
  const answer = assertSemanticText(record.answer, 'answer');
  if (
    typeof record.semanticAuthor !== 'string' ||
    record.semanticAuthor.trim().length === 0
  ) {
    throw whyInvalid('WHY semantic author is required.');
  }
  if (record.readComplete !== true) {
    throw whyInvalid('WHY readComplete must be an explicit actor attestation.');
  }
  return {
    manifestEntryId,
    why,
    protectedInvariant,
    reviewerQuestion,
    answer,
    semanticAuthor: record.semanticAuthor,
    readComplete: true,
  };
}

function assertWhySemanticFields(output: Record<string, unknown>): {
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: string;
} {
  const why = assertSemanticText(output.why, 'why');
  const protectedInvariant = assertSemanticText(
    output.protectedInvariant,
    'protected invariant',
  );
  const reviewerQuestion = assertSemanticText(
    output.reviewerQuestion,
    'reviewer question',
  );
  const answer = assertSemanticText(output.answer, 'answer');
  if (
    typeof output.semanticAuthor !== 'string' ||
    output.semanticAuthor.trim().length === 0
  ) {
    throw whyInvalid('WHY semantic author is required.');
  }
  if (output.readComplete !== true) {
    throw whyInvalid('WHY readComplete must be an explicit actor attestation.');
  }
  return {
    why,
    protectedInvariant,
    reviewerQuestion,
    answer,
    semanticAuthor: output.semanticAuthor,
  };
}

function assertSemanticText(value: unknown, label: string): string {
  if (typeof value !== 'string' || isPlaceholder(value)) {
    throw whyInvalid(`WHY ${label} is blank or a placeholder.`);
  }
  return value;
}

/**
 * Reject blank text and common placeholder shapes while accepting authored prose
 * that merely quotes an HTML comment (which is neutralized downstream by the
 * design projection's escaping, not here).
 */
function isPlaceholder(value: string): boolean {
  if (value.trim().length === 0) {
    return true;
  }
  if (/\b(?:TODO|FIXME|TBD|XXX|WIP)\b/i.test(value)) {
    return true;
  }
  if (/\{\{[\s\S]*?\}\}/.test(value)) {
    return true;
  }
  // An angle-bracket fill-in such as "<fill invariant>" is a placeholder; an
  // HTML comment "<!-- ... -->" is authored prose and is allowed through.
  if (/<(?!!)[^>]*>/.test(value)) {
    return true;
  }
  return false;
}

function assertWhyBlob(value: unknown): WhyBlob {
  const record = assertExactKeys(value, WHY_BLOB_KEYS, whyInvalid);
  if (
    typeof record.objectId !== 'string' ||
    !GIT_OBJECT_ID_PATTERN.test(record.objectId) ||
    record.objectType !== 'blob' ||
    typeof record.mode !== 'string' ||
    !REGULAR_BLOB_MODES.has(record.mode) ||
    !Number.isSafeInteger(record.byteSize) ||
    (record.byteSize as number) < 0 ||
    typeof record.contentSha256 !== 'string' ||
    !DIGEST_PATTERN.test(record.contentSha256) ||
    !Number.isSafeInteger(record.lineCount) ||
    (record.lineCount as number) < 0
  ) {
    throw whyInvalid('WHY blob metadata is malformed.');
  }
  return {
    objectId: record.objectId,
    objectType: record.objectType,
    mode: record.mode,
    byteSize: record.byteSize as number,
    contentSha256: record.contentSha256,
    lineCount: record.lineCount as number,
  };
}

function assertRelevantLocation(value: unknown): RelevantLocation {
  const record = assertExactKeys(
    value,
    ['path', 'surface', 'byteOffset', 'byteLength', 'termId', 'hitId'],
    whyInvalid,
  );
  const path = assertPathIdentity(record.path);
  if (
    (record.surface !== 'path' && record.surface !== 'content') ||
    !Number.isSafeInteger(record.byteOffset) ||
    (record.byteOffset as number) < 0 ||
    !Number.isSafeInteger(record.byteLength) ||
    (record.byteLength as number) <= 0 ||
    typeof record.termId !== 'string' ||
    !DIGEST_PATTERN.test(record.termId) ||
    typeof record.hitId !== 'string' ||
    !DIGEST_PATTERN.test(record.hitId)
  ) {
    throw whyInvalid('WHY relevant location is malformed.');
  }
  return {
    path,
    surface: record.surface,
    byteOffset: record.byteOffset as number,
    byteLength: record.byteLength as number,
    termId: record.termId,
    hitId: record.hitId,
  };
}

function assertRelationshipToChange(value: unknown): RelationshipToChange {
  const record = assertExactKeys(
    value,
    ['groupId', 'dispositionNodeId', 'classification', 'rationale', 'author'],
    whyInvalid,
  );
  if (
    typeof record.groupId !== 'string' ||
    !DIGEST_PATTERN.test(record.groupId) ||
    typeof record.dispositionNodeId !== 'string' ||
    !DIGEST_PATTERN.test(record.dispositionNodeId) ||
    record.classification !== LOAD_BEARING ||
    typeof record.rationale !== 'string' ||
    record.rationale.trim().length === 0 ||
    typeof record.author !== 'string' ||
    record.author.trim().length === 0
  ) {
    throw whyInvalid('WHY relationship-to-change is malformed.');
  }
  return {
    groupId: record.groupId,
    dispositionNodeId: record.dispositionNodeId,
    classification: LOAD_BEARING,
    rationale: record.rationale,
    author: record.author,
  };
}

function indexSnapshotEntries(
  snapshot: TrackedTreeSnapshot,
): Map<string, TrackedTreeSnapshot['entries'][number]> {
  const entries = new Map<string, TrackedTreeSnapshot['entries'][number]>();
  for (const entry of snapshot.entries) {
    const path = assertPathIdentity(entry.path);
    if (entries.has(path.rawBase64)) {
      throw whyInvalid('Investigation snapshot contains a duplicate raw path.');
    }
    entries.set(path.rawBase64, entry);
  }
  return entries;
}

function indexHitNodes(nodes: EvidenceNode[]): Map<string, HitRecord> {
  const records = new Map<string, HitRecord>();
  for (const node of nodes) {
    let output: HitOutput;
    try {
      output = readInvestigationHitNode(node);
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw whyInvalid(error.message);
      }
      throw error;
    }
    if (output.hitId !== node.nodeId) {
      throw whyInvalid('Hit node identity is inconsistent.');
    }
    if (records.has(node.nodeId)) {
      throw whyInvalid('Investigation contains a duplicate hit node.');
    }
    records.set(node.nodeId, { node, output });
  }
  return records;
}

function indexGroupNodes(nodes: EvidenceNode[]): Map<string, GroupRecord> {
  const records = new Map<string, GroupRecord>();
  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    let output: GroupOutput;
    try {
      output = readInvestigationGroupNode(node);
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw whyInvalid(error.message);
      }
      throw error;
    }
    if (seenNodeIds.has(node.nodeId) || records.has(output.groupId)) {
      throw whyInvalid('Investigation contains a duplicate group node.');
    }
    seenNodeIds.add(node.nodeId);
    records.set(output.groupId, { node, output });
  }
  return records;
}

function indexDispositionNodes(
  nodes: EvidenceNode[],
): Map<string, DispositionRecord> {
  const records = new Map<string, DispositionRecord>();
  for (const node of nodes) {
    let output: DispositionOutput;
    try {
      output = readInvestigationDispositionNode(node);
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw whyInvalid(error.message);
      }
      throw error;
    }
    if (records.has(node.nodeId)) {
      throw whyInvalid('Investigation contains a duplicate disposition node.');
    }
    records.set(node.nodeId, { node, output });
  }
  return records;
}

function validateHitAgainstSnapshot(
  hit: HitRecord,
  snapshot: TrackedTreeSnapshot,
  entries: Map<string, TrackedTreeSnapshot['entries'][number]>,
): void {
  if (hit.node.exactInputDigests.tree !== snapshot.treeDigest) {
    throw whyStale('Investigation hit pins a different source tree.');
  }
  const entry = entries.get(hit.output.path.rawBase64);
  if (!entry) {
    throw whyStale('Investigation hit path is absent from the selected tree.');
  }
  const sourceObject = {
    objectId: entry.objectId,
    objectType: entry.objectType,
    mode: entry.mode,
    byteSize: entry.byteSize,
    contentSha256: entry.contentSha256 ?? null,
    skipReason: entry.skipReason ?? null,
  };
  if (canonicalJson(sourceObject) !== canonicalJson(hit.output.sourceObject)) {
    throw whyStale(
      'Investigation hit source object no longer matches the selected tree.',
    );
  }

  const extent =
    hit.output.surface === 'path'
      ? rawPath(hit.output.path).byteLength
      : entry.content?.byteLength;
  if (
    extent === undefined ||
    hit.output.byteOffset > extent - hit.output.byteLength
  ) {
    throw whyInvalid('Investigation hit location is outside its source bytes.');
  }
}

function validateGroupCoverage(
  hits: Map<string, HitRecord>,
  groups: Map<string, GroupRecord>,
): void {
  const covered = new Set<string>();
  for (const { node, output } of groups.values()) {
    if (output.hitIds.length === 0) {
      throw whyInvalid('Investigation group must cover at least one hit.');
    }
    const semantic: Record<string, string> = {};
    const provenance: Record<string, string> = {};
    const currentHits: HitOutput[] = [];
    output.hitIds.forEach((hitId, index) => {
      const hit = hits.get(hitId);
      if (!hit) {
        throw whyInvalid('Investigation group covers an unknown hit.');
      }
      if (covered.has(hitId)) {
        throw whyInvalid('Investigation hit belongs to overlapping groups.');
      }
      covered.add(hitId);
      semantic[`hit-${index}`] = hit.node.resultDigest;
      provenance[`hit-${index}`] = hit.node.nodeId;
      currentHits.push(hit.output);
    });
    if (
      canonicalJson(node.semanticParentResultDigests) !==
        canonicalJson(semantic) ||
      canonicalJson(node.provenanceParentNodeIds) !==
        canonicalJson(provenance) ||
      canonicalJson(output.hits) !== canonicalJson(currentHits)
    ) {
      throw whyInvalid('Investigation group does not match its current hits.');
    }
  }
  if (covered.size !== hits.size) {
    throw whyInvalid(
      'Every current investigation hit requires exactly one group.',
    );
  }
}

function validateDispositionCoverage(
  hits: Map<string, HitRecord>,
  groups: Map<string, GroupRecord>,
  dispositions: Map<string, DispositionRecord>,
): void {
  const covered = new Set<string>();
  const dispositionedGroups = new Set<string>();
  for (const { node, output } of dispositions.values()) {
    const group = groups.get(output.groupId);
    if (!group) {
      throw whyInvalid('Disposition references an unknown group.');
    }
    if (dispositionedGroups.has(output.groupId)) {
      throw whyInvalid('Investigation group has multiple dispositions.');
    }
    dispositionedGroups.add(output.groupId);
    if (
      node.provenanceParentNodeIds.group !== group.node.nodeId ||
      node.semanticParentResultDigests.group !== group.node.resultDigest ||
      canonicalJson(output.coveredHitIds) !==
        canonicalJson(group.output.hitIds) ||
      canonicalJson(output.sourceObjects) !==
        canonicalJson(group.output.sourceObjects) ||
      canonicalJson(output.selectorEvidence) !==
        canonicalJson(group.output.selector) ||
      canonicalJson(output.exceptions) !==
        canonicalJson(group.output.exceptions)
    ) {
      throw whyInvalid('Disposition does not match its current group parent.');
    }
    const dispositionHits: HitOutput[] = [];
    for (const hitId of output.coveredHitIds) {
      const hit = hits.get(hitId);
      if (!hit) {
        throw whyInvalid('Disposition covers an unknown hit.');
      }
      if (covered.has(hitId)) {
        throw whyInvalid('Investigation hit has overlapping dispositions.');
      }
      covered.add(hitId);
      dispositionHits.push(hit.output);
    }
    if (
      canonicalJson(output.sourceObjects) !==
      canonicalJson(dedupeHitSourceObjects(dispositionHits))
    ) {
      throw whyInvalid(
        'Disposition source objects do not match its covered hits.',
      );
    }
  }
  if (covered.size !== hits.size) {
    throw whyInvalid(
      'Every current investigation hit requires exactly one disposition.',
    );
  }
  if (dispositionedGroups.size !== groups.size) {
    throw whyInvalid(
      'Every current investigation group requires exactly one disposition.',
    );
  }
}

function dedupeHitSourceObjects(
  hits: HitOutput[],
): HitOutput['sourceObject'][] {
  const byObjectId = new Map<string, HitOutput['sourceObject']>();
  for (const hit of hits) {
    const existing = byObjectId.get(hit.sourceObject.objectId);
    if (
      existing &&
      canonicalJson(existing) !== canonicalJson(hit.sourceObject)
    ) {
      throw whyInvalid('One object ID has conflicting hit metadata.');
    }
    byObjectId.set(hit.sourceObject.objectId, hit.sourceObject);
  }
  return [...byObjectId.values()].sort((left, right) =>
    compareString(left.objectId, right.objectId),
  );
}

function assertManifestEntries(
  value: unknown,
): InvestigationFullBlobManifestEntry[] {
  if (!Array.isArray(value)) {
    throw whyInvalid('Full-blob manifest must be an array.');
  }
  const entries = value.map(assertManifestEntry);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  let priorPath: Buffer | null = null;
  for (const entry of entries) {
    if (seenIds.has(entry.manifestEntryId)) {
      throw whyInvalid('Full-blob manifest contains a duplicate row identity.');
    }
    if (seenPaths.has(entry.path.rawBase64)) {
      throw whyInvalid('Full-blob manifest contains a duplicate raw path.');
    }
    const path = rawPath(entry.path);
    if (priorPath && Buffer.compare(priorPath, path) >= 0) {
      throw whyInvalid('Full-blob manifest rows are not canonically sorted.');
    }
    seenIds.add(entry.manifestEntryId);
    seenPaths.add(entry.path.rawBase64);
    priorPath = path;
  }
  return entries;
}

function assertManifestEntry(
  value: unknown,
): InvestigationFullBlobManifestEntry {
  const record = assertExactKeys(value, MANIFEST_ENTRY_KEYS, whyInvalid);
  const manifestEntryId = assertDigest(
    record.manifestEntryId,
    'Full-blob manifest row identity is malformed.',
  );
  const path = assertPathIdentity(record.path);
  const treeDigest = assertDigest(
    record.treeDigest,
    'Full-blob manifest tree digest is malformed.',
  );
  const blob = assertManifestBlob(record.blob);
  const coveredHitIds = assertSortedUniqueDigests(record.coveredHitIds);
  const matchedTermIds = assertSortedUniqueDigests(record.matchedTermIds);
  const groupIds = assertSortedUniqueDigests(record.groupIds);
  const dispositionNodeIds = assertSortedUniqueDigests(
    record.dispositionNodeIds,
  );
  const relevantLocations = assertArray(record.relevantLocations).map(
    assertRelevantLocation,
  );
  const relationshipsToChange = assertArray(record.relationshipsToChange).map(
    assertRelationshipToChange,
  );

  assertWhyRowRelationships({
    path,
    blob,
    coveredHitIds,
    matchedTermIds,
    groupIds,
    dispositionNodeIds,
    relevantLocations,
    relationshipsToChange,
  });
  const row = {
    path,
    treeDigest,
    blob,
    coveredHitIds,
    matchedTermIds,
    groupIds,
    dispositionNodeIds,
    relevantLocations,
    relationshipsToChange,
  };
  if (manifestEntryDigest(row) !== manifestEntryId) {
    throw whyInvalid(
      'Full-blob manifest row identity does not match its bytes.',
    );
  }
  return { manifestEntryId, ...row };
}

function assertManifestBlob(value: unknown): ManifestBlob {
  const record = assertExactKeys(value, MANIFEST_BLOB_KEYS, whyInvalid);
  const blob = assertWhyBlob({
    objectId: record.objectId,
    objectType: record.objectType,
    mode: record.mode,
    byteSize: record.byteSize,
    contentSha256: record.contentSha256,
    lineCount: record.lineCount,
  });
  if (typeof record.contentBase64 !== 'string') {
    throw whyInvalid('Full-blob manifest content is malformed.');
  }
  const content = Buffer.from(record.contentBase64, 'base64');
  if (
    content.toString('base64') !== record.contentBase64 ||
    content.byteLength !== blob.byteSize ||
    sha256Buffer(content) !== blob.contentSha256 ||
    countLines(content) !== blob.lineCount
  ) {
    throw whyInvalid('Full-blob manifest content does not match its metadata.');
  }
  return { ...blob, contentBase64: record.contentBase64 };
}

function validateManifestEvidenceBindings(
  manifest: InvestigationFullBlobManifestEntry[],
  hits: Map<string, HitRecord>,
  groups: Map<string, GroupRecord>,
  dispositions: Map<string, DispositionRecord>,
): void {
  validateGroupCoverage(hits, groups);
  validateDispositionCoverage(hits, groups, dispositions);
  const expectedByPath = new Map<string, PathAccumulator>();
  for (const { node, output } of dispositions.values()) {
    if (output.classification !== LOAD_BEARING) {
      continue;
    }
    for (const hitId of output.coveredHitIds) {
      const hit = hits.get(hitId)!.output;
      let accumulator = expectedByPath.get(hit.path.rawBase64);
      if (!accumulator) {
        accumulator = {
          path: hit.path,
          hits: new Map(),
          dispositionNodeIds: new Set(),
          groupIds: new Set(),
          relationships: new Map(),
        };
        expectedByPath.set(hit.path.rawBase64, accumulator);
      }
      accumulator.hits.set(hitId, hit);
      accumulator.dispositionNodeIds.add(node.nodeId);
      accumulator.groupIds.add(output.groupId);
      accumulator.relationships.set(node.nodeId, {
        groupId: output.groupId,
        dispositionNodeId: node.nodeId,
        classification: output.classification,
        rationale: output.rationale,
        author: output.author,
      });
    }
  }
  if (expectedByPath.size !== manifest.length) {
    throw whyInvalid(
      'Full-blob manifest does not cover every load-bearing path exactly once.',
    );
  }

  for (const entry of manifest) {
    const expected = expectedByPath.get(entry.path.rawBase64);
    if (!expected) {
      throw whyInvalid('Full-blob manifest contains a non-load-bearing path.');
    }
    const expectedHits = [...expected.hits.values()];
    const expectedView = {
      coveredHitIds: [...expected.hits.keys()].sort(compareString),
      matchedTermIds: sortedUnique(expectedHits.map((hit) => hit.termId)),
      groupIds: [...expected.groupIds].sort(compareString),
      dispositionNodeIds: [...expected.dispositionNodeIds].sort(compareString),
      relevantLocations: expectedHits
        .map((hit) => ({
          path: hit.path,
          surface: hit.surface,
          byteOffset: hit.byteOffset,
          byteLength: hit.byteLength,
          termId: hit.termId,
          hitId: hit.hitId,
        }))
        .sort((left, right) => compareString(left.hitId, right.hitId)),
      relationshipsToChange: [...expected.relationships.values()].sort(
        (left, right) =>
          compareString(left.dispositionNodeId, right.dispositionNodeId),
      ),
    };
    if (
      canonicalJson({
        coveredHitIds: entry.coveredHitIds,
        matchedTermIds: entry.matchedTermIds,
        groupIds: entry.groupIds,
        dispositionNodeIds: entry.dispositionNodeIds,
        relevantLocations: entry.relevantLocations,
        relationshipsToChange: entry.relationshipsToChange,
      }) !== canonicalJson(expectedView)
    ) {
      throw whyInvalid(
        'Full-blob manifest row does not match its evidence parents.',
      );
    }
    for (const hit of expectedHits) {
      if (
        hit.sourceObject.objectId !== entry.blob.objectId ||
        hit.sourceObject.objectType !== entry.blob.objectType ||
        hit.sourceObject.mode !== entry.blob.mode ||
        hit.sourceObject.byteSize !== entry.blob.byteSize ||
        hit.sourceObject.contentSha256 !== entry.blob.contentSha256 ||
        hit.sourceObject.skipReason !== null ||
        hits.get(hit.hitId)!.node.exactInputDigests.tree !== entry.treeDigest
      ) {
        throw whyInvalid(
          'Full-blob manifest blob or tree differs from its hit evidence.',
        );
      }
    }
  }
}

function assertWhyRowRelationships(input: {
  path: PathIdentity;
  blob: WhyBlob;
  coveredHitIds: string[];
  matchedTermIds: string[];
  groupIds: string[];
  dispositionNodeIds: string[];
  relevantLocations: RelevantLocation[];
  relationshipsToChange: RelationshipToChange[];
}): void {
  if (input.coveredHitIds.length === 0) {
    throw whyInvalid('WHY row must cover at least one hit.');
  }
  let priorHit: string | null = null;
  for (const location of input.relevantLocations) {
    if (
      canonicalJson(location.path) !== canonicalJson(input.path) ||
      (priorHit !== null && location.hitId <= priorHit)
    ) {
      throw whyInvalid('WHY relevant locations are inconsistent or unsorted.');
    }
    const extent =
      location.surface === 'path'
        ? rawPath(input.path).byteLength
        : input.blob.byteSize;
    if (location.byteOffset > extent - location.byteLength) {
      throw whyInvalid('WHY relevant location is outside its source bytes.');
    }
    priorHit = location.hitId;
  }
  if (
    canonicalJson(input.relevantLocations.map(({ hitId }) => hitId)) !==
      canonicalJson(input.coveredHitIds) ||
    canonicalJson(
      sortedUnique(input.relevantLocations.map(({ termId }) => termId)),
    ) !== canonicalJson(input.matchedTermIds)
  ) {
    throw whyInvalid('WHY hit or term identities do not match its locations.');
  }

  let priorDisposition: string | null = null;
  for (const relationship of input.relationshipsToChange) {
    if (
      priorDisposition !== null &&
      relationship.dispositionNodeId <= priorDisposition
    ) {
      throw whyInvalid('WHY relationships are not canonically sorted.');
    }
    priorDisposition = relationship.dispositionNodeId;
  }
  if (
    canonicalJson(
      input.relationshipsToChange.map(
        ({ dispositionNodeId }) => dispositionNodeId,
      ),
    ) !== canonicalJson(input.dispositionNodeIds) ||
    canonicalJson(
      sortedUnique(input.relationshipsToChange.map(({ groupId }) => groupId)),
    ) !== canonicalJson(input.groupIds)
  ) {
    throw whyInvalid(
      'WHY group or disposition identities do not match its relationships.',
    );
  }
}

function assertCurrentWhyParents(
  node: EvidenceNode,
  why: InvestigationWhyOutput,
  hits: Map<string, HitRecord>,
  dispositions: Map<string, DispositionRecord>,
): void {
  const semantic: Record<string, string> = {};
  const provenance = parentProvenance(
    why.coveredHitIds,
    why.dispositionNodeIds,
  );
  why.coveredHitIds.forEach((hitId, index) => {
    const hit = hits.get(hitId);
    if (!hit) {
      throw whyInvalid('WHY row references an unavailable current hit.');
    }
    semantic[`hit-${index}`] = hit.node.resultDigest;
  });
  why.dispositionNodeIds.forEach((nodeId, index) => {
    const disposition = dispositions.get(nodeId);
    if (!disposition) {
      throw whyInvalid(
        'WHY row references an unavailable current disposition.',
      );
    }
    semantic[`disposition-${index}`] = disposition.node.resultDigest;
  });
  if (
    canonicalJson(node.provenanceParentNodeIds) !== canonicalJson(provenance) ||
    canonicalJson(node.semanticParentResultDigests) !== canonicalJson(semantic)
  ) {
    throw whyInvalid('WHY parent edges do not match current evidence.');
  }
}

function parentProvenance(
  hitIds: string[],
  dispositionNodeIds: string[],
): Record<string, string> {
  const provenance: Record<string, string> = {};
  hitIds.forEach((hitId, index) => {
    provenance[`hit-${index}`] = hitId;
  });
  dispositionNodeIds.forEach((nodeId, index) => {
    provenance[`disposition-${index}`] = nodeId;
  });
  return provenance;
}

function manifestEntryDigest(
  entry: Omit<InvestigationFullBlobManifestEntry, 'manifestEntryId'>,
): string {
  return sha256(canonicalJson({ schema: MANIFEST_SCHEMA, ...entry }));
}

function whyRowView(why: InvestigationWhyOutput): unknown {
  return {
    manifestEntryId: why.manifestEntryId,
    path: why.path,
    treeDigest: why.treeDigest,
    blob: why.blob,
    coveredHitIds: why.coveredHitIds,
    matchedTermIds: why.matchedTermIds,
    groupIds: why.groupIds,
    dispositionNodeIds: why.dispositionNodeIds,
    relevantLocations: why.relevantLocations,
    relationshipsToChange: why.relationshipsToChange,
  };
}

function manifestRowView(entry: InvestigationFullBlobManifestEntry): unknown {
  return {
    manifestEntryId: entry.manifestEntryId,
    path: entry.path,
    treeDigest: entry.treeDigest,
    blob: whyBlobView(entry.blob),
    coveredHitIds: entry.coveredHitIds,
    matchedTermIds: entry.matchedTermIds,
    groupIds: entry.groupIds,
    dispositionNodeIds: entry.dispositionNodeIds,
    relevantLocations: entry.relevantLocations,
    relationshipsToChange: entry.relationshipsToChange,
  };
}

function whyBlobView(blob: ManifestBlob): WhyBlob {
  return {
    objectId: blob.objectId,
    objectType: blob.objectType,
    mode: blob.mode,
    byteSize: blob.byteSize,
    contentSha256: blob.contentSha256,
    lineCount: blob.lineCount,
  };
}

function whyAnswerDigest(answer: {
  manifestEntryId: string;
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: string;
  readComplete: boolean;
}): string {
  return sha256(
    canonicalJson({
      schema: 'investigation.why-answer.v1',
      manifestEntryId: answer.manifestEntryId,
      why: answer.why,
      protectedInvariant: answer.protectedInvariant,
      reviewerQuestion: answer.reviewerQuestion,
      answer: answer.answer,
      semanticAuthor: answer.semanticAuthor,
      readComplete: answer.readComplete,
    }),
  );
}

function assertPathIdentity(value: unknown): PathIdentity {
  const path = assertCanonicalPathIdentity(value, whyInvalid);
  return { rawBase64: path.raw.toString('base64'), utf8: path.utf8 };
}

function assertDigest(value: unknown, message: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw whyInvalid(message);
  }
  return value;
}

function assertSortedUniqueDigests(value: unknown): string[] {
  const array = assertArray(value);
  let previous: string | null = null;
  for (const item of array) {
    if (typeof item !== 'string' || !DIGEST_PATTERN.test(item)) {
      throw whyInvalid('WHY identifier array element is malformed.');
    }
    if (previous !== null && item <= previous) {
      throw whyInvalid('WHY identifier array is not sorted and unique.');
    }
    previous = item;
  }
  return array as string[];
}

function assertArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw whyInvalid('Expected an array value.');
  }
  return value;
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  invalid: ErrorFactory,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('WHY value is malformed.');
  }
  const record = value as Record<string, unknown>;
  const own = Object.keys(record);
  if (
    own.length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
  ) {
    throw invalid('WHY value keys are unexpected.');
  }
  return record;
}

function assertNodeRoles(
  node: EvidenceNode,
  exactInputRoles: string[],
  parentRoles: string[],
  invalid: ErrorFactory,
): void {
  const expectedInputs = [...exactInputRoles].sort();
  const expectedParents = [...parentRoles].sort();
  const actualInputs = Object.keys(node.exactInputDigests).sort();
  const actualSemantic = Object.keys(node.semanticParentResultDigests).sort();
  const actualProvenance = Object.keys(node.provenanceParentNodeIds).sort();
  if (
    canonicalJson(actualInputs) !== canonicalJson(expectedInputs) ||
    canonicalJson(actualSemantic) !== canonicalJson(expectedParents) ||
    canonicalJson(actualProvenance) !== canonicalJson(expectedParents)
  ) {
    throw invalid('WHY node input or parent roles are unexpected.');
  }
}

function countLines(content: Buffer): number {
  if (content.length === 0) {
    return 0;
  }
  let count = 0;
  for (const byte of content) {
    if (byte === LF) {
      count += 1;
    }
  }
  return content[content.length - 1] === LF ? count : count + 1;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareString);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byNodeId(left: EvidenceNode, right: EvidenceNode): number {
  return compareString(left.nodeId, right.nodeId);
}

function rawPath(path: PathIdentity): Buffer {
  return Buffer.from(path.rawBase64, 'base64');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function whyInvalid(message = 'Investigation WHY evidence is malformed.') {
  return workflowError('INVESTIGATION_WHY_INVALID', message, ExitCode.usage);
}

function whyStale(message = 'Investigation WHY evidence is stale.') {
  return workflowError('INVESTIGATION_WHY_STALE', message, ExitCode.staleState);
}
