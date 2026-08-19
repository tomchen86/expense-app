import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  canonicalEvidenceNodeEnvelope,
  createEvidenceNode,
  type EvidenceNodeInput,
} from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import {
  compareAndSwapEvidenceRef,
  readEvidenceNode,
  readEvidenceRefs,
  writeEvidenceNode,
} from '../src/runtime/storage-journal/evidence-object-store.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';

const DIGESTS = {
  policy: '1'.repeat(64),
  tree: '2'.repeat(64),
  term: '3'.repeat(64),
  parentResult: '4'.repeat(64),
  parentNode: '5'.repeat(64),
  changedTree: '6'.repeat(64),
  changedParentNode: '7'.repeat(64),
} as const;

const BASE_INPUT: EvidenceNodeInput = {
  type: 'scan',
  nodeSchema: 'expense-app.workflow.evidence-node.v1',
  evaluator: 'literal-scanner.v1',
  policyDigest: DIGESTS.policy,
  exactInputDigests: {
    term: DIGESTS.term,
    tree: DIGESTS.tree,
  },
  semanticParentResultDigests: {
    intent: DIGESTS.parentResult,
  },
  provenanceParentNodeIds: {
    intent: DIGESTS.parentNode,
  },
  outputSchema: 'expense-app.workflow.scan-result.v1',
  output: {
    hits: [],
    scannedBlobCount: 3,
  },
  runtimeMetadata: {
    createdAt: '2026-07-23T00:00:00.000Z',
    latencyMs: 12,
    processId: 100,
    retryCount: 0,
  },
};

test('canonical JSON recursively sorts object keys and rejects non-JSON values', () => {
  assert.equal(
    canonicalJson({
      z: 1,
      m: [3, { z: 2, a: 1 }],
      a: { b: 2, a: 1 },
    }),
    '{"a":{"a":1,"b":2},"m":[3,{"a":1,"z":2}],"z":1}',
  );
  assert.throws(
    () => canonicalJson({ missing: undefined } as never),
    (error) => isWorkflowError(error, 'CANONICAL_JSON_INVALID'),
  );
  assert.throws(
    () => canonicalJson({ infinite: Number.POSITIVE_INFINITY }),
    (error) => isWorkflowError(error, 'CANONICAL_JSON_INVALID'),
  );
  assert.throws(
    () => canonicalJson(new Date('2026-07-23T00:00:00.000Z')),
    (error) => isWorkflowError(error, 'CANONICAL_JSON_INVALID'),
  );
  assert.throws(
    () => canonicalJson(new Array(1)),
    (error) => isWorkflowError(error, 'CANONICAL_JSON_INVALID'),
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalJson(cyclic),
    (error) => isWorkflowError(error, 'CANONICAL_JSON_INVALID'),
  );
});

test('evidence identity excludes runtime metadata and property insertion order', () => {
  const first = createEvidenceNode(BASE_INPUT);
  const second = createEvidenceNode({
    ...BASE_INPUT,
    exactInputDigests: {
      tree: DIGESTS.tree,
      term: DIGESTS.term,
    },
    output: {
      scannedBlobCount: 3,
      hits: [],
    },
    runtimeMetadata: {
      createdAt: '2026-07-23T01:00:00.000Z',
      latencyMs: 900,
      processId: 999,
      retryCount: 2,
    },
  });

  assert.equal(first.nodeId, second.nodeId);
  assert.equal(first.resultDigest, second.resultDigest);
  assert.notEqual(
    canonicalEvidenceNodeEnvelope(first),
    canonicalEvidenceNodeEnvelope(second),
    'runtime metadata remains observable in the immutable envelope',
  );
});

test('evidence nodeId binds exact inputs and provenance while resultDigest binds semantic output', () => {
  const original = createEvidenceNode(BASE_INPUT);
  const changedInput = createEvidenceNode({
    ...BASE_INPUT,
    exactInputDigests: {
      ...BASE_INPUT.exactInputDigests,
      tree: DIGESTS.changedTree,
    },
  });
  const changedProvenance = createEvidenceNode({
    ...BASE_INPUT,
    provenanceParentNodeIds: {
      intent: DIGESTS.changedParentNode,
    },
  });
  const changedOutput = createEvidenceNode({
    ...BASE_INPUT,
    output: {
      hits: [{ byteOffset: 1, path: 'src/example.ts' }],
      scannedBlobCount: 3,
    },
  });

  assert.notEqual(changedInput.nodeId, original.nodeId);
  assert.equal(changedInput.resultDigest, original.resultDigest);
  assert.notEqual(changedProvenance.nodeId, original.nodeId);
  assert.equal(changedProvenance.resultDigest, original.resultDigest);
  assert.equal(changedOutput.nodeId, original.nodeId);
  assert.notEqual(changedOutput.resultDigest, original.resultDigest);
});

test('evidence creation validates digest inputs and snapshots canonical data', () => {
  assert.throws(
    () =>
      createEvidenceNode({
        ...BASE_INPUT,
        policyDigest: 'not-a-digest',
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_NODE_INVALID'),
  );
  assert.throws(
    () =>
      createEvidenceNode({
        ...BASE_INPUT,
        exactInputDigests: { '': DIGESTS.tree },
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_NODE_INVALID'),
  );

  const mutableInput: EvidenceNodeInput = structuredClone(BASE_INPUT);
  const node = createEvidenceNode(mutableInput);
  const before = canonicalEvidenceNodeEnvelope(node);
  mutableInput.exactInputDigests.tree = DIGESTS.changedTree;
  (mutableInput.output as { scannedBlobCount: number }).scannedBlobCount = 99;
  mutableInput.runtimeMetadata.retryCount = 99;
  assert.equal(canonicalEvidenceNodeEnvelope(node), before);
});

test('immutable evidence objects use canonical no-follow content-addressed storage', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const node = createEvidenceNode(BASE_INPUT);

  assert.equal(writeEvidenceNode(paths, node), node.nodeId);
  assert.deepEqual(readEvidenceNode(paths, node.nodeId), node);

  const objectPath = path.join(
    paths.objects,
    node.nodeId.slice(0, 2),
    `${node.nodeId}.json`,
  );
  assert.equal(
    fs.readFileSync(objectPath, 'utf8'),
    canonicalEvidenceNodeEnvelope(node),
  );
  assert.equal(fs.statSync(objectPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.objects).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(objectPath)).mode & 0o777, 0o700);

  const metadataVariant = createEvidenceNode({
    ...BASE_INPUT,
    runtimeMetadata: { createdAt: '2026-07-23T02:00:00.000Z' },
  });
  assert.equal(metadataVariant.nodeId, node.nodeId);
  assert.throws(
    () => writeEvidenceNode(paths, metadataVariant),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_COLLISION'),
  );
  assert.deepEqual(readEvidenceNode(paths, node.nodeId), node);
});

test('evidence object writes and reads validate the complete canonical envelope', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const node = createEvidenceNode(BASE_INPUT);
  const forged = { ...node, nodeId: 'f'.repeat(64) };
  assert.throws(
    () => writeEvidenceNode(paths, forged),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_INVALID'),
  );

  writeEvidenceNode(paths, node);
  const objectPath = path.join(
    paths.objects,
    node.nodeId.slice(0, 2),
    `${node.nodeId}.json`,
  );
  fs.writeFileSync(
    objectPath,
    JSON.stringify({ ...node, resultDigest: 'e'.repeat(64) }),
    'utf8',
  );
  assert.throws(
    () => readEvidenceNode(paths, node.nodeId),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_INVALID'),
  );
});

test('evidence object and ref reads refuse symbolic-link targets', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const node = createEvidenceNode(BASE_INPUT);
  const prefixDirectory = path.join(paths.objects, node.nodeId.slice(0, 2));
  fs.mkdirSync(prefixDirectory, { recursive: true, mode: 0o700 });
  const external = path.join(gitCommonDirectory, 'external.json');
  fs.writeFileSync(external, canonicalEvidenceNodeEnvelope(node), {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.symlinkSync(external, path.join(prefixDirectory, `${node.nodeId}.json`));

  assert.throws(
    () => readEvidenceNode(paths, node.nodeId),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_UNSAFE'),
  );

  const secondRoot = temporaryDirectory(t);
  const secondPaths = investigationRuntimePaths(secondRoot, 'workflow-engine');
  writeEvidenceNode(secondPaths, node);
  compareAndSwapEvidenceRef(secondPaths, {
    changeId: 'sample-change',
    refName: 'scan/current',
    expectedNodeId: null,
    nextNodeId: node.nodeId,
  });
  const refPath = path.join(secondPaths.refs, 'sample-change.json');
  const externalRef = path.join(secondRoot, 'external-ref.json');
  fs.renameSync(refPath, externalRef);
  fs.symlinkSync(externalRef, refPath);

  assert.throws(
    () => readEvidenceRefs(secondPaths, 'sample-change'),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_UNSAFE'),
  );
});

test('evidence stores reject symlink ancestors instead of creating through them', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const runtimeRoot = path.join(gitCommonDirectory, 'workflow-engine');
  const external = temporaryDirectory(t);
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  fs.symlinkSync(external, path.join(runtimeRoot, 'investigations'));
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );

  assert.throws(
    () => writeEvidenceNode(paths, createEvidenceNode(BASE_INPUT)),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_UNSAFE'),
  );
  assert.deepEqual(fs.readdirSync(external), []);
});

test('evidence reads revalidate ancestor chains and restrictive file modes', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const node = createEvidenceNode(BASE_INPUT);
  writeEvidenceNode(paths, node);
  compareAndSwapEvidenceRef(paths, {
    changeId: 'sample-change',
    refName: 'scan/current',
    expectedNodeId: null,
    nextNodeId: node.nodeId,
  });

  const objectPath = path.join(
    paths.objects,
    node.nodeId.slice(0, 2),
    `${node.nodeId}.json`,
  );
  fs.chmodSync(objectPath, 0o644);
  assert.throws(
    () => readEvidenceNode(paths, node.nodeId),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_UNSAFE'),
  );
  fs.chmodSync(objectPath, 0o600);

  const refPath = path.join(paths.refs, 'sample-change.json');
  fs.chmodSync(refPath, 0o644);
  assert.throws(
    () => readEvidenceRefs(paths, 'sample-change'),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_UNSAFE'),
  );
  fs.chmodSync(refPath, 0o600);

  const movedRoot = path.join(gitCommonDirectory, 'moved-investigations');
  fs.renameSync(paths.root, movedRoot);
  fs.symlinkSync(movedRoot, paths.root);
  assert.throws(
    () => readEvidenceNode(paths, node.nodeId),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_UNSAFE'),
  );
  assert.throws(
    () => readEvidenceRefs(paths, 'sample-change'),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_UNSAFE'),
  );
});

test('evidence stores reject pre-existing permissive private directories', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o755 });
  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o755);

  assert.throws(
    () => writeEvidenceNode(paths, createEvidenceNode(BASE_INPUT)),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_UNSAFE'),
  );
});

test('current evidence refs advance only through compare-and-swap to stored objects', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const first = createEvidenceNode(BASE_INPUT);
  const second = createEvidenceNode({
    ...BASE_INPUT,
    exactInputDigests: {
      ...BASE_INPUT.exactInputDigests,
      tree: DIGESTS.changedTree,
    },
  });
  writeEvidenceNode(paths, first);
  writeEvidenceNode(paths, second);

  compareAndSwapEvidenceRef(paths, {
    changeId: 'sample-change',
    refName: 'scan/current',
    expectedNodeId: null,
    nextNodeId: first.nodeId,
  });
  assert.deepEqual(readEvidenceRefs(paths, 'sample-change'), {
    'scan/current': first.nodeId,
  });

  assert.throws(
    () =>
      compareAndSwapEvidenceRef(paths, {
        changeId: 'sample-change',
        refName: 'scan/current',
        expectedNodeId: null,
        nextNodeId: second.nodeId,
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_CAS_MISMATCH'),
  );
  assert.deepEqual(readEvidenceRefs(paths, 'sample-change'), {
    'scan/current': first.nodeId,
  });

  compareAndSwapEvidenceRef(paths, {
    changeId: 'sample-change',
    refName: 'scan/current',
    expectedNodeId: first.nodeId,
    nextNodeId: second.nodeId,
  });
  assert.deepEqual(readEvidenceRefs(paths, 'sample-change'), {
    'scan/current': second.nodeId,
  });

  assert.throws(
    () =>
      compareAndSwapEvidenceRef(paths, {
        changeId: 'sample-change',
        refName: 'why/current',
        expectedNodeId: null,
        nextNodeId: 'f'.repeat(64),
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_UNAVAILABLE'),
  );
  assert.deepEqual(readEvidenceRefs(paths, 'sample-change'), {
    'scan/current': second.nodeId,
  });
});

test('evidence refs validate names, canonical state, and lock conflicts', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const node = createEvidenceNode(BASE_INPUT);
  writeEvidenceNode(paths, node);

  assert.throws(
    () => readEvidenceRefs(paths, '../escape'),
    (error) => isWorkflowError(error, 'INVALID_CHANGE_ID'),
  );
  assert.throws(
    () =>
      compareAndSwapEvidenceRef(paths, {
        changeId: 'sample-change',
        refName: '../escape',
        expectedNodeId: null,
        nextNodeId: node.nodeId,
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_NAME_INVALID'),
  );

  fs.mkdirSync(paths.refs, { recursive: true, mode: 0o700 });
  const lockPath = path.join(paths.refs, 'sample-change.lock');
  fs.writeFileSync(lockPath, 'occupied\n', { encoding: 'utf8', mode: 0o600 });
  assert.throws(
    () =>
      compareAndSwapEvidenceRef(paths, {
        changeId: 'sample-change',
        refName: 'scan/current',
        expectedNodeId: null,
        nextNodeId: node.nodeId,
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_LOCKED'),
  );
  assert.deepEqual(readEvidenceRefs(paths, 'sample-change'), {});
  fs.unlinkSync(lockPath);

  compareAndSwapEvidenceRef(paths, {
    changeId: 'sample-change',
    refName: 'scan/current',
    expectedNodeId: null,
    nextNodeId: node.nodeId,
  });
  const refPath = path.join(paths.refs, 'sample-change.json');
  fs.writeFileSync(
    refPath,
    JSON.stringify({
      schemaVersion: 1,
      changeId: 'different-change',
      refs: { 'scan/current': node.nodeId },
    }),
    'utf8',
  );
  assert.throws(
    () => readEvidenceRefs(paths, 'sample-change'),
    (error) => isWorkflowError(error, 'EVIDENCE_REF_INVALID'),
  );
});

test('compare-and-swap validates the complete next object before advancing', (t) => {
  const gitCommonDirectory = temporaryDirectory(t);
  const paths = investigationRuntimePaths(
    gitCommonDirectory,
    'workflow-engine',
  );
  const node = createEvidenceNode(BASE_INPUT);
  writeEvidenceNode(paths, node);
  const objectPath = path.join(
    paths.objects,
    node.nodeId.slice(0, 2),
    `${node.nodeId}.json`,
  );
  fs.writeFileSync(
    objectPath,
    JSON.stringify({ ...node, resultDigest: 'e'.repeat(64) }),
    'utf8',
  );

  assert.throws(
    () =>
      compareAndSwapEvidenceRef(paths, {
        changeId: 'sample-change',
        refName: 'scan/current',
        expectedNodeId: null,
        nextNodeId: node.nodeId,
      }),
    (error) => isWorkflowError(error, 'EVIDENCE_OBJECT_INVALID'),
  );
  assert.deepEqual(readEvidenceRefs(paths, 'sample-change'), {});
});

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-evidence-node-'),
  );
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
