import {
  assertStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope,
  createEvidenceNode,
  type EvidenceNode,
} from '@jigwright/core/evidence-node';

const FIXTURE_POLICY_DIGEST =
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

export class FixtureEvidenceNodeError extends TypeError {
  readonly code = 'FIXTURE_EVIDENCE_NODE_INVALID';

  constructor() {
    super('Fixture evidence node is invalid.');
    this.name = 'FixtureEvidenceNodeError';
  }
}

export type FixtureEvidenceRecordInputV1 = Readonly<{
  sourceDigest: string;
  output: unknown;
  runtimeMetadata: Record<string, unknown>;
}>;

export function createFixtureEvidenceRecord(
  input: FixtureEvidenceRecordInputV1,
): EvidenceNode {
  return createEvidenceNode(
    {
      type: 'fixture-observation',
      nodeSchema: 'jigwright.fixture-evidence-node.v1',
      evaluator: 'jigwright.fixture-evaluator.v1',
      policyDigest: FIXTURE_POLICY_DIGEST,
      exactInputDigests: { source: input.sourceDigest },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'jigwright.fixture-result.v1',
      output: input.output,
      runtimeMetadata: input.runtimeMetadata,
    },
    fixtureInvalid,
  );
}

export function renderFixtureEvidenceRecord(node: EvidenceNode): string {
  return canonicalEvidenceNodeEnvelope(node);
}

export function readFixtureEvidenceRecord(envelope: string): EvidenceNode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    throw fixtureInvalid();
  }
  const node = assertStoredEvidenceNode(parsed, fixtureInvalid);
  if (
    node.type !== 'fixture-observation' ||
    node.nodeSchema !== 'jigwright.fixture-evidence-node.v1' ||
    node.evaluator !== 'jigwright.fixture-evaluator.v1' ||
    node.policyDigest !== FIXTURE_POLICY_DIGEST ||
    node.outputSchema !== 'jigwright.fixture-result.v1' ||
    Object.keys(node.exactInputDigests).length !== 1 ||
    typeof node.exactInputDigests.source !== 'string' ||
    Object.keys(node.semanticParentResultDigests).length !== 0 ||
    Object.keys(node.provenanceParentNodeIds).length !== 0 ||
    envelope !== canonicalEvidenceNodeEnvelope(node)
  ) {
    throw fixtureInvalid();
  }
  return node;
}

function fixtureInvalid(): FixtureEvidenceNodeError {
  return new FixtureEvidenceNodeError();
}
