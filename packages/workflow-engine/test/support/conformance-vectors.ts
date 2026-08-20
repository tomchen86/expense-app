import fs from 'node:fs';
import path from 'node:path';

const VECTOR_FILE = 'fixtures/conformance-vectors.v1.json';
const VECTOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;

export type CanonicalJsonConformanceVector = Readonly<{
  id: string;
  input: unknown;
  canonical: string;
  sha256: string;
}>;

export type Sha256ConformanceVector = Readonly<{
  id: string;
  utf8: string;
  digest: string;
}>;

export type ManagedTrailerConformanceVector = Readonly<{
  id: string;
  message: string;
  outcome:
    | Readonly<{ state: 'parsed'; value: Readonly<Record<string, unknown>> }>
    | Readonly<{ state: 'unmanaged' }>
    | Readonly<{ state: 'rejected'; error: 'ManagedTrailerSyntaxError' }>;
}>;

export type CollaborationGrantConformanceVector = Readonly<{
  id: string;
  contract: 'collaboration-grant-v1' | 'collaboration-grant-v2-namespace';
  signatureNamespace:
    | 'expense-app.workflow.collaboration-grant.v1'
    | 'workflow.collaboration-grant.v2';
  fixtureVerifier: 'sha256-namespace-nul-payload-base64-armored.v1';
  payload: Readonly<Record<string, unknown>>;
  canonicalPayloadUtf8Base64: string;
  signature: string;
  canonicalEnvelopeUtf8Base64: string;
  envelopeSha256: string;
}>;

export type EvidenceNodeConformanceVector = Readonly<{
  id: string;
  input: Readonly<{
    type: string;
    nodeSchema: string;
    evaluator: string;
    policyDigest: string;
    exactInputDigests: Readonly<Record<string, string>>;
    semanticParentResultDigests: Readonly<Record<string, string>>;
    provenanceParentNodeIds: Readonly<Record<string, string>>;
    outputSchema: string;
    output: unknown;
    runtimeMetadata: Readonly<Record<string, unknown>>;
  }>;
  expected: Readonly<{
    nodeId: string;
    resultDigest: string;
    canonicalEnvelopeUtf8Base64: string;
  }>;
  mutations: Readonly<{
    runtimeMetadata: EvidenceNodeMutation;
    output: EvidenceNodeMutation;
    exactInputDigests: EvidenceNodeMutation;
  }>;
}>;

type EvidenceNodeMutation = Readonly<{
  value: unknown;
  nodeId: string;
  resultDigest: string;
}>;

export type ManagedMessageConformanceVector = Readonly<{
  id: string;
  renderer:
    | 'task'
    | 'plan'
    | 'amend-plan'
    | 'archive'
    | 'authority'
    | 'authority-candidate';
  input: Readonly<Record<string, string>>;
  message: string;
  parsed: Readonly<Record<string, unknown>>;
}>;

export type WorkflowConformanceVectors = Readonly<{
  kind: 'workflow.conformance-vectors.v1';
  schemaVersion: 1;
  algorithms: Readonly<{
    canonicalJson: 'ecmascript-json-utf16-key-order.v1';
    collaborationGrants: 'collaboration-grant-versioned-envelope.v1';
    evidenceNodes: 'evidence-node-identity-and-result.v1';
    managedMessages: 'landed-managed-git-message-renderers.v1';
    sha256: 'sha256-utf8-lowerhex.v1';
    managedTrailers: 'managed-git-trailer-block.v1';
  }>;
  canonicalJson: readonly CanonicalJsonConformanceVector[];
  collaborationGrants: readonly CollaborationGrantConformanceVector[];
  evidenceNodes: readonly EvidenceNodeConformanceVector[];
  managedMessages: readonly ManagedMessageConformanceVector[];
  sha256: readonly Sha256ConformanceVector[];
  managedTrailers: readonly ManagedTrailerConformanceVector[];
  vectorSetDigest: `sha256:${string}`;
}>;

export function loadWorkflowConformanceVectors(
  testDirectory: string,
): WorkflowConformanceVectors {
  const vectorPath = path.join(testDirectory, VECTOR_FILE);
  const stats = fs.lstatSync(vectorPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 1024 * 1024) {
    throw new Error(
      'Workflow conformance vectors must be a bounded regular file.',
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(vectorPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Workflow conformance vectors are malformed JSON.', {
      cause: error,
    });
  }
  assertRecord(value, 'workflow conformance vectors');
  assertExactKeys(value, [
    'algorithms',
    'canonicalJson',
    'collaborationGrants',
    'evidenceNodes',
    'kind',
    'managedMessages',
    'managedTrailers',
    'schemaVersion',
    'sha256',
    'vectorSetDigest',
  ]);
  if (
    value.kind !== 'workflow.conformance-vectors.v1' ||
    value.schemaVersion !== 1 ||
    !PREFIXED_SHA256.test(value.vectorSetDigest as string)
  ) {
    throw new Error('Workflow conformance vector header is invalid.');
  }

  assertRecord(value.algorithms, 'workflow conformance algorithms');
  assertExactKeys(value.algorithms, [
    'canonicalJson',
    'collaborationGrants',
    'evidenceNodes',
    'managedMessages',
    'managedTrailers',
    'sha256',
  ]);
  if (
    value.algorithms.canonicalJson !== 'ecmascript-json-utf16-key-order.v1' ||
    value.algorithms.collaborationGrants !==
      'collaboration-grant-versioned-envelope.v1' ||
    value.algorithms.evidenceNodes !== 'evidence-node-identity-and-result.v1' ||
    value.algorithms.managedMessages !==
      'landed-managed-git-message-renderers.v1' ||
    value.algorithms.sha256 !== 'sha256-utf8-lowerhex.v1' ||
    value.algorithms.managedTrailers !== 'managed-git-trailer-block.v1'
  ) {
    throw new Error('Workflow conformance vector algorithms are invalid.');
  }

  const canonicalJson = parseCanonicalJsonVectors(value.canonicalJson);
  const collaborationGrants = parseCollaborationGrantVectors(
    value.collaborationGrants,
  );
  const evidenceNodes = parseEvidenceNodeVectors(value.evidenceNodes);
  const managedMessages = parseManagedMessageVectors(value.managedMessages);
  const sha256 = parseSha256Vectors(value.sha256);
  const managedTrailers = parseManagedTrailerVectors(value.managedTrailers);
  assertUniqueIds([
    ...canonicalJson,
    ...collaborationGrants,
    ...evidenceNodes,
    ...managedMessages,
    ...sha256,
    ...managedTrailers,
  ]);

  return {
    kind: 'workflow.conformance-vectors.v1',
    schemaVersion: 1,
    algorithms: {
      canonicalJson: 'ecmascript-json-utf16-key-order.v1',
      collaborationGrants: 'collaboration-grant-versioned-envelope.v1',
      evidenceNodes: 'evidence-node-identity-and-result.v1',
      managedMessages: 'landed-managed-git-message-renderers.v1',
      sha256: 'sha256-utf8-lowerhex.v1',
      managedTrailers: 'managed-git-trailer-block.v1',
    },
    canonicalJson,
    collaborationGrants,
    evidenceNodes,
    managedMessages,
    sha256,
    managedTrailers,
    vectorSetDigest: value.vectorSetDigest as `sha256:${string}`,
  };
}

export function conformanceVectorPayload(
  vectors: WorkflowConformanceVectors,
): Omit<WorkflowConformanceVectors, 'vectorSetDigest'> {
  return {
    kind: vectors.kind,
    schemaVersion: vectors.schemaVersion,
    algorithms: vectors.algorithms,
    canonicalJson: vectors.canonicalJson,
    collaborationGrants: vectors.collaborationGrants,
    evidenceNodes: vectors.evidenceNodes,
    managedMessages: vectors.managedMessages,
    sha256: vectors.sha256,
    managedTrailers: vectors.managedTrailers,
  };
}

function parseCollaborationGrantVectors(
  value: unknown,
): CollaborationGrantConformanceVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Collaboration-grant conformance vectors are missing.');
  }
  return value.map((candidate, index) => {
    assertRecord(candidate, `collaboration-grant vector ${index + 1}`);
    assertExactKeys(candidate, [
      'canonicalEnvelopeUtf8Base64',
      'canonicalPayloadUtf8Base64',
      'contract',
      'envelopeSha256',
      'fixtureVerifier',
      'id',
      'payload',
      'signature',
      'signatureNamespace',
    ]);
    const contract = candidate.contract;
    const signatureNamespace = candidate.signatureNamespace;
    const expectedNamespace =
      contract === 'collaboration-grant-v1'
        ? 'expense-app.workflow.collaboration-grant.v1'
        : 'workflow.collaboration-grant.v2';
    if (
      !isVectorId(candidate.id) ||
      (contract !== 'collaboration-grant-v1' &&
        contract !== 'collaboration-grant-v2-namespace') ||
      signatureNamespace !== expectedNamespace ||
      candidate.fixtureVerifier !==
        'sha256-namespace-nul-payload-base64-armored.v1' ||
      !isCanonicalBase64(candidate.canonicalPayloadUtf8Base64) ||
      !isCanonicalBase64(candidate.canonicalEnvelopeUtf8Base64) ||
      !isDigest(candidate.envelopeSha256) ||
      typeof candidate.signature !== 'string'
    ) {
      throw new Error(`Collaboration-grant vector ${index + 1} is invalid.`);
    }
    assertRecord(candidate.payload, `collaboration-grant payload ${index + 1}`);
    return {
      id: candidate.id,
      contract,
      signatureNamespace: expectedNamespace,
      fixtureVerifier: candidate.fixtureVerifier,
      payload: candidate.payload,
      canonicalPayloadUtf8Base64: candidate.canonicalPayloadUtf8Base64,
      signature: candidate.signature,
      canonicalEnvelopeUtf8Base64: candidate.canonicalEnvelopeUtf8Base64,
      envelopeSha256: candidate.envelopeSha256,
    };
  });
}

function parseEvidenceNodeVectors(
  value: unknown,
): EvidenceNodeConformanceVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Evidence-node conformance vectors are missing.');
  }
  return value.map((candidate, index) => {
    assertRecord(candidate, `evidence-node vector ${index + 1}`);
    assertExactKeys(candidate, ['expected', 'id', 'input', 'mutations']);
    if (!isVectorId(candidate.id)) {
      throw new Error(`Evidence-node vector ${index + 1} is invalid.`);
    }
    const input = parseEvidenceNodeInput(candidate.input, index);
    assertRecord(candidate.expected, `evidence-node expected ${index + 1}`);
    assertExactKeys(candidate.expected, [
      'canonicalEnvelopeUtf8Base64',
      'nodeId',
      'resultDigest',
    ]);
    if (
      !isDigest(candidate.expected.nodeId) ||
      !isDigest(candidate.expected.resultDigest) ||
      !isCanonicalBase64(candidate.expected.canonicalEnvelopeUtf8Base64)
    ) {
      throw new Error(`Evidence-node expected ${index + 1} is invalid.`);
    }
    assertRecord(candidate.mutations, `evidence-node mutations ${index + 1}`);
    assertExactKeys(candidate.mutations, [
      'exactInputDigests',
      'output',
      'runtimeMetadata',
    ]);
    return {
      id: candidate.id,
      input,
      expected: {
        nodeId: candidate.expected.nodeId,
        resultDigest: candidate.expected.resultDigest,
        canonicalEnvelopeUtf8Base64:
          candidate.expected.canonicalEnvelopeUtf8Base64,
      },
      mutations: {
        runtimeMetadata: parseEvidenceNodeMutation(
          candidate.mutations.runtimeMetadata,
          index,
        ),
        output: parseEvidenceNodeMutation(candidate.mutations.output, index),
        exactInputDigests: parseEvidenceNodeMutation(
          candidate.mutations.exactInputDigests,
          index,
        ),
      },
    };
  });
}

function parseEvidenceNodeInput(
  value: unknown,
  index: number,
): EvidenceNodeConformanceVector['input'] {
  assertRecord(value, `evidence-node input ${index + 1}`);
  assertExactKeys(value, [
    'evaluator',
    'exactInputDigests',
    'nodeSchema',
    'output',
    'outputSchema',
    'policyDigest',
    'provenanceParentNodeIds',
    'runtimeMetadata',
    'semanticParentResultDigests',
    'type',
  ]);
  if (
    !isNonEmptyString(value.type) ||
    !isNonEmptyString(value.nodeSchema) ||
    !isNonEmptyString(value.evaluator) ||
    !isDigest(value.policyDigest) ||
    !isDigestRecord(value.exactInputDigests) ||
    !isDigestRecord(value.semanticParentResultDigests) ||
    !isDigestRecord(value.provenanceParentNodeIds) ||
    !isNonEmptyString(value.outputSchema)
  ) {
    throw new Error(`Evidence-node input ${index + 1} is invalid.`);
  }
  assertRecord(value.runtimeMetadata, `evidence-node metadata ${index + 1}`);
  return {
    type: value.type,
    nodeSchema: value.nodeSchema,
    evaluator: value.evaluator,
    policyDigest: value.policyDigest,
    exactInputDigests: value.exactInputDigests,
    semanticParentResultDigests: value.semanticParentResultDigests,
    provenanceParentNodeIds: value.provenanceParentNodeIds,
    outputSchema: value.outputSchema,
    output: value.output,
    runtimeMetadata: value.runtimeMetadata,
  };
}

function parseEvidenceNodeMutation(
  value: unknown,
  index: number,
): EvidenceNodeMutation {
  assertRecord(value, `evidence-node mutation ${index + 1}`);
  assertExactKeys(value, ['nodeId', 'resultDigest', 'value']);
  if (!isDigest(value.nodeId) || !isDigest(value.resultDigest)) {
    throw new Error(`Evidence-node mutation ${index + 1} is invalid.`);
  }
  return {
    value: value.value,
    nodeId: value.nodeId,
    resultDigest: value.resultDigest,
  };
}

function parseManagedMessageVectors(
  value: unknown,
): ManagedMessageConformanceVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Managed-message conformance vectors are missing.');
  }
  return value.map((candidate, index) => {
    assertRecord(candidate, `managed-message vector ${index + 1}`);
    assertExactKeys(candidate, [
      'id',
      'input',
      'message',
      'parsed',
      'renderer',
    ]);
    if (
      !isVectorId(candidate.id) ||
      !isManagedMessageRenderer(candidate.renderer) ||
      typeof candidate.message !== 'string'
    ) {
      throw new Error(`Managed-message vector ${index + 1} is invalid.`);
    }
    assertRecord(candidate.input, `managed-message input ${index + 1}`);
    assertRecord(candidate.parsed, `managed-message parsed ${index + 1}`);
    if (
      !Object.values(candidate.input).every(
        (entry) => typeof entry === 'string',
      ) ||
      candidate.message.endsWith('\n')
    ) {
      throw new Error(`Managed-message vector ${index + 1} is invalid.`);
    }
    assertManagedMessageInput(candidate.renderer, candidate.input, index);
    return {
      id: candidate.id,
      renderer: candidate.renderer,
      input: candidate.input as Record<string, string>,
      message: candidate.message,
      parsed: candidate.parsed,
    };
  });
}

function assertManagedMessageInput(
  renderer: ManagedMessageConformanceVector['renderer'],
  input: Record<string, unknown>,
  index: number,
): void {
  const keys =
    renderer === 'task'
      ? ['changeId', 'subject', 'taskId']
      : renderer === 'plan' || renderer === 'archive'
        ? ['changeId']
        : renderer === 'amend-plan'
          ? [
              'amendsPlanningGeneration',
              'changeId',
              'executionImpact',
              'planReview',
              'planningGeneration',
            ]
          : renderer === 'authority'
            ? ['changeId', 'grantId', 'subject']
            : ['changeId', 'subject'];
  try {
    assertExactKeys(input, keys);
  } catch (error) {
    throw new Error(`Managed-message input ${index + 1} is invalid.`, {
      cause: error,
    });
  }
}

function parseCanonicalJsonVectors(
  value: unknown,
): CanonicalJsonConformanceVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Canonical JSON conformance vectors are missing.');
  }
  return value.map((candidate, index) => {
    assertRecord(candidate, `canonical JSON vector ${index + 1}`);
    assertExactKeys(candidate, ['canonical', 'id', 'input', 'sha256']);
    if (
      !isVectorId(candidate.id) ||
      typeof candidate.canonical !== 'string' ||
      typeof candidate.sha256 !== 'string' ||
      !SHA256.test(candidate.sha256)
    ) {
      throw new Error(`Canonical JSON vector ${index + 1} is invalid.`);
    }
    return {
      id: candidate.id,
      input: candidate.input,
      canonical: candidate.canonical,
      sha256: candidate.sha256,
    };
  });
}

function parseSha256Vectors(value: unknown): Sha256ConformanceVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('SHA-256 conformance vectors are missing.');
  }
  return value.map((candidate, index) => {
    assertRecord(candidate, `SHA-256 vector ${index + 1}`);
    assertExactKeys(candidate, ['digest', 'id', 'utf8']);
    if (
      !isVectorId(candidate.id) ||
      typeof candidate.utf8 !== 'string' ||
      typeof candidate.digest !== 'string' ||
      !SHA256.test(candidate.digest)
    ) {
      throw new Error(`SHA-256 vector ${index + 1} is invalid.`);
    }
    return {
      id: candidate.id,
      utf8: candidate.utf8,
      digest: candidate.digest,
    };
  });
}

function parseManagedTrailerVectors(
  value: unknown,
): ManagedTrailerConformanceVector[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Managed trailer conformance vectors are missing.');
  }
  return value.map((candidate, index) => {
    assertRecord(candidate, `managed trailer vector ${index + 1}`);
    assertExactKeys(candidate, ['id', 'message', 'outcome']);
    if (!isVectorId(candidate.id) || typeof candidate.message !== 'string') {
      throw new Error(`Managed trailer vector ${index + 1} is invalid.`);
    }
    assertRecord(candidate.outcome, `managed trailer outcome ${index + 1}`);
    if (candidate.outcome.state === 'parsed') {
      assertExactKeys(candidate.outcome, ['state', 'value']);
      assertRecord(
        candidate.outcome.value,
        `managed trailer value ${index + 1}`,
      );
      return {
        id: candidate.id,
        message: candidate.message,
        outcome: { state: 'parsed', value: candidate.outcome.value },
      };
    }
    if (candidate.outcome.state === 'unmanaged') {
      assertExactKeys(candidate.outcome, ['state']);
      return {
        id: candidate.id,
        message: candidate.message,
        outcome: { state: 'unmanaged' },
      };
    }
    if (
      candidate.outcome.state === 'rejected' &&
      candidate.outcome.error === 'ManagedTrailerSyntaxError'
    ) {
      assertExactKeys(candidate.outcome, ['error', 'state']);
      return {
        id: candidate.id,
        message: candidate.message,
        outcome: {
          state: 'rejected',
          error: 'ManagedTrailerSyntaxError',
        },
      };
    }
    throw new Error(`Managed trailer outcome ${index + 1} is invalid.`);
  });
}

function assertUniqueIds(values: readonly Readonly<{ id: string }>[]): void {
  const ids = values.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Workflow conformance vector IDs must be globally unique.');
  }
}

function isVectorId(value: unknown): value is string {
  return typeof value === 'string' && VECTOR_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isDigestRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isDigest)
  );
}

function isCanonicalBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function isManagedMessageRenderer(
  value: unknown,
): value is ManagedMessageConformanceVector['renderer'] {
  return (
    value === 'task' ||
    value === 'plan' ||
    value === 'amend-plan' ||
    value === 'archive' ||
    value === 'authority' ||
    value === 'authority-candidate'
  );
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const observed = Object.keys(value).sort(compareText);
  const exact = [...expected].sort(compareText);
  if (
    observed.length !== exact.length ||
    observed.some((key, index) => key !== exact[index])
  ) {
    throw new Error(
      `Unexpected conformance vector keys: ${observed.join(', ')}`,
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
