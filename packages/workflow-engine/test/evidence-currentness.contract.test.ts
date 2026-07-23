import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  createConvergenceRecord,
  createDescendantReuseProof,
} from '../src/evidence-convergence.ts';
import { evaluateEvidenceCurrentness } from '../src/evidence-currentness.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
  type EvidenceNodeInput,
} from '../src/evidence-node.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  evaluatePlanningAssurance,
  type PlanningAssuranceValidator,
} from '../src/planning-assurance-validator.ts';

const DIGESTS = {
  policy: '1'.repeat(64),
  sourceA: '2'.repeat(64),
  sourceB: '3'.repeat(64),
  sourceC: '4'.repeat(64),
  requirement: '5'.repeat(64),
} as const;

const VALIDATOR_VERSION = 'evidence-currentness.v1';

test('currentness invalidates only the node whose exact input changed', () => {
  const first = evidenceNode('scan-a', DIGESTS.sourceA, { hits: [] });
  const second = evidenceNode('scan-b', DIGESTS.sourceB, { hits: [] });

  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: first,
      expectedIdentity: evidenceIdentity(first),
      expectedExactInputDigests: { source: DIGESTS.sourceC },
      previousParents: {},
      currentParents: {},
      convergenceRecords: [],
      reuseProofs: [],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['exact-input:source'],
    },
  );
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: second,
      expectedIdentity: evidenceIdentity(second),
      expectedExactInputDigests: { source: DIGESTS.sourceB },
      previousParents: {},
      currentParents: {},
      convergenceRecords: [],
      reuseProofs: [],
      validatorVersion: VALIDATOR_VERSION,
    }),
    { current: true, reusedParentRoles: [], staleReasons: [] },
  );
});

test('currentness rejects obsolete evaluator, policy, and schema identities', () => {
  const node = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const mismatches = [
    ['type', 'other-scan'],
    ['evaluator', 'other-evaluator.v1'],
    ['policyDigest', 'f'.repeat(64)],
    ['nodeSchema', 'expense-app.workflow.other-node.v1'],
    ['outputSchema', 'expense-app.workflow.other-output.v1'],
  ] as const;

  for (const [field, value] of mismatches) {
    assert.deepEqual(
      evaluateEvidenceCurrentness({
        node,
        expectedIdentity: {
          ...evidenceIdentity(node),
          [field]: value,
        },
        expectedExactInputDigests: { source: DIGESTS.sourceA },
        previousParents: {},
        currentParents: {},
        convergenceRecords: [],
        reuseProofs: [],
        validatorVersion: VALIDATOR_VERSION,
      }),
      {
        current: false,
        reusedParentRoles: [],
        staleReasons: [`identity:${field}`],
      },
    );
  }
});

test('compatible equal-output parents require an explicit convergence record', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const newParent = evidenceNode('scan', DIGESTS.sourceB, { hits: [] });
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: oldParent },
  );

  assert.notEqual(newParent.nodeId, oldParent.nodeId);
  assert.equal(newParent.resultDigest, oldParent.resultDigest);
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { scan: oldParent },
      currentParents: { scan: newParent },
      convergenceRecords: [],
      reuseProofs: [],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['convergence:scan'],
    },
  );

  const convergence = createConvergenceRecord({
    oldParent,
    newParent,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: { createdAt: '2026-07-23T00:00:00.000Z' },
  });
  assert.equal(
    (convergence.output as { sharedResultDigest: string }).sharedResultDigest,
    oldParent.resultDigest,
  );
});

test('currentness fails closed on missing, unexpected, or incoherent parents', () => {
  const parent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: parent },
  );
  const baseInput = {
    expectedIdentity: evidenceIdentity(descendant),
    expectedExactInputDigests: { source: DIGESTS.requirement },
    previousParents: { scan: parent },
    convergenceRecords: [],
    reuseProofs: [],
    validatorVersion: VALIDATOR_VERSION,
  };

  assert.deepEqual(
    evaluateEvidenceCurrentness({
      ...baseInput,
      node: descendant,
      currentParents: {},
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['parent-missing:scan'],
    },
  );
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      ...baseInput,
      node: descendant,
      previousParents: {},
      currentParents: { scan: parent },
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['parent-prior-missing:scan'],
    },
  );
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      ...baseInput,
      node: descendant,
      currentParents: { scan: parent, unexpected: parent },
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['parent-unexpected:unexpected'],
    },
  );
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      ...baseInput,
      node: descendant,
      previousParents: { scan: parent, unexpected: parent },
      currentParents: { scan: parent },
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['parent-prior-unexpected:unexpected'],
    },
  );

  const mismatchedRoles = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: parent },
    {
      semanticParentResultDigests: {
        other: parent.resultDigest,
      },
    },
  );
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      ...baseInput,
      node: mismatchedRoles,
      currentParents: { scan: parent },
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['parent-declaration:other', 'parent-declaration:scan'],
    },
  );
});

test('currentness verifies the semantic result on an unchanged parent edge', () => {
  const parent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: parent },
    {
      semanticParentResultDigests: {
        scan: DIGESTS.sourceC,
      },
    },
  );

  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { scan: parent },
      currentParents: { scan: parent },
      convergenceRecords: [],
      reuseProofs: [],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['parent-result:scan'],
    },
  );
});

test('convergence rejects incompatible evaluator, policy, and schema identities', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  for (const override of [
    { evaluator: 'other-evaluator.v1' },
    { policyDigest: 'f'.repeat(64) },
    { nodeSchema: 'expense-app.workflow.other-node.v1' },
    { outputSchema: 'expense-app.workflow.other-output.v1' },
  ]) {
    const newParent = evidenceNode(
      'scan',
      DIGESTS.sourceB,
      { hits: [] },
      {},
      override,
    );
    assert.throws(
      () =>
        createConvergenceRecord({
          oldParent,
          newParent,
          validatorVersion: VALIDATOR_VERSION,
          runtimeMetadata: {},
        }),
      (error) => isWorkflowError(error, 'EVIDENCE_CONVERGENCE_INCOMPATIBLE'),
    );
  }
});

test('descendant reuse rejects a parent result the descendant never consumed', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const newParent = evidenceNode('scan', DIGESTS.sourceB, { hits: [] });
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: oldParent },
    {
      semanticParentResultDigests: {
        scan: DIGESTS.sourceC,
      },
    },
  );

  assert.throws(
    () =>
      createDescendantReuseProof({
        descendant,
        parentRole: 'scan',
        oldParent,
        newParent,
        convergenceRecord: convergence(oldParent, newParent),
        validatorVersion: VALIDATOR_VERSION,
        runtimeMetadata: {},
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_REUSE_PROOF_INVALID'),
  );
});

test('multi-parent descendant reuse requires one valid proof for every changed edge', () => {
  const oldAlpha = evidenceNode('scan-alpha', DIGESTS.sourceA, { hits: [] });
  const newAlpha = evidenceNode('scan-alpha', DIGESTS.sourceB, { hits: [] });
  const oldBeta = evidenceNode('scan-beta', DIGESTS.sourceA, { hits: [] });
  const newBeta = evidenceNode('scan-beta', DIGESTS.sourceC, { hits: [] });
  const descendant = evidenceNode(
    'why',
    DIGESTS.requirement,
    { why: 'The invariant remains stable.' },
    { alpha: oldAlpha, beta: oldBeta },
  );
  const originalNodeId = descendant.nodeId;
  const originalParents = structuredClone(descendant.provenanceParentNodeIds);
  const alphaConvergence = convergence(oldAlpha, newAlpha);
  const betaConvergence = convergence(oldBeta, newBeta);
  const alphaProof = createDescendantReuseProof({
    descendant,
    parentRole: 'alpha',
    oldParent: oldAlpha,
    newParent: newAlpha,
    convergenceRecord: alphaConvergence,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: {},
  });

  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { alpha: oldAlpha, beta: oldBeta },
      currentParents: { alpha: newAlpha, beta: newBeta },
      convergenceRecords: [alphaConvergence, betaConvergence],
      reuseProofs: [alphaProof],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: false,
      reusedParentRoles: ['alpha'],
      staleReasons: ['reuse-proof:beta'],
    },
  );

  const betaProof = createDescendantReuseProof({
    descendant,
    parentRole: 'beta',
    oldParent: oldBeta,
    newParent: newBeta,
    convergenceRecord: betaConvergence,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: {},
  });
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { alpha: oldAlpha, beta: oldBeta },
      currentParents: { alpha: newAlpha, beta: newBeta },
      convergenceRecords: [alphaConvergence, betaConvergence],
      reuseProofs: [betaProof, alphaProof],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: true,
      reusedParentRoles: ['alpha', 'beta'],
      staleReasons: [],
    },
  );
  assert.equal(descendant.nodeId, originalNodeId);
  assert.deepEqual(descendant.provenanceParentNodeIds, originalParents);
});

test('reuse proof identity binds the descendant parent role', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const newParent = evidenceNode('scan', DIGESTS.sourceB, { hits: [] });
  const descendant = evidenceNode(
    'why',
    DIGESTS.requirement,
    { why: 'Both roles consume the same stable result.' },
    { alpha: oldParent, beta: oldParent },
  );
  const record = convergence(oldParent, newParent);
  const alphaProof = createDescendantReuseProof({
    descendant,
    parentRole: 'alpha',
    oldParent,
    newParent,
    convergenceRecord: record,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: {},
  });
  const betaProof = createDescendantReuseProof({
    descendant,
    parentRole: 'beta',
    oldParent,
    newParent,
    convergenceRecord: record,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: {},
  });

  assert.notEqual(alphaProof.nodeId, betaProof.nodeId);
  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { alpha: oldParent, beta: oldParent },
      currentParents: { alpha: newParent, beta: newParent },
      convergenceRecords: [record],
      reuseProofs: [alphaProof, betaProof],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: true,
      reusedParentRoles: ['alpha', 'beta'],
      staleReasons: [],
    },
  );
});

test('convergence and reuse readers reject internally inconsistent records', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const newParent = evidenceNode('scan', DIGESTS.sourceB, { hits: [] });
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: oldParent },
  );

  for (const malformedConvergence of [
    convergenceEnvelope(oldParent, newParent, {
      outputSchema: 'expense-app.workflow.wrong-convergence-output.v1',
    }),
    convergenceEnvelope(oldParent, newParent, {
      output: {
        ...convergenceOutput(oldParent),
        validatorVersion: 'different-validator.v1',
      },
    }),
    convergenceEnvelope(oldParent, newParent, {
      output: {
        ...convergenceOutput(oldParent),
        sharedEvaluator: 'forged-evaluator.v1',
      },
    }),
    convergenceEnvelope(oldParent, newParent, {
      policyDigest: 'f'.repeat(64),
      output: {
        ...convergenceOutput(oldParent),
        sharedPolicyDigest: 'f'.repeat(64),
      },
    }),
  ]) {
    assert.throws(
      () =>
        createDescendantReuseProof({
          descendant,
          parentRole: 'scan',
          oldParent,
          newParent,
          convergenceRecord: malformedConvergence,
          validatorVersion: VALIDATOR_VERSION,
          runtimeMetadata: {},
        }),
      (error) => isWorkflowError(error, 'EVIDENCE_REUSE_PROOF_INVALID'),
    );
  }

  const validConvergence = convergence(oldParent, newParent);
  for (const malformedProof of [
    reuseProofEnvelope(descendant, oldParent, newParent, validConvergence, {
      outputSchema: 'expense-app.workflow.wrong-reuse-proof-output.v1',
    }),
    reuseProofEnvelope(descendant, oldParent, newParent, validConvergence, {
      output: {
        parentRole: 'scan',
        sharedResultDigest: oldParent.resultDigest,
        validatorVersion: 'different-validator.v1',
      },
    }),
    reuseProofEnvelope(descendant, oldParent, newParent, validConvergence, {
      policyDigest: 'f'.repeat(64),
    }),
    reuseProofEnvelope(descendant, oldParent, newParent, validConvergence, {
      semanticParentResultDigests: {
        shared: DIGESTS.sourceC,
      },
      output: {
        parentRole: 'scan',
        sharedResultDigest: DIGESTS.sourceC,
        validatorVersion: VALIDATOR_VERSION,
      },
    }),
  ]) {
    assert.deepEqual(
      evaluateEvidenceCurrentness({
        node: descendant,
        expectedIdentity: evidenceIdentity(descendant),
        expectedExactInputDigests: { source: DIGESTS.requirement },
        previousParents: { scan: oldParent },
        currentParents: { scan: newParent },
        convergenceRecords: [validConvergence],
        reuseProofs: [malformedProof],
        validatorVersion: VALIDATOR_VERSION,
      }),
      {
        current: false,
        reusedParentRoles: [],
        staleReasons: ['reuse-proof:scan'],
      },
    );
  }
});

test('currentness independently rejects forged cross-version convergence', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const incompatibleParent = evidenceNode(
    'scan',
    DIGESTS.sourceB,
    { hits: [] },
    {},
    {
      evaluator: 'different-evaluator.v1',
    },
  );
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: oldParent },
  );
  const forgedConvergence = convergenceEnvelope(
    oldParent,
    incompatibleParent,
    {},
  );
  assert.throws(
    () =>
      createDescendantReuseProof({
        descendant,
        parentRole: 'scan',
        oldParent,
        newParent: incompatibleParent,
        convergenceRecord: forgedConvergence,
        validatorVersion: VALIDATOR_VERSION,
        runtimeMetadata: {},
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_REUSE_PROOF_INVALID'),
  );
  const forgedProof = reuseProofEnvelope(
    descendant,
    oldParent,
    incompatibleParent,
    forgedConvergence,
    {},
  );

  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { scan: oldParent },
      currentParents: { scan: incompatibleParent },
      convergenceRecords: [forgedConvergence],
      reuseProofs: [forgedProof],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['convergence:scan'],
    },
  );
});

test('ambiguous or mismatched descendant proofs remain stale', () => {
  const oldParent = evidenceNode('scan', DIGESTS.sourceA, { hits: [] });
  const newParent = evidenceNode('scan', DIGESTS.sourceB, { hits: [] });
  const descendant = evidenceNode(
    'group',
    DIGESTS.requirement,
    { groups: [] },
    { scan: oldParent },
  );
  const record = convergence(oldParent, newParent);
  const proof = createDescendantReuseProof({
    descendant,
    parentRole: 'scan',
    oldParent,
    newParent,
    convergenceRecord: record,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: { attempt: 1 },
  });
  const duplicate = createDescendantReuseProof({
    descendant,
    parentRole: 'scan',
    oldParent,
    newParent,
    convergenceRecord: record,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: { attempt: 2 },
  });

  assert.deepEqual(
    evaluateEvidenceCurrentness({
      node: descendant,
      expectedIdentity: evidenceIdentity(descendant),
      expectedExactInputDigests: { source: DIGESTS.requirement },
      previousParents: { scan: oldParent },
      currentParents: { scan: newParent },
      convergenceRecords: [record],
      reuseProofs: [proof, duplicate],
      validatorVersion: VALIDATOR_VERSION,
    }),
    {
      current: false,
      reusedParentRoles: [],
      staleReasons: ['reuse-proof-ambiguous:scan'],
    },
  );
});

test('live and CI loaders share one canonical content-pure planning validator', () => {
  const liveNode = evidenceNode(
    'scan',
    DIGESTS.sourceA,
    { hits: [] },
    {},
    {
      runtimeMetadata: {
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    },
  );
  const ciNode = evidenceNode(
    'scan',
    DIGESTS.sourceA,
    { hits: [] },
    {},
    {
      runtimeMetadata: {
        retryCount: 2,
      },
    },
  );
  assert.equal(ciNode.nodeId, liveNode.nodeId);
  assert.equal(ciNode.resultDigest, liveNode.resultDigest);

  const validator: PlanningAssuranceValidator = {
    version: 'planning-assurance.v1',
    evaluate(input) {
      return {
        accepted:
          (input.subject as { changeId?: string }).changeId ===
            'sample-change' &&
          (input.policy as { required?: boolean }).required === true,
        artifactNames: Object.keys(input.artifacts).sort(),
        subjectKeys: Object.keys(input.subject as Record<string, unknown>),
        artifactRuntimeMetadata: input.artifacts.scan?.runtimeMetadata,
      };
    },
  };
  const loadLive = () => ({
    subject: { tree: DIGESTS.sourceA, changeId: 'sample-change' },
    policy: { version: 1, required: true },
    artifacts: { scan: liveNode },
  });
  const loadCi = () => ({
    subject: { changeId: 'sample-change', tree: DIGESTS.sourceA },
    policy: { required: true, version: 1 },
    artifacts: { scan: ciNode },
  });

  const live = evaluatePlanningAssurance(loadLive(), validator);
  const ci = evaluatePlanningAssurance(loadCi(), validator);
  assert.deepEqual(ci, live);
  assert.deepEqual(live.result, {
    accepted: true,
    artifactNames: ['scan'],
    subjectKeys: ['changeId', 'tree'],
    artifactRuntimeMetadata: {},
  });
  assert.match(live.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(live.resultDigest, /^[0-9a-f]{64}$/);
  assert.equal(live.validatorVersion, 'planning-assurance.v1');
});

test('planning validators receive a deeply frozen canonical snapshot', () => {
  const source = {
    subject: {
      changeId: 'sample-change',
      nested: { value: 1 },
    },
    policy: { required: true },
    artifacts: {
      scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
    },
  };
  const result = evaluatePlanningAssurance(source, {
    version: 'planning-assurance.v1',
    evaluate(input) {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.subject), true);
      assert.equal(
        Object.isFrozen(
          (input.subject as { nested: Record<string, unknown> }).nested,
        ),
        true,
      );
      assert.equal(Object.isFrozen(input.artifacts), true);
      assert.equal(Object.isFrozen(input.artifacts.scan), true);
      assert.throws(() => {
        (input.subject as { nested: { value: number } }).nested.value = 2;
      }, TypeError);
      return { accepted: true };
    },
  });

  assert.deepEqual(result.result, { accepted: true });
  assert.equal(source.subject.nested.value, 1);
});

test('planning validator results are detached and frozen before digesting', () => {
  const evaluatorResult = {
    accepted: true,
    nested: { count: 1 },
  };
  const result = evaluatePlanningAssurance(
    {
      subject: { changeId: 'sample-change' },
      policy: { required: true },
      artifacts: {
        scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
      },
    },
    {
      version: 'planning-assurance.v1',
      evaluate: () => evaluatorResult,
    },
  );

  evaluatorResult.nested.count = 2;
  assert.deepEqual(result.result, {
    accepted: true,
    nested: { count: 1 },
  });
  assert.equal(Object.isFrozen(result.result), true);
  assert.equal(
    Object.isFrozen((result.result as { nested: object }).nested),
    true,
  );
});

test('planning assurance snapshots validator identity exactly once', () => {
  const input = {
    subject: { changeId: 'sample-change' },
    policy: { required: true },
    artifacts: {
      scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
    },
  };
  let versionReads = 0;
  const changingValidator: PlanningAssuranceValidator = {
    get version() {
      versionReads += 1;
      return versionReads === 1
        ? 'planning-assurance.v1'
        : 'planning-assurance.v2';
    },
    evaluate: () => ({ accepted: true }),
  };
  const changing = evaluatePlanningAssurance(input, changingValidator);
  const stable = evaluatePlanningAssurance(input, {
    version: 'planning-assurance.v1',
    evaluate: () => ({ accepted: true }),
  });

  assert.equal(versionReads, 1);
  assert.deepEqual(changing, stable);
  assert.throws(
    () =>
      evaluatePlanningAssurance(input, {
        version: '',
        evaluate: () => ({ accepted: true }),
      }),
    (error) => isWorkflowError(error, 'PLANNING_ASSURANCE_VALIDATOR_INVALID'),
  );
});

test('planning result identity binds the validator version', () => {
  const input = {
    subject: { changeId: 'sample-change' },
    policy: { required: true },
    artifacts: {
      scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
    },
  };
  const first = evaluatePlanningAssurance(input, {
    version: 'planning-assurance.v1',
    evaluate: () => ({ accepted: true }),
  });
  const second = evaluatePlanningAssurance(input, {
    version: 'planning-assurance.v2',
    evaluate: () => ({ accepted: true }),
  });

  assert.equal(first.validatorVersion, 'planning-assurance.v1');
  assert.equal(second.validatorVersion, 'planning-assurance.v2');
  assert.notEqual(first.inputDigest, second.inputDigest);
  assert.notEqual(first.resultDigest, second.resultDigest);
});

function convergence(oldParent: EvidenceNode, newParent: EvidenceNode) {
  return createConvergenceRecord({
    oldParent,
    newParent,
    validatorVersion: VALIDATOR_VERSION,
    runtimeMetadata: {},
  });
}

function convergenceOutput(parent: EvidenceNode) {
  return {
    sharedResultDigest: parent.resultDigest,
    sharedType: parent.type,
    sharedEvaluator: parent.evaluator,
    sharedPolicyDigest: parent.policyDigest,
    sharedNodeSchema: parent.nodeSchema,
    sharedOutputSchema: parent.outputSchema,
    validatorVersion: VALIDATOR_VERSION,
  };
}

function convergenceEnvelope(
  oldParent: EvidenceNode,
  newParent: EvidenceNode,
  override: Partial<EvidenceNodeInput>,
): EvidenceNode {
  return createEvidenceNode({
    type: 'evidence-convergence',
    nodeSchema: 'expense-app.workflow.evidence-convergence.v1',
    evaluator: VALIDATOR_VERSION,
    policyDigest: oldParent.policyDigest,
    exactInputDigests: {
      oldParentNode: oldParent.nodeId,
      newParentNode: newParent.nodeId,
    },
    semanticParentResultDigests: {
      shared: oldParent.resultDigest,
    },
    provenanceParentNodeIds: {
      oldParent: oldParent.nodeId,
      newParent: newParent.nodeId,
    },
    outputSchema: 'expense-app.workflow.evidence-convergence-output.v1',
    output: convergenceOutput(oldParent),
    runtimeMetadata: {},
    ...override,
  });
}

function reuseProofEnvelope(
  descendant: EvidenceNode,
  oldParent: EvidenceNode,
  newParent: EvidenceNode,
  convergenceRecord: EvidenceNode,
  override: Partial<EvidenceNodeInput>,
): EvidenceNode {
  return createEvidenceNode({
    type: 'evidence-reuse-proof',
    nodeSchema: 'expense-app.workflow.evidence-reuse-proof.v1',
    evaluator: VALIDATOR_VERSION,
    policyDigest: descendant.policyDigest,
    exactInputDigests: {
      descendantNode: descendant.nodeId,
      oldParentNode: oldParent.nodeId,
      newParentNode: newParent.nodeId,
      convergenceNode: convergenceRecord.nodeId,
      parentRole: digestString('scan'),
    },
    semanticParentResultDigests: {
      shared: oldParent.resultDigest,
    },
    provenanceParentNodeIds: {
      descendant: descendant.nodeId,
      oldParent: oldParent.nodeId,
      newParent: newParent.nodeId,
      convergence: convergenceRecord.nodeId,
    },
    outputSchema: 'expense-app.workflow.evidence-reuse-proof-output.v1',
    output: {
      parentRole: 'scan',
      sharedResultDigest: oldParent.resultDigest,
      validatorVersion: VALIDATOR_VERSION,
    },
    runtimeMetadata: {},
    ...override,
  });
}

function evidenceIdentity(node: EvidenceNode) {
  return {
    type: node.type,
    evaluator: node.evaluator,
    policyDigest: node.policyDigest,
    nodeSchema: node.nodeSchema,
    outputSchema: node.outputSchema,
  };
}

function digestString(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function evidenceNode(
  type: string,
  sourceDigest: string,
  output: unknown,
  parents: Record<string, EvidenceNode> = {},
  override: Partial<EvidenceNodeInput> = {},
): EvidenceNode {
  return createEvidenceNode({
    type,
    nodeSchema: 'expense-app.workflow.evidence-node.v1',
    evaluator: 'fixture-evaluator.v1',
    policyDigest: DIGESTS.policy,
    exactInputDigests: { source: sourceDigest },
    semanticParentResultDigests: Object.fromEntries(
      Object.entries(parents).map(([role, parent]) => [
        role,
        parent.resultDigest,
      ]),
    ),
    provenanceParentNodeIds: Object.fromEntries(
      Object.entries(parents).map(([role, parent]) => [role, parent.nodeId]),
    ),
    outputSchema: 'expense-app.workflow.fixture-output.v1',
    output,
    runtimeMetadata: {},
    ...override,
  });
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
